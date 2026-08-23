import type { RowId, SqlValue, TransactionId } from '@titanforge/storage-api';

/**
 * One version of one row. Unlike `storage-memory`'s `RowVersion` (which mutates a *previous*
 * array entry's `deletedTxn` when a row is updated/deleted), every version here is entirely
 * self-contained: `values: null` *is* the tombstone. That's required once versions can live in
 * an immutable on-disk SSTable file — there is no "previous entry" to reach back and mutate once
 * it's been flushed, so a delete/update must always be a brand new, independent record. This
 * also makes visibility a one-line rule: for a given row id, the visible version for a snapshot
 * is whichever version has the largest `createdAt` that is still `<= snapshot.readTimestamp`; if
 * that version's `values` is `null`, the row does not exist as of that snapshot.
 */
export interface RowVersion {
  id: RowId;
  values: SqlValue[] | null;
  /** Commit timestamp this version became visible, or `undefined` while its writing transaction is still open (never written to an SSTable in that state). */
  createdAt: number | undefined;
  createdTxn: TransactionId;
}

/**
 * The in-memory structure holding a table's most recent writes, not yet flushed to an SSTable —
 * this is always the first place a read checks. A plain array of versions (mirroring
 * `storage-memory`'s `MemoryTableStorage`) rather than a `Map` keyed by row id, because a single
 * id can legitimately have several versions in flight here at once (e.g. inserted, then updated,
 * both before either has flushed) and visibility needs all of them to pick the right one.
 */
export class Memtable {
  private versions: RowVersion[] = [];

  /** Records an insert or update as *pending* (not yet visible to anything — see `finalizeCommit`). */
  writePending(id: RowId, values: SqlValue[], txn: TransactionId): void {
    this.versions.push({ id, values, createdAt: undefined, createdTxn: txn });
  }

  /** Records a delete as a pending tombstone. */
  deletePending(id: RowId, txn: TransactionId): void {
    this.versions.push({ id, values: null, createdAt: undefined, createdTxn: txn });
  }

  /** Stamps every still-pending version written by `txn` with the commit timestamp it became visible at. */
  finalizeCommit(txn: TransactionId, commitTimestamp: number): void {
    for (const version of this.versions) {
      if (version.createdTxn === txn && version.createdAt === undefined) version.createdAt = commitTimestamp;
    }
  }

  /** Erases every still-pending version written by `txn` — undoes inserts/updates/deletes entirely, as if they never happened. */
  discardTransaction(txn: TransactionId): void {
    this.versions = this.versions.filter((v) => !(v.createdTxn === txn && v.createdAt === undefined));
  }

  /** Every version that has been committed (and is therefore eligible to be flushed to an SSTable) — excludes anything still pending. */
  committedVersions(): RowVersion[] {
    return this.versions.filter((v) => v.createdAt !== undefined);
  }

  committedCount(): number {
    return this.committedVersions().length;
  }

  /** Every version currently held, committed or pending — mainly for tests/inspection. */
  allVersions(): RowVersion[] {
    return this.versions;
  }

  /**
   * Removes exactly the given (already-written-to-an-SSTable) versions, by identity, leaving
   * everything else untouched — notably any writes still pending (uncommitted at flush time) and
   * any writes committed *after* the flush snapshot was taken (flush is synchronous, so in
   * practice that second case can't happen mid-call, but the identity-based removal makes no
   * assumption about that either way).
   */
  removeFlushed(flushed: RowVersion[]): void {
    const flushedSet = new Set(flushed);
    this.versions = this.versions.filter((v) => !flushedSet.has(v));
  }
}
