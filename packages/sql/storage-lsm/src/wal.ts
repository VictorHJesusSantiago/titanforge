import * as fs from 'node:fs';
import type { RowId, SqlValue, TransactionId } from '@titanforge/storage-api';

/**
 * Write-ahead log record format: newline-delimited JSON, one record per line, append-only.
 *
 * `write` records carry enough to replay a single insert/update/delete on a single table:
 * `values: null` for a `delete` op means "tombstone" (there is no row content to replay, only
 * the fact that this row id stopped existing as of whatever transaction later commits it).
 * `commit`/`rollback` records are what turn a burst of buffered `write` records into either
 * permanently-visible history (`commit`, carrying the shared commit-timestamp counter's new
 * value) or nothing at all (`rollback` — on replay, any `write` records for that transaction id
 * that were never followed by a matching `commit` are simply never applied, which is exactly
 * "an open transaction did not survive the crash" — the correct MVCC behavior with zero special
 * casing).
 */
export type WalRecord =
  | { type: 'createTable'; table: string }
  | { type: 'dropTable'; table: string }
  | { type: 'write'; table: string; op: 'insert' | 'update' | 'delete'; id: RowId; values: SqlValue[] | null; txn: TransactionId }
  | { type: 'commit'; txn: TransactionId; ts: number }
  | { type: 'rollback'; txn: TransactionId };

/** Thin I/O: read the raw file content, or `''` if the WAL doesn't exist yet (a brand-new database). */
export function readWalFile(path: string): string {
  if (!fs.existsSync(path)) return '';
  return fs.readFileSync(path, 'utf8');
}

/**
 * Pure parsing logic, deliberately separated from file I/O so it can be unit-tested directly
 * against in-memory strings. Tolerant of exactly one thing: a corrupt/truncated *last* line,
 * which is what a real crash mid-`fs.writeSync` looks like (a partially-written final record).
 * A parse failure anywhere other than the last line is a genuine corruption and is not swallowed.
 */
export function parseWalLines(content: string): WalRecord[] {
  const lines = content.split('\n').filter((line) => line.length > 0);
  const records: WalRecord[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    try {
      records.push(JSON.parse(line) as WalRecord);
    } catch (err) {
      if (i === lines.length - 1) break; // torn last write from a crash mid-append — safe to drop
      throw err;
    }
  }
  return records;
}

/**
 * The durable append-only log itself. Every `append` writes the record's line and calls
 * `fsync` before returning — that fsync *is* the durability guarantee this whole engine rests
 * on: once `append` returns, the record survives a crash (power loss, process kill) even though
 * the corresponding memtable entry is still purely in-memory at that point.
 */
export class Wal {
  private readonly fd: number;

  constructor(private readonly path: string) {
    this.fd = fs.openSync(path, 'a');
  }

  /** Every record currently in the log, in write order. Only meaningful before any further `append` calls interleave with a concurrent reader — used at startup, before this instance itself has appended anything. */
  readAll(): WalRecord[] {
    return parseWalLines(readWalFile(this.path));
  }

  append(record: WalRecord): void {
    const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}
