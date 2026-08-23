import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RowVersion } from '../memtable.js';
import { deserializeSSTable, mergeAndDropDeadVersions, readSSTableFile, serializeSSTable, writeSSTableFile } from '../sstable.js';

function v(id: string, values: RowVersion['values'], createdAt: number, createdTxn = 1): RowVersion {
  return { id, values, createdAt, createdTxn };
}

describe('serializeSSTable / deserializeSSTable (pure round trip)', () => {
  it('round-trips an empty record set as an empty string', () => {
    expect(serializeSSTable([])).toBe('');
    expect(deserializeSSTable('')).toEqual([]);
  });

  it('round-trips records, sorted by id then createdAt', () => {
    const records = [v('2', ['b'], 5), v('1', ['old'], 1), v('1', ['new'], 2)];
    const serialized = serializeSSTable(records);
    const roundTripped = deserializeSSTable(serialized);
    expect(roundTripped).toEqual([v('1', ['old'], 1), v('1', ['new'], 2), v('2', ['b'], 5)]);
  });

  it('round-trips a tombstone (values: null)', () => {
    const records = [v('1', null, 3)];
    expect(deserializeSSTable(serializeSSTable(records))).toEqual(records);
  });

  it('preserves SqlValue variety: number, string, boolean, null field values', () => {
    const records = [v('1', [1, 'x', true, null], 1)];
    expect(deserializeSSTable(serializeSSTable(records))).toEqual(records);
  });
});

describe('writeSSTableFile / readSSTableFile (file I/O)', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(os.tmpdir(), `titanforge-sstable-${randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads back the same records', () => {
    const p = path.join(dir, '000001.sst');
    const records = [v('1', ['a'], 1), v('2', ['b'], 2)];
    writeSSTableFile(p, records);
    expect(readSSTableFile(p)).toEqual(records);
  });

  it('never leaves a .tmp file behind after a successful write', () => {
    const p = path.join(dir, '000001.sst');
    writeSSTableFile(p, [v('1', ['a'], 1)]);
    expect(fs.existsSync(`${p}.tmp`)).toBe(false);
    expect(fs.existsSync(p)).toBe(true);
  });
});

describe('mergeAndDropDeadVersions (pure compaction logic)', () => {
  it('with no active transactions, keeps only the newest version per id', () => {
    const all = [v('1', ['old'], 1), v('1', ['mid'], 2), v('1', ['new'], 3)];
    const kept = mergeAndDropDeadVersions(all, Infinity);
    expect(kept).toEqual([v('1', ['new'], 3)]);
  });

  it('drops an id entirely if its newest version is a tombstone and nothing is newer', () => {
    const all = [v('1', ['old'], 1), v('1', null, 2)];
    const kept = mergeAndDropDeadVersions(all, Infinity);
    expect(kept).toEqual([]);
  });

  it('keeps a lone insert (no older versions to drop, nothing to compact away)', () => {
    const all = [v('1', ['only'], 1)];
    expect(mergeAndDropDeadVersions(all, Infinity)).toEqual(all);
  });

  it('respects minActiveReadTimestamp: keeps the version an open snapshot still needs, drops only what is strictly older', () => {
    // A transaction's snapshot is at readTimestamp=2 — it must still resolve to the version
    // committed at ts=2, so ts=1 is droppable but ts=2 and ts=3 must both survive.
    const all = [v('1', ['t1'], 1), v('1', ['t2'], 2), v('1', ['t3'], 3)];
    const kept = mergeAndDropDeadVersions(all, 2);
    expect(kept).toEqual([v('1', ['t2'], 2), v('1', ['t3'], 3)]);
  });

  it('keeps everything for an id if no version is old enough to predate minActiveReadTimestamp', () => {
    const all = [v('1', ['a'], 5), v('1', ['b'], 6)];
    const kept = mergeAndDropDeadVersions(all, 1); // both versions postdate the oldest active snapshot
    expect(kept).toEqual(all);
  });

  it('a sole surviving tombstone is dropped even when an open snapshot is exactly at its commit timestamp, because "no record for this id" reads identically to "tombstoned" during a scan', () => {
    const all = [v('1', ['alive'], 1), v('1', null, 2)]; // deleted at ts=2
    const kept = mergeAndDropDeadVersions(all, 2);
    expect(kept).toEqual([]);
  });

  it('a tombstone is kept when something newer than it also survives for the same id (it is not the sole survivor)', () => {
    const all = [v('1', ['alive'], 1), v('1', null, 2), v('1', ['reinserted'], 3)];
    // minActive pins the winner at ts=2 (the tombstone); ts=3 also survives as "newer than the winner".
    const kept = mergeAndDropDeadVersions(all, 2);
    expect(kept).toEqual([v('1', null, 2), v('1', ['reinserted'], 3)]);
  });

  it('handles multiple independent row ids correctly, each on its own merits', () => {
    const all = [
      v('1', ['old1'], 1),
      v('1', ['new1'], 3),
      v('2', ['only2'], 2),
    ];
    const kept = mergeAndDropDeadVersions(all, Infinity);
    expect(kept).toContainEqual(v('1', ['new1'], 3));
    expect(kept).toContainEqual(v('2', ['only2'], 2));
    expect(kept).toHaveLength(2);
  });

  it('is idempotent: compacting an already-compacted set changes nothing further', () => {
    const all = [v('1', ['old'], 1), v('1', ['new'], 3)];
    const once = mergeAndDropDeadVersions(all, Infinity);
    const twice = mergeAndDropDeadVersions(once, Infinity);
    expect(twice).toEqual(once);
  });

  it('returns an empty array for an empty input', () => {
    expect(mergeAndDropDeadVersions([], Infinity)).toEqual([]);
  });
});
