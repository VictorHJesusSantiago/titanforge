/**
 * The boundary between the executor and whatever actually stores bytes. `@titanforge/executor`
 * depends only on this package, never on a concrete storage implementation — the same query plan
 * runs unmodified against `@titanforge/storage-memory` (a `Map`, used in the executor's own
 * tests and anywhere durability doesn't matter) and `@titanforge/storage-lsm` (the real WAL +
 * memtable + SSTable engine). Proving two storage engines satisfy one interface is this
 * project's version of the renderer-swap trick a 2D game engine uses to prove its draw-list
 * abstraction is real rather than decorative.
 */

export type SqlValue = number | string | boolean | null;

export type RowId = string;

export interface StoredRow {
  id: RowId;
  values: SqlValue[];
}

/**
 * A read timestamp: a row version is visible to a snapshot iff it was committed at or before
 * `readTimestamp` and (if since deleted) the deleting transaction committed after it. Every
 * storage engine shares this exact visibility rule (see each implementation's own tests) — it is
 * the actual definition of "MVCC snapshot isolation" this project implements, not a per-engine
 * detail.
 */
export interface Snapshot {
  readTimestamp: number;
}

export type TransactionId = number;

export interface TableStorage {
  /** Every row version visible to `snapshot`, in the storage engine's own stable iteration order. */
  scan(snapshot: Snapshot): IterableIterator<StoredRow>;
  insert(values: SqlValue[], txn: TransactionId): RowId;
  update(id: RowId, values: SqlValue[], txn: TransactionId): void;
  delete(id: RowId, txn: TransactionId): void;
}

export interface StorageEngine {
  createTable(name: string): TableStorage;
  dropTable(name: string): void;
  getTable(name: string): TableStorage;
  hasTable(name: string): boolean;

  /** Starts a transaction and returns both its id (for writes) and a stable read snapshot. */
  beginTransaction(): { txn: TransactionId; snapshot: Snapshot };
  commit(txn: TransactionId): void;
  rollback(txn: TransactionId): void;

  /** A fresh, immediately-committed snapshot — what an autocommit (no explicit `BEGIN`) statement reads against. */
  currentSnapshot(): Snapshot;

  close(): void;
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}
