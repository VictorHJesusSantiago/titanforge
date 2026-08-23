/**
 * `@titanforge/storage-lsm` — a real, disk-backed `StorageEngine`: write-ahead log for
 * durability, an in-memory memtable, immutable on-disk SSTables, and explicit
 * background-capable compaction. See each module's own docs for the precise mechanism:
 *
 * - `wal.ts` — the append-only, fsync'd-per-write durability log, and its replay-on-`open()`.
 * - `memtable.ts` — the in-memory structure holding recent, not-yet-flushed writes.
 * - `sstable.ts` — immutable on-disk file format, plus the pure compaction/merge logic.
 * - `lsm-table.ts` — `TableStorage` for one table: coordinates memtable + SSTables + compaction.
 * - `lsm-engine.ts` — `StorageEngine`: owns the WAL and the transaction/commit-timestamp bookkeeping.
 *
 * On "background" compaction: Node is single-threaded, so nothing here runs on a separate
 * thread or a timer. `compactTable()` (via `LsmTable.compactNow`) runs synchronously,
 * start-to-finish, exactly when called — this MVP is deliberately honest that it is
 * "background-capable, not automatically scheduled" rather than claiming real concurrency it
 * cannot provide. What *is* true, and is the actually load-bearing property: compaction never
 * blocks or interferes with a concurrent `insert`/`update`/`delete`/`scan`, because SSTable
 * files are immutable — compaction only ever writes a brand-new file and then atomically swaps
 * an in-memory pointer (`LsmTable`'s `sstablePaths` array) to point at it, deleting old files
 * only after that swap. No caller ever observes a torn read or a file vanishing mid-scan.
 */
export { LsmEngine, type LsmEngineOptions } from './lsm-engine.js';
export { LsmTable, type CompactionStats, type LsmTableDeps } from './lsm-table.js';
export { Memtable, type RowVersion } from './memtable.js';
export { deserializeSSTable, mergeAndDropDeadVersions, readSSTableFile, serializeSSTable, writeSSTableFile } from './sstable.js';
export { Wal, parseWalLines, readWalFile, type WalRecord } from './wal.js';
