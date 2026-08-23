import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RowId, Snapshot, SqlValue, StoredRow, TableStorage, TransactionId } from '@titanforge/storage-api';
import { Memtable, type RowVersion } from './memtable.js';
import { mergeAndDropDeadVersions, readSSTableFile, writeSSTableFile } from './sstable.js';
import type { Wal } from './wal.js';

export interface LsmTableDeps {
  wal: Wal;
  tableName: string;
  /** The oldest `readTimestamp` any currently-open transaction might still need — `Infinity` if none are open. See `sstable.ts`'s `mergeAndDropDeadVersions`. */
  minActiveReadTimestamp(): number;
}

export interface CompactionStats {
  inputRecordCount: number;
  outputRecordCount: number;
  sstableCountBefore: number;
  sstableCountAfter: number;
}

/**
 * A `TableStorage` backed by a WAL (via `deps.wal`, shared with the rest of the engine), one
 * `Memtable`, and zero or more immutable on-disk SSTable files. The "current set of SSTables" is
 * just `this.sstablePaths` — an in-memory array. Flush and compaction never mutate an existing
 * SSTable file; they only ever write a brand new file and then reassign `this.sstablePaths` to a
 * new array that points at it. That reassignment is the "atomic swap" described in the package
 * README: any `scan()` call that is already running (this is Node — nothing can literally be
 * "in flight" concurrently, but conceptually) either grabbed the old array and reads the old
 * files, or the new one and reads the new files. It never observes a half-swapped state, and it
 * never reads a file that is being deleted out from under it, because deletion only ever happens
 * *after* the swap, for files no live reference points at anymore.
 */
export class LsmTable implements TableStorage {
  private readonly memtable = new Memtable();
  private sstablePaths: string[] = [];
  private nextSstableSeq = 1;
  private nextRowIdCounter = 1;

  constructor(
    private readonly dir: string,
    private readonly deps: LsmTableDeps,
    private readonly flushThreshold: number,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.sstablePaths = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sst'))
      .sort()
      .map((f) => path.join(dir, f));
    for (const p of this.sstablePaths) {
      const seq = parseInt(path.basename(p), 10);
      if (Number.isFinite(seq) && seq >= this.nextSstableSeq) this.nextSstableSeq = seq + 1;
      for (const v of readSSTableFile(p)) this.bumpRowIdCounter(v.id);
    }
  }

  private bumpRowIdCounter(id: RowId): void {
    const n = Number(id);
    if (Number.isFinite(n) && n >= this.nextRowIdCounter) this.nextRowIdCounter = n + 1;
  }

  scan(snapshot: Snapshot): IterableIterator<StoredRow> {
    // Correctness-first merge: read every committed version from the memtable and every SSTable
    // (newest-to-oldest doesn't need to be respected explicitly, because we pick, per row id, the
    // single version with the largest `createdAt` that is still `<= snapshot.readTimestamp` — the
    // same answer "check memtable, then each SSTable newest-to-oldest, stop at the first match"
    // would give, just computed as one global pass instead of an early-terminating per-source
    // walk. A real LSM engine would do a sorted merge-iterator with early termination instead of
    // materializing everything; this MVP prioritizes obvious correctness over that optimization.
    const all: RowVersion[] = [...this.memtable.committedVersions()];
    for (const p of this.sstablePaths) all.push(...readSSTableFile(p));

    const winners = new Map<RowId, RowVersion>();
    for (const v of all) {
      if (v.createdAt === undefined || v.createdAt > snapshot.readTimestamp) continue;
      const current = winners.get(v.id);
      if (!current || v.createdAt! > current.createdAt!) winners.set(v.id, v);
    }

    const rows: StoredRow[] = [];
    for (const v of winners.values()) {
      if (v.values !== null) rows.push({ id: v.id, values: v.values });
    }
    rows.sort((a, b) => Number(a.id) - Number(b.id));
    return rows[Symbol.iterator]();
  }

  insert(values: SqlValue[], txn: TransactionId): RowId {
    const id = String(this.nextRowIdCounter);
    this.nextRowIdCounter += 1;
    // WAL first, memtable second — durability comes from the fsync'd log record, not the
    // in-memory structure. If the process dies right after the append returns, replay on the
    // next `open()` reconstructs this exact memtable entry from the log.
    this.deps.wal.append({ type: 'write', table: this.deps.tableName, op: 'insert', id, values, txn });
    this.memtable.writePending(id, values, txn);
    return id;
  }

  update(id: RowId, values: SqlValue[], txn: TransactionId): void {
    this.deps.wal.append({ type: 'write', table: this.deps.tableName, op: 'update', id, values, txn });
    this.memtable.writePending(id, values, txn);
  }

  delete(id: RowId, txn: TransactionId): void {
    this.deps.wal.append({ type: 'write', table: this.deps.tableName, op: 'delete', id, values: null, txn });
    this.memtable.deletePending(id, txn);
  }

  /** Applied only by the engine's `commit()` — freezes this txn's pending writes at `commitTimestamp`. */
  finalizeCommit(txn: TransactionId, commitTimestamp: number): void {
    this.memtable.finalizeCommit(txn, commitTimestamp);
  }

  /** Applied only by the engine's `rollback()` — erases this txn's pending writes entirely. */
  discardTransaction(txn: TransactionId): void {
    this.memtable.discardTransaction(txn);
  }

  /**
   * Replays a single WAL `write` record against this table's memtable during engine startup —
   * the counterpart to `insert`/`update`/`delete` that does *not* re-append to the WAL (it's
   * already there; that's what we're replaying) and takes the row id from the record instead of
   * minting a new one.
   */
  replayApply(record: { op: 'insert' | 'update' | 'delete'; id: RowId; values: SqlValue[] | null; txn: TransactionId }): void {
    if (record.op === 'delete') {
      this.memtable.deletePending(record.id, record.txn);
    } else {
      this.memtable.writePending(record.id, record.values as SqlValue[], record.txn);
    }
    if (record.op === 'insert') this.bumpRowIdCounter(record.id);
  }

  /** Number of committed row-version records currently sitting in the memtable, unflushed. Exposed for tests/inspection. */
  memtableCommittedCount(): number {
    return this.memtable.committedCount();
  }

  /** Current on-disk SSTable file count. Exposed for tests/inspection. */
  sstableCount(): number {
    return this.sstablePaths.length;
  }

  /** Total row-version records across all current SSTables. Exposed for tests/inspection (e.g. to confirm compaction actually shrank the record count). */
  sstableRecordCount(): number {
    return this.sstablePaths.reduce((sum, p) => sum + readSSTableFile(p).length, 0);
  }

  /** Flushes the memtable's committed versions to a new SSTable if the configured threshold is met. A no-op otherwise. */
  maybeFlush(): void {
    if (this.memtable.committedCount() >= this.flushThreshold) this.flush();
  }

  /** Unconditionally flushes whatever committed versions are currently in the memtable (a no-op if there are none). */
  flush(): void {
    const committed = this.memtable.committedVersions();
    if (committed.length === 0) return;
    const filePath = this.newSstablePath();
    writeSSTableFile(filePath, committed);
    this.memtable.removeFlushed(committed);
    this.sstablePaths = [...this.sstablePaths, filePath];
  }

  private newSstablePath(): string {
    const name = `${String(this.nextSstableSeq).padStart(6, '0')}.sst`;
    this.nextSstableSeq += 1;
    return path.join(this.dir, name);
  }

  /**
   * "Background-capable, not automatically scheduled on a timer" compaction — see the package
   * README/index.ts docs for the full explanation of what "background" honestly means here. This
   * method runs synchronously, start to finish, when called; nothing schedules it automatically.
   * It never blocks/interferes with a concurrent `insert`/`update`/`delete`/`scan` in any way that
   * matters because SSTables are immutable: this reads every current SSTable, computes the merged
   * result in memory, writes it to a brand new file, and only then swaps `this.sstablePaths` to
   * point at just that new file and deletes the old files. Any `scan()` is either done reading
   * before this call happened (safe: it read complete, valid files) or starts after this call
   * returns (safe: it reads the new, complete, valid file) — there is no window where a reader
   * observes a torn state or a file disappearing mid-read.
   */
  compactNow(): CompactionStats {
    const before = this.sstablePaths;
    const inputRecords = before.flatMap((p) => readSSTableFile(p));
    if (before.length <= 1) {
      return { inputRecordCount: inputRecords.length, outputRecordCount: inputRecords.length, sstableCountBefore: before.length, sstableCountAfter: before.length };
    }
    const kept = mergeAndDropDeadVersions(inputRecords, this.deps.minActiveReadTimestamp());
    const newPath = this.newSstablePath();
    writeSSTableFile(newPath, kept);
    this.sstablePaths = [newPath];
    for (const p of before) fs.rmSync(p, { force: true });
    return { inputRecordCount: inputRecords.length, outputRecordCount: kept.length, sstableCountBefore: before.length, sstableCountAfter: 1 };
  }
}
