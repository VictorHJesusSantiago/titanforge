import type { Snapshot, StorageEngine, TableStorage, TransactionId } from '@titanforge/storage-api';
import { StorageError } from '@titanforge/storage-api';
import { MemoryTableStorage } from './memory-table.js';

type TxnStatus = 'open' | 'committed' | 'rolled-back';

/**
 * A pure in-memory `StorageEngine` — every table is a `MemoryTableStorage`, sharing one commit
 * timestamp counter across the whole engine (not per-table), which is what makes a snapshot
 * taken once cover every table consistently: reading `orders` and `users` under the same
 * snapshot never sees a commit to one but not a concurrent commit to the other that happened
 * "between" them, because there is no between — one counter, incremented once per commit,
 * period.
 */
export class MemoryStorageEngine implements StorageEngine {
  private readonly tables = new Map<string, MemoryTableStorage>();
  private commitCounter = 0;
  private readonly commitTimestamps = new Map<TransactionId, number>();
  private readonly txnStatus = new Map<TransactionId, TxnStatus>();
  private nextTxnId = 1;

  private readonly commitClock = {
    commitTimestampOf: (txn: TransactionId): number | undefined => this.commitTimestamps.get(txn),
  };

  createTable(name: string): TableStorage {
    if (this.tables.has(name)) throw new StorageError(`table "${name}" already exists`);
    const table = new MemoryTableStorage(this.commitClock);
    this.tables.set(name, table);
    return table;
  }

  dropTable(name: string): void {
    if (!this.tables.has(name)) throw new StorageError(`table "${name}" does not exist`);
    this.tables.delete(name);
  }

  getTable(name: string): TableStorage {
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
    return { txn, snapshot: { readTimestamp: this.commitCounter } };
  }

  commit(txn: TransactionId): void {
    this.assertOpen(txn);
    this.commitCounter += 1;
    this.commitTimestamps.set(txn, this.commitCounter);
    this.txnStatus.set(txn, 'committed');
    for (const table of this.tables.values()) table.finalizeCommit(txn, this.commitCounter);
  }

  rollback(txn: TransactionId): void {
    this.assertOpen(txn);
    this.txnStatus.set(txn, 'rolled-back');
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
    this.tables.clear();
  }
}
