import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Snapshot, StorageEngine, TableStorage, TransactionId } from '@titanforge/storage-api';
import { StorageError } from '@titanforge/storage-api';
import { LsmTable, type CompactionStats } from './lsm-table.js';
import { Wal } from './wal.js';

export interface LsmEngineOptions {
  /**
   * Number of *committed* row-version records a table's memtable may accumulate before a commit
   * that touches it triggers a flush to a new SSTable. Small by default specifically so tests
   * (and this engine's own README example) can trigger a real flush without needing thousands of
   * rows.
   */
  memtableFlushThreshold?: number;
}

type TxnStatus = 'open' | 'committed' | 'rolled-back';

/**
 * The real, disk-backed `StorageEngine`: one shared WAL file for durability, one `LsmTable`
 * (memtable + SSTables) per table, and one shared commit-timestamp counter across the whole
 * engine — exactly like `MemoryStorageEngine`, and for the exact same reason: a single snapshot
 * has to mean the same instant across every table, which only holds if there is one counter,
 * incremented once per commit, full stop.
 *
 * Durability: `open()` (the constructor) replays the WAL from byte zero every time, which is
 * what makes data survive a process restart/crash — see `replay()` below. The WAL itself is
 * never truncated or checkpointed in this MVP (a real system would drop WAL entries once their
 * data is safely in an SSTable); it always holds full history and is always fully replayed. That
 * is simple and correct — just not space-efficient — which this brief's "correctness over
 * aggressiveness" guidance says to prefer.
 */
export class LsmEngine implements StorageEngine {
  private readonly wal: Wal;
  private readonly tablesDir: string;
  private readonly flushThreshold: number;
  private readonly tables = new Map<string, LsmTable>();

  private commitCounter = 0;
  private nextTxnId = 1;
  private readonly txnStatus = new Map<TransactionId, TxnStatus>();
  private readonly openSnapshots = new Map<TransactionId, Snapshot>();

  constructor(dataDir: string, options: LsmEngineOptions = {}) {
    this.flushThreshold = options.memtableFlushThreshold ?? 8;
    fs.mkdirSync(dataDir, { recursive: true });
    this.tablesDir = path.join(dataDir, 'tables');
    fs.mkdirSync(this.tablesDir, { recursive: true });
    this.wal = new Wal(path.join(dataDir, 'wal.log'));
    this.replay();
  }

  private tableDir(name: string): string {
    return path.join(this.tablesDir, name);
  }

  private tableDeps(name: string): { wal: Wal; tableName: string; minActiveReadTimestamp: () => number } {
    return { wal: this.wal, tableName: name, minActiveReadTimestamp: () => this.minActiveReadTimestamp() };
  }

  private minActiveReadTimestamp(): number {
    let min = Infinity;
    for (const snapshot of this.openSnapshots.values()) {
      if (snapshot.readTimestamp < min) min = snapshot.readTimestamp;
    }
    return min;
  }

  /**
   * Reconstructs every table's memtable purely from the WAL, in log order. `write` records are
   * applied as pending versions immediately; a `commit` record finalizes (stamps `createdAt` on)
   * every table's pending versions for that transaction id — cheap and correct to do
   * unconditionally for every table on every commit, since `finalizeCommit` is a no-op for any
   * table the transaction never actually touched. A transaction whose `write` records were never
   * followed by a `commit` (the crash-mid-transaction case) simply never gets finalized and its
   * versions are never visible to anything — exactly the "an open transaction did not survive"
   * behavior MVCC requires, achieved with no special-case code at all.
   *
   * Existing SSTable files on disk are picked up separately, by each `LsmTable`'s own
   * constructor scanning its directory — they are not reconstructed from the WAL (the WAL is
   * never truncated, so they're a read-path optimization/cache layered on top of the WAL's full
   * history, not a second source of truth).
   */
  private replay(): void {
    for (const rec of this.wal.readAll()) {
      switch (rec.type) {
        case 'createTable': {
          if (!this.tables.has(rec.table)) {
            this.tables.set(rec.table, new LsmTable(this.tableDir(rec.table), this.tableDeps(rec.table), this.flushThreshold));
          }
          break;
        }
        case 'dropTable': {
          this.tables.delete(rec.table);
          this.clearTableDir(rec.table);
          break;
        }
        case 'write': {
          this.tables.get(rec.table)?.replayApply(rec);
          if (rec.txn >= this.nextTxnId) this.nextTxnId = rec.txn + 1;
          break;
        }
        case 'commit': {
          for (const table of this.tables.values()) table.finalizeCommit(rec.txn, rec.ts);
          if (rec.ts > this.commitCounter) this.commitCounter = rec.ts;
          if (rec.txn >= this.nextTxnId) this.nextTxnId = rec.txn + 1;
          break;
        }
        case 'rollback': {
          for (const table of this.tables.values()) table.discardTransaction(rec.txn);
          if (rec.txn >= this.nextTxnId) this.nextTxnId = rec.txn + 1;
          break;
        }
        default: {
          const exhaustive: never = rec;
          throw new StorageError(`unknown WAL record: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
  }

  private clearTableDir(name: string): void {
    fs.rmSync(this.tableDir(name), { recursive: true, force: true });
  }

  createTable(name: string): TableStorage {
    if (this.tables.has(name)) throw new StorageError(`table "${name}" already exists`);
    this.wal.append({ type: 'createTable', table: name });
    const table = new LsmTable(this.tableDir(name), this.tableDeps(name), this.flushThreshold);
    this.tables.set(name, table);
    return table;
  }

  dropTable(name: string): void {
    if (!this.tables.has(name)) throw new StorageError(`table "${name}" does not exist`);
    this.wal.append({ type: 'dropTable', table: name });
    this.tables.delete(name);
    this.clearTableDir(name);
  }

  getTable(name: string): TableStorage {
    return this.getLsmTable(name);
  }

  private getLsmTable(name: string): LsmTable {
    const table = this.tables.get(name);
    if (table === undefined) throw new StorageError(`table "${name}" does not exist`);
    return table;
  }

  hasTable(name: string): boolean {
    return this.tables.has(name);
  }

  beginTransaction(): { txn: TransactionId; snapshot: Snapshot } {
    const txn = this.nextTxnId;
    this.nextTxnId += 1;
    this.txnStatus.set(txn, 'open');
    const snapshot: Snapshot = { readTimestamp: this.commitCounter };
    this.openSnapshots.set(txn, snapshot);
    return { txn, snapshot };
  }

  commit(txn: TransactionId): void {
    this.assertOpen(txn);
    this.commitCounter += 1;
    const commitTimestamp = this.commitCounter;
    this.wal.append({ type: 'commit', txn, ts: commitTimestamp });
    this.txnStatus.set(txn, 'committed');
    this.openSnapshots.delete(txn);
    for (const table of this.tables.values()) {
      table.finalizeCommit(txn, commitTimestamp);
      // Flush is checked after every commit, not on a timer or separate thread — see LsmTable's
      // `maybeFlush` docs. It only fires once a table's memtable has accumulated enough
      // committed versions to cross `flushThreshold`.
      table.maybeFlush();
    }
  }

  rollback(txn: TransactionId): void {
    this.assertOpen(txn);
    this.wal.append({ type: 'rollback', txn });
    this.txnStatus.set(txn, 'rolled-back');
    this.openSnapshots.delete(txn);
    for (const table of this.tables.values()) table.discardTransaction(txn);
  }

  private assertOpen(txn: TransactionId): void {
    const status = this.txnStatus.get(txn);
    if (status === undefined) throw new StorageError(`no such transaction ${txn}`);
    if (status !== 'open') throw new StorageError(`transaction ${txn} is already ${status}`);
  }

  currentSnapshot(): Snapshot {
    return { readTimestamp: this.commitCounter };
  }

  close(): void {
    this.wal.close();
  }

  /**
   * Triggers compaction for one table right now. Not part of the `StorageEngine` interface (the
   * executor/planner never need to call this) — an explicit extension point for tests and for
   * whatever operational tooling would eventually schedule it. See `LsmTable.compactNow` for the
   * precise "what does 'background' mean here" mechanism.
   */
  compactTable(name: string): CompactionStats {
    return this.getLsmTable(name).compactNow();
  }
}
