import * as fs from 'node:fs';
import type { RowVersion } from './memtable.js';

/** Deterministic on-disk ordering: by row id, then by commit timestamp ascending within an id. */
function sortForStorage(records: RowVersion[]): RowVersion[] {
  return [...records].sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

/** Pure serialization: newline-delimited JSON, one committed row-version record per line. */
export function serializeSSTable(records: RowVersion[]): string {
  const sorted = sortForStorage(records);
  if (sorted.length === 0) return '';
  return sorted.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/** Pure deserialization, the inverse of `serializeSSTable`. */
export function deserializeSSTable(content: string): RowVersion[] {
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RowVersion);
}

/**
 * Writes an immutable SSTable file. Written to a temp path and `rename`d into place so a reader
 * can never observe a partially-written file — `fs.renameSync` on the same filesystem is atomic,
 * so the file at `path` either doesn't exist yet or is always fully formed.
 */
export function writeSSTableFile(path: string, records: RowVersion[]): void {
  const tmpPath = `${path}.tmp`;
  fs.writeFileSync(tmpPath, serializeSSTable(records));
  fs.renameSync(tmpPath, path);
}

export function readSSTableFile(path: string): RowVersion[] {
  return deserializeSSTable(fs.readFileSync(path, 'utf8'));
}

/**
 * The pure heart of compaction: given every version (potentially spread across many SSTables) of
 * however many row ids, plus `minActiveReadTimestamp` — the oldest `readTimestamp` any currently
 * open transaction's snapshot might still need to resolve reads against (or `Infinity` if no
 * transaction is open) — returns the subset of versions that must survive.
 *
 * The rule: for a given row id, let W be the *newest* version with `createdAt <=
 * minActiveReadTimestamp` (the version any currently-open snapshot would resolve to right now,
 * or an even older one wouldn't be the answer for anyone). Every version strictly older than W
 * is provably dead — no snapshot open right now, and no snapshot created from this point
 * forward (since every future snapshot's `readTimestamp` only ever increases), can ever need it.
 * W itself and everything newer than it must be kept, since a snapshot with `readTimestamp`
 * anywhere in `[W.createdAt, +Inf)` needs exactly one of them.
 *
 * If no version has `createdAt <= minActiveReadTimestamp` (every version for that id postdates
 * every open snapshot), nothing is provably dead yet, so everything is kept.
 *
 * One extra reduction: if W is both the *only* surviving version for an id and a tombstone
 * (`values: null`), it is dropped entirely rather than kept. An id with zero surviving records
 * reads as "does not exist" during a scan — identical in effect to an explicit tombstone — so
 * there is nothing lost by omitting it, and it's one less record for future compactions to carry.
 *
 * This function only ever sees committed versions (SSTables never contain pending/uncommitted
 * writes in the first place), so every `createdAt` here is defined.
 */
export function mergeAndDropDeadVersions(all: RowVersion[], minActiveReadTimestamp: number): RowVersion[] {
  const byId = new Map<string, RowVersion[]>();
  for (const version of all) {
    if (version.createdAt === undefined) continue; // defensive: should never occur for SSTable-sourced records
    const list = byId.get(version.id);
    if (list) list.push(version);
    else byId.set(version.id, [version]);
  }

  const kept: RowVersion[] = [];
  for (const versions of byId.values()) {
    versions.sort((a, b) => a.createdAt! - b.createdAt!);
    let winnerIndex = -1;
    for (let i = 0; i < versions.length; i += 1) {
      if (versions[i]!.createdAt! <= minActiveReadTimestamp) winnerIndex = i;
    }
    const survivors = winnerIndex === -1 ? versions : versions.slice(winnerIndex);
    if (survivors.length === 1 && survivors[0]!.values === null) continue; // sole surviving version is a dead tombstone
    kept.push(...survivors);
  }
  return kept;
}
