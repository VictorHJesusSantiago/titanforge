import type { RowId, Snapshot, SqlValue, StoredRow, TableStorage, TransactionId } from '@titanforge/storage-api';

interface RowVersion {
  id: RowId;
  values: SqlValue[];
  /** Commit timestamp this version became visible, or `undefined` while its writing transaction is still open. */
  createdAt: number | undefined;
  createdTxn: TransactionId;
  /** Commit timestamp this version stopped being visible (a delete or a superseding update), if any. */
  deletedAt: number | undefined;
  deletedTxn: TransactionId | undefined;
}

/**
 * Every version of every row a table has ever held, in one array — nothing is ever removed by an
 * `update`/`delete` here, only marked with a `deletedAt`. That is precisely what makes MVCC
 * snapshot isolation possible: a query holding an old snapshot can still see a row a *newer*
 * transaction has since overwritten, because that row's earlier version is still sitting in this
 * array with a `deletedAt` timestamp the old snapshot's `readTimestamp` doesn't reach yet.
 * Nothing here ever reclaims space for a version no live snapshot can reach anymore — that is
 * real compaction, and this in-memory engine's whole reason to exist is testing the executor
 * against a storage engine simple enough to have none, not being a serious one itself (see
 * `@titanforge/storage-lsm` for that).
 */
export class MemoryTableStorage implements TableStorage {
  private versions: RowVersion[] = [];
  private nextRowId = 1;

  constructor(private readonly commitClock: { commitTimestampOf(txn: TransactionId): number | undefined }) {}

  scan(snapshot: Snapshot): IterableIterator<StoredRow> {
    const visible: StoredRow[] = [];
    const seen = new Set<RowId>();
    // Walk newest-first per row id so the first visible version encountered for a given id is
    // the correct one — an id can have many versions, but only the latest one visible to this
    // snapshot should ever appear in the scan.
    for (let i = this.versions.length - 1; i >= 0; i -= 1) {
      const version = this.versions[i]!;
      if (seen.has(version.id)) continue;
      if (!this.isVisible(version, snapshot)) continue;
      seen.add(version.id);
      visible.push({ id: version.id, values: version.values });
    }
    // Stable ascending-by-first-insertion order, not reverse-scan order — a table scan's result
    // order should not depend on how many times a row happened to be updated.
    visible.reverse();
    return visible[Symbol.iterator]();
  }

  private isVisible(version: RowVersion, snapshot: Snapshot): boolean {
    const createdAt = version.createdAt ?? this.commitClock.commitTimestampOf(version.createdTxn);
    if (createdAt === undefined || createdAt > snapshot.readTimestamp) return false;
    if (version.deletedAt === undefined && version.deletedTxn !== undefined) {
      const deletedAt = this.commitClock.commitTimestampOf(version.deletedTxn);
      if (deletedAt !== undefined && deletedAt <= snapshot.readTimestamp) return false;
      return true;
    }
    if (version.deletedAt !== undefined && version.deletedAt <= snapshot.readTimestamp) return false;
    return true;
  }

  insert(values: SqlValue[], txn: TransactionId): RowId {
    const id = String(this.nextRowId);
    this.nextRowId += 1;
    this.versions.push({ id, values, createdAt: undefined, createdTxn: txn, deletedAt: undefined, deletedTxn: undefined });
    return id;
  }

  update(id: RowId, values: SqlValue[], txn: TransactionId): void {
    this.markLatestDeleted(id, txn);
    this.versions.push({ id, values, createdAt: undefined, createdTxn: txn, deletedAt: undefined, deletedTxn: undefined });
  }

  delete(id: RowId, txn: TransactionId): void {
    this.markLatestDeleted(id, txn);
  }

  private markLatestDeleted(id: RowId, txn: TransactionId): void {
    for (let i = this.versions.length - 1; i >= 0; i -= 1) {
      const version = this.versions[i]!;
      if (version.id === id && version.deletedTxn === undefined) {
        version.deletedTxn = txn;
        return;
      }
    }
  }

  /** Called once a transaction commits, to freeze its writes' `createdAt`/`deletedAt` — see `MemoryStorageEngine.commit`. */
  finalizeCommit(txn: TransactionId, commitTimestamp: number): void {
    for (const version of this.versions) {
      if (version.createdTxn === txn && version.createdAt === undefined) version.createdAt = commitTimestamp;
      if (version.deletedTxn === txn && version.deletedAt === undefined) version.deletedAt = commitTimestamp;
    }
  }

  /** Called if a transaction rolls back, to erase its writes entirely (undoing both inserts and delete-marks). */
  discardTransaction(txn: TransactionId): void {
    this.versions = this.versions.filter((v) => v.createdTxn !== txn);
    for (const version of this.versions) {
      if (version.deletedTxn === txn) version.deletedTxn = undefined;
    }
  }
}
