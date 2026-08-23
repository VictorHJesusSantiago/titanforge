import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredRow } from '@titanforge/storage-api';
import { LsmTable, type LsmTableDeps } from '../lsm-table.js';
import { Wal } from '../wal.js';

let dir: string;
let wal: Wal;
let minActive = Infinity;

function deps(tableName = 't'): LsmTableDeps {
  return { wal, tableName, minActiveReadTimestamp: () => minActive };
}

function rows(iter: IterableIterator<StoredRow>): unknown[][] {
  return [...iter].map((r) => r.values);
}

beforeEach(() => {
  dir = path.join(os.tmpdir(), `titanforge-lsm-table-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  wal = new Wal(path.join(dir, 'wal.log'));
  minActive = Infinity;
});

afterEach(() => {
  wal.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('LsmTable — basic CRUD against the memtable only', () => {
  it('an insert is invisible until finalizeCommit runs', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 100);
    table.insert([1], 1);
    expect(rows(table.scan({ readTimestamp: 999 }))).toEqual([]);
    table.finalizeCommit(1, 1);
    expect(rows(table.scan({ readTimestamp: 1 }))).toEqual([[1]]);
  });

  it('update supersedes the prior version once both are committed', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 100);
    const id = table.insert(['a'], 1);
    table.finalizeCommit(1, 1);
    table.update(id, ['b'], 2);
    table.finalizeCommit(2, 2);
    expect(rows(table.scan({ readTimestamp: 2 }))).toEqual([['b']]);
  });

  it('delete removes a row from later snapshots', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 100);
    const id = table.insert(['a'], 1);
    table.finalizeCommit(1, 1);
    table.delete(id, 2);
    table.finalizeCommit(2, 2);
    expect(rows(table.scan({ readTimestamp: 2 }))).toEqual([]);
  });

  it('a snapshot taken before an update still sees the old value', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 100);
    const id = table.insert(['old'], 1);
    table.finalizeCommit(1, 1);
    table.update(id, ['new'], 2);
    table.finalizeCommit(2, 2);
    expect(rows(table.scan({ readTimestamp: 1 }))).toEqual([['old']]);
    expect(rows(table.scan({ readTimestamp: 2 }))).toEqual([['new']]);
  });

  it('rollback (discardTransaction) makes an insert permanently invisible', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 100);
    table.insert(['x'], 1);
    table.discardTransaction(1);
    expect(rows(table.scan({ readTimestamp: 999 }))).toEqual([]);
  });

  it('insert generates sequential row ids starting at 1', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 100);
    expect(table.insert(['a'], 1)).toBe('1');
    expect(table.insert(['b'], 1)).toBe('2');
  });
});

describe('LsmTable — flush to SSTable', () => {
  it('maybeFlush is a no-op below the threshold', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 3);
    for (let i = 0; i < 2; i += 1) {
      const id = table.insert([i], 1);
      table.finalizeCommit(1, i + 1);
      void id;
    }
    table.maybeFlush();
    expect(table.sstableCount()).toBe(0);
    expect(table.memtableCommittedCount()).toBe(2);
  });

  it('maybeFlush writes a new SSTable and clears the memtable once the threshold is met', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 3);
    let ts = 0;
    for (let i = 0; i < 3; i += 1) {
      table.insert([i], 1);
      ts += 1;
      table.finalizeCommit(1, ts);
      table.maybeFlush();
    }
    expect(table.sstableCount()).toBe(1);
    expect(table.memtableCommittedCount()).toBe(0);
  });

  it('reads after a flush return correct results by consulting both memtable and SSTable', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 2);
    table.insert(['a'], 1);
    table.finalizeCommit(1, 1);
    table.insert(['b'], 2);
    table.finalizeCommit(2, 2);
    table.maybeFlush(); // threshold=2 reached: both rows now flushed to an SSTable
    expect(table.sstableCount()).toBe(1);
    expect(table.memtableCommittedCount()).toBe(0);

    // A third row lands in the (now-empty) memtable, on top of the flushed SSTable.
    table.insert(['c'], 3);
    table.finalizeCommit(3, 3);

    expect(rows(table.scan({ readTimestamp: 3 })).sort()).toEqual([['a'], ['b'], ['c']].sort());
  });

  it('an update that lands in the memtable correctly supersedes a version already flushed to an SSTable', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 1);
    const id = table.insert(['old'], 1);
    table.finalizeCommit(1, 1);
    table.maybeFlush(); // 'old' is now on disk
    expect(table.sstableCount()).toBe(1);

    table.update(id, ['new'], 2);
    table.finalizeCommit(2, 2);
    // Not yet flushed again — 'new' lives only in the memtable, 'old' only in the SSTable.
    expect(rows(table.scan({ readTimestamp: 2 }))).toEqual([['new']]);
    // A snapshot from before the update still sees the flushed 'old' version.
    expect(rows(table.scan({ readTimestamp: 1 }))).toEqual([['old']]);
  });

  it('a delete that lands in the memtable correctly hides a version already flushed to an SSTable', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 1);
    const id = table.insert(['x'], 1);
    table.finalizeCommit(1, 1);
    table.maybeFlush();

    table.delete(id, 2);
    table.finalizeCommit(2, 2);
    expect(rows(table.scan({ readTimestamp: 2 }))).toEqual([]);
    expect(rows(table.scan({ readTimestamp: 1 }))).toEqual([['x']]);
  });

  it('flush() on an empty (no committed versions) memtable is a harmless no-op', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 100);
    table.flush();
    expect(table.sstableCount()).toBe(0);
  });

  it('a large number of writes forces multiple flushes and all rows remain readable', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 5);
    let ts = 0;
    const expected: unknown[][] = [];
    for (let i = 0; i < 23; i += 1) {
      table.insert([i], 1);
      ts += 1;
      table.finalizeCommit(1, ts);
      table.maybeFlush();
      expected.push([i]);
    }
    expect(table.sstableCount()).toBeGreaterThan(1);
    const result = rows(table.scan({ readTimestamp: ts })).sort((a, b) => (a[0] as number) - (b[0] as number));
    expect(result).toEqual(expected);
  });
});

describe('LsmTable — reopening against an existing directory (SSTables persist)', () => {
  it('a new LsmTable instance over the same directory sees previously flushed SSTables', () => {
    const tableDir = path.join(dir, 't');
    const first = new LsmTable(tableDir, deps(), 1);
    first.insert(['a'], 1);
    first.finalizeCommit(1, 1);
    first.maybeFlush();
    expect(first.sstableCount()).toBe(1);

    const second = new LsmTable(tableDir, deps(), 1);
    expect(second.sstableCount()).toBe(1);
    expect(rows(second.scan({ readTimestamp: 1 }))).toEqual([['a']]);
  });

  it('a new LsmTable instance continues row ids from the max seen in existing SSTables', () => {
    const tableDir = path.join(dir, 't');
    const first = new LsmTable(tableDir, deps(), 1);
    const id1 = first.insert(['a'], 1);
    first.finalizeCommit(1, 1);
    first.maybeFlush();
    expect(id1).toBe('1');

    const second = new LsmTable(tableDir, deps(), 1);
    const id2 = second.insert(['b'], 2);
    expect(id2).toBe('2');
  });
});

describe('LsmTable — compaction', () => {
  it('compactNow with 0 or 1 SSTables is a no-op that reports before === after', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 100);
    const statsEmpty = table.compactNow();
    expect(statsEmpty).toEqual({ inputRecordCount: 0, outputRecordCount: 0, sstableCountBefore: 0, sstableCountAfter: 0 });

    table.insert(['a'], 1);
    table.finalizeCommit(1, 1);
    table.flush();
    const statsOne = table.compactNow();
    expect(statsOne.sstableCountBefore).toBe(1);
    expect(statsOne.sstableCountAfter).toBe(1);
  });

  it('accumulating many versions of the same row across multiple flushes, then compacting, reduces on-disk record count and preserves correctness', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 1); // flush after every single commit
    const id = table.insert(['v0'], 1);
    table.finalizeCommit(1, 1);
    table.maybeFlush();

    let ts = 1;
    for (let i = 1; i <= 5; i += 1) {
      table.update(id, [`v${i}`], i + 1);
      ts += 1;
      table.finalizeCommit(i + 1, ts);
      table.maybeFlush();
    }
    expect(table.sstableCount()).toBe(6); // one flush per commit: 6 total versions written
    expect(table.sstableRecordCount()).toBe(6);

    minActive = Infinity; // no open transactions: only the newest version can possibly be needed
    const stats = table.compactNow();

    expect(stats.inputRecordCount).toBe(6);
    expect(stats.outputRecordCount).toBe(1); // every older version of the same row id is dead
    expect(table.sstableCount()).toBe(1);
    expect(table.sstableRecordCount()).toBe(1);

    expect(rows(table.scan({ readTimestamp: ts }))).toEqual([['v5']]);
  });

  it('compaction respects an open transaction: does not drop a version an active snapshot still needs', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 1);
    const id = table.insert(['v0'], 1);
    table.finalizeCommit(1, 1);
    table.maybeFlush(); // v0 committed at ts=1

    table.update(id, ['v1'], 2);
    table.finalizeCommit(2, 2);
    table.maybeFlush(); // v1 committed at ts=2

    minActive = 1; // an open transaction's snapshot is still reading as of ts=1
    const stats = table.compactNow();

    expect(stats.outputRecordCount).toBe(2); // v0 must survive for the open snapshot; v1 must survive for anything newer
    expect(rows(table.scan({ readTimestamp: 1 }))).toEqual([['v0']]);
    expect(rows(table.scan({ readTimestamp: 2 }))).toEqual([['v1']]);
  });

  it('compaction drops a fully-superseded-and-deleted row entirely', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 1);
    const id = table.insert(['x'], 1);
    table.finalizeCommit(1, 1);
    table.maybeFlush();
    table.delete(id, 2);
    table.finalizeCommit(2, 2);
    table.maybeFlush();

    minActive = Infinity;
    const stats = table.compactNow();
    expect(stats.outputRecordCount).toBe(0);
    expect(rows(table.scan({ readTimestamp: 2 }))).toEqual([]);
  });

  it('scan results are identical before and after compaction, for every relevant snapshot', () => {
    const table = new LsmTable(path.join(dir, 't'), deps(), 1);
    const idA = table.insert(['a0'], 1);
    table.finalizeCommit(1, 1);
    table.maybeFlush();
    const idB = table.insert(['b0'], 2);
    table.finalizeCommit(2, 2);
    table.maybeFlush();
    table.update(idA, ['a1'], 3);
    table.finalizeCommit(3, 3);
    table.maybeFlush();
    void idB;

    const before = rows(table.scan({ readTimestamp: 3 })).sort();
    minActive = Infinity;
    table.compactNow();
    const after = rows(table.scan({ readTimestamp: 3 })).sort();
    expect(after).toEqual(before);
  });
});
