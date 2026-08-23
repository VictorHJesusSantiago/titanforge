import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LsmEngine } from '../lsm-engine.js';

let dir: string;

function values(engine: LsmEngine, table: string, snapshotTs: number): unknown[][] {
  return [...engine.getTable(table).scan({ readTimestamp: snapshotTs })].map((r) => r.values);
}

beforeEach(() => {
  dir = path.join(os.tmpdir(), `titanforge-lsm-engine-${randomUUID()}`);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('LsmEngine — basic CRUD, autocommit style', () => {
  it('inserts are visible only after commit', () => {
    const engine = new LsmEngine(dir);
    engine.createTable('t');
    const { txn } = engine.beginTransaction();
    engine.getTable('t').insert([1], txn);

    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([]);
    engine.commit(txn);
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([[1]]);
    engine.close();
  });

  it('update supersedes the prior version', () => {
    const engine = new LsmEngine(dir);
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['a'], first.txn);
    engine.commit(first.txn);

    const second = engine.beginTransaction();
    engine.getTable('t').update(id, ['b'], second.txn);
    engine.commit(second.txn);

    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([['b']]);
    engine.close();
  });

  it('delete removes a row from later snapshots', () => {
    const engine = new LsmEngine(dir);
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['a'], first.txn);
    engine.commit(first.txn);

    const second = engine.beginTransaction();
    engine.getTable('t').delete(id, second.txn);
    engine.commit(second.txn);

    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([]);
    engine.close();
  });
});

describe('LsmEngine — MVCC snapshot isolation', () => {
  it('a snapshot taken before an update still sees the old value, even after the update commits', () => {
    const engine = new LsmEngine(dir);
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['old'], first.txn);
    engine.commit(first.txn);

    const oldSnapshot = engine.currentSnapshot();

    const second = engine.beginTransaction();
    engine.getTable('t').update(id, ['new'], second.txn);
    engine.commit(second.txn);

    expect(values(engine, 't', oldSnapshot.readTimestamp)).toEqual([['old']]);
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([['new']]);
    engine.close();
  });

  it('a snapshot taken before a delete still sees the deleted row', () => {
    const engine = new LsmEngine(dir);
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['x'], first.txn);
    engine.commit(first.txn);

    const oldSnapshot = engine.currentSnapshot();

    const second = engine.beginTransaction();
    engine.getTable('t').delete(id, second.txn);
    engine.commit(second.txn);

    expect(values(engine, 't', oldSnapshot.readTimestamp)).toEqual([['x']]);
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([]);
    engine.close();
  });

  it('an uncommitted write from another (concurrent) transaction is invisible', () => {
    const engine = new LsmEngine(dir);
    engine.createTable('t');
    const writer = engine.beginTransaction();
    engine.getTable('t').insert(['dirty'], writer.txn);

    const reader = engine.beginTransaction();
    expect(values(engine, 't', reader.snapshot.readTimestamp)).toEqual([]);
    engine.commit(writer.txn);
    expect(values(engine, 't', reader.snapshot.readTimestamp)).toEqual([]);
    engine.close();
  });

  it('one shared commit-timestamp counter keeps a single snapshot consistent across multiple tables', () => {
    const engine = new LsmEngine(dir);
    engine.createTable('a');
    engine.createTable('b');
    const t1 = engine.beginTransaction();
    engine.getTable('a').insert(['a-row'], t1.txn);
    engine.commit(t1.txn);

    const snapshot = engine.currentSnapshot();

    const t2 = engine.beginTransaction();
    engine.getTable('b').insert(['b-row'], t2.txn);
    engine.commit(t2.txn);

    // snapshot taken between the two commits sees table a's row but not table b's.
    expect(values(engine, 'a', snapshot.readTimestamp)).toEqual([['a-row']]);
    expect(values(engine, 'b', snapshot.readTimestamp)).toEqual([]);
    engine.close();
  });
});

describe('LsmEngine — MVCC across the memtable/SSTable boundary', () => {
  it('a snapshot taken before an update still sees the old value after a flush forces the old version onto disk', () => {
    const engine = new LsmEngine(dir, { memtableFlushThreshold: 1 });
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['old'], first.txn);
    engine.commit(first.txn); // flush threshold=1 commits immediately trigger a flush: 'old' is now on disk

    const oldSnapshot = engine.currentSnapshot();

    const second = engine.beginTransaction();
    engine.getTable('t').update(id, ['new'], second.txn);
    engine.commit(second.txn); // 'new' flushes too

    expect(values(engine, 't', oldSnapshot.readTimestamp)).toEqual([['old']]);
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([['new']]);
    engine.close();
  });

  it('a concurrent uncommitted write is invisible even after the memtable holding it has been flushed by other commits', () => {
    const engine = new LsmEngine(dir, { memtableFlushThreshold: 1 });
    engine.createTable('t');
    const writer = engine.beginTransaction();
    engine.getTable('t').insert(['dirty'], writer.txn); // pending — never committed, so never flushed

    const reader = engine.beginTransaction();

    // Unrelated commits happen and force flushes, but none of them touch the dirty write.
    const filler = engine.beginTransaction();
    engine.getTable('t').insert(['filler'], filler.txn);
    engine.commit(filler.txn);

    expect(values(engine, 't', reader.snapshot.readTimestamp)).toEqual([]);
    engine.commit(writer.txn);
    expect(values(engine, 't', reader.snapshot.readTimestamp)).toEqual([]);
    engine.close();
  });
});

describe('LsmEngine — rollback', () => {
  it('a rolled-back insert never becomes visible to any snapshot', () => {
    const engine = new LsmEngine(dir);
    engine.createTable('t');
    const { txn } = engine.beginTransaction();
    engine.getTable('t').insert(['x'], txn);
    engine.rollback(txn);

    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([]);
    engine.close();
  });

  it('a rolled-back delete leaves the original row intact', () => {
    const engine = new LsmEngine(dir);
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['x'], first.txn);
    engine.commit(first.txn);

    const second = engine.beginTransaction();
    engine.getTable('t').delete(id, second.txn);
    engine.rollback(second.txn);

    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([['x']]);
    engine.close();
  });

  it('committing or rolling back an already-finished transaction throws', () => {
    const engine = new LsmEngine(dir);
    const { txn } = engine.beginTransaction();
    engine.commit(txn);
    expect(() => engine.commit(txn)).toThrow();
    expect(() => engine.rollback(txn)).toThrow();
    engine.close();
  });

  it('a rolled-back transaction is never replayed as committed data after a restart', () => {
    let engine = new LsmEngine(dir);
    engine.createTable('t');
    const { txn } = engine.beginTransaction();
    engine.getTable('t').insert(['x'], txn);
    engine.rollback(txn);
    // no close() — simulate a crash

    engine = new LsmEngine(dir);
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([]);
    engine.close();
  });
});

describe('LsmEngine — table lifecycle', () => {
  it('createTable rejects a duplicate name; getTable/dropTable reject a missing one', () => {
    const engine = new LsmEngine(dir);
    engine.createTable('t');
    expect(() => engine.createTable('t')).toThrow();
    expect(() => engine.getTable('nope')).toThrow();
    expect(() => engine.dropTable('nope')).toThrow();
    expect(engine.hasTable('t')).toBe(true);
    engine.dropTable('t');
    expect(engine.hasTable('t')).toBe(false);
    engine.close();
  });

  it('a dropped table is gone after restart', () => {
    let engine = new LsmEngine(dir);
    engine.createTable('keep');
    engine.createTable('drop-me');
    engine.dropTable('drop-me');
    engine.close();

    engine = new LsmEngine(dir);
    expect(engine.hasTable('keep')).toBe(true);
    expect(engine.hasTable('drop-me')).toBe(false);
    engine.close();
  });
});

describe('LsmEngine — durability across restart (the whole point of the WAL)', () => {
  it('data written and committed survives a "crash" (no graceful close) and a fresh engine instance over the same directory', () => {
    const engine = new LsmEngine(dir);
    engine.createTable('users');
    const { txn } = engine.beginTransaction();
    engine.getTable('users').insert([1, 'alice'], txn);
    engine.getTable('users').insert([2, 'bob'], txn);
    engine.commit(txn);
    // Deliberately no engine.close() — this is the "crash" the brief asks for.

    const reopened = new LsmEngine(dir);
    const rows = values(reopened, 'users', reopened.currentSnapshot().readTimestamp).sort();
    expect(rows).toEqual([[1, 'alice'], [2, 'bob']].sort());
    reopened.close();
  });

  it('an update committed before the crash is what survives, not the original insert', () => {
    let engine = new LsmEngine(dir);
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['v1'], first.txn);
    engine.commit(first.txn);
    const second = engine.beginTransaction();
    engine.getTable('t').update(id, ['v2'], second.txn);
    engine.commit(second.txn);
    // no close()

    engine = new LsmEngine(dir);
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([['v2']]);
    engine.close();
  });

  it('a transaction left open (never committed or rolled back) at crash time is not visible after restart', () => {
    let engine = new LsmEngine(dir);
    engine.createTable('t');
    const { txn } = engine.beginTransaction();
    engine.getTable('t').insert(['never committed'], txn);
    // no commit, no rollback, no close() — the open transaction "dies" with the crash.

    engine = new LsmEngine(dir);
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([]);
    engine.close();
  });

  it('new writes after a restart continue from the correct row id and commit-timestamp counters (no collisions)', () => {
    let engine = new LsmEngine(dir);
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id1 = engine.getTable('t').insert(['a'], first.txn);
    engine.commit(first.txn);
    engine.close();

    engine = new LsmEngine(dir);
    const second = engine.beginTransaction();
    const id2 = engine.getTable('t').insert(['b'], second.txn);
    engine.commit(second.txn);

    expect(id1).toBe('1');
    expect(id2).toBe('2');
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp).sort()).toEqual([['a'], ['b']].sort());
    engine.close();
  });

  it('SSTables already flushed before the crash are still readable after restart, alongside WAL-replayed memtable data', () => {
    let engine = new LsmEngine(dir, { memtableFlushThreshold: 1 });
    engine.createTable('t');
    const first = engine.beginTransaction();
    engine.getTable('t').insert(['flushed'], first.txn);
    engine.commit(first.txn); // flushes immediately (threshold=1)
    // no close()

    engine = new LsmEngine(dir, { memtableFlushThreshold: 1 });
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([['flushed']]);
    engine.close();
  });

  it('surviving data is correct across multiple tables after a crash', () => {
    let engine = new LsmEngine(dir);
    engine.createTable('a');
    engine.createTable('b');
    const t1 = engine.beginTransaction();
    engine.getTable('a').insert(['a1'], t1.txn);
    engine.getTable('b').insert(['b1'], t1.txn);
    engine.commit(t1.txn);
    // no close()

    engine = new LsmEngine(dir);
    expect(values(engine, 'a', engine.currentSnapshot().readTimestamp)).toEqual([['a1']]);
    expect(values(engine, 'b', engine.currentSnapshot().readTimestamp)).toEqual([['b1']]);
    engine.close();
  });
});

describe('LsmEngine — flush triggered through normal engine usage', () => {
  it('enough committed inserts through the engine trigger at least one real flush to disk', () => {
    const engine = new LsmEngine(dir, { memtableFlushThreshold: 3 });
    engine.createTable('t');
    for (let i = 0; i < 10; i += 1) {
      const { txn } = engine.beginTransaction();
      engine.getTable('t').insert([i], txn);
      engine.commit(txn);
    }
    const tableDir = path.join(dir, 'tables', 't');
    const sstFiles = fs.readdirSync(tableDir).filter((f) => f.endsWith('.sst'));
    expect(sstFiles.length).toBeGreaterThan(0);

    const rows = values(engine, 't', engine.currentSnapshot().readTimestamp)
      .map((r) => r[0] as number)
      .sort((a, b) => a - b);
    expect(rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    engine.close();
  });
});

describe('LsmEngine — compaction end to end', () => {
  it('insert + many updates to the same row, then compactTable, keeps reads correct and shrinks on-disk record count', () => {
    const engine = new LsmEngine(dir, { memtableFlushThreshold: 1 });
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['v0'], first.txn);
    engine.commit(first.txn);

    for (let i = 1; i <= 6; i += 1) {
      const { txn } = engine.beginTransaction();
      engine.getTable('t').update(id, [`v${i}`], txn);
      engine.commit(txn);
    }

    const tableDir = path.join(dir, 'tables', 't');
    const recordCountBefore = fs
      .readdirSync(tableDir)
      .filter((f) => f.endsWith('.sst'))
      .reduce((sum, f) => sum + fs.readFileSync(path.join(tableDir, f), 'utf8').split('\n').filter((l) => l.length > 0).length, 0);
    expect(recordCountBefore).toBe(7); // one flush per commit: v0..v6

    const stats = engine.compactTable('t');
    expect(stats.outputRecordCount).toBeLessThan(stats.inputRecordCount);
    expect(stats.outputRecordCount).toBe(1); // no open transactions: only v6 can possibly be needed

    const recordCountAfter = fs
      .readdirSync(tableDir)
      .filter((f) => f.endsWith('.sst'))
      .reduce((sum, f) => sum + fs.readFileSync(path.join(tableDir, f), 'utf8').split('\n').filter((l) => l.length > 0).length, 0);
    expect(recordCountAfter).toBeLessThan(recordCountBefore);
    expect(recordCountAfter).toBe(1);

    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([['v6']]);
    engine.close();
  });

  it('compaction does not discard a version still needed by a transaction whose snapshot is open at compaction time', () => {
    const engine = new LsmEngine(dir, { memtableFlushThreshold: 1 });
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['v0'], first.txn);
    engine.commit(first.txn);

    const reader = engine.beginTransaction(); // opens a snapshot pinned at v0

    const second = engine.beginTransaction();
    engine.getTable('t').update(id, ['v1'], second.txn);
    engine.commit(second.txn);

    const stats = engine.compactTable('t');
    expect(stats.outputRecordCount).toBe(2); // v0 kept for `reader`, v1 kept as the current version

    expect(values(engine, 't', reader.snapshot.readTimestamp)).toEqual([['v0']]);
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([['v1']]);
    engine.close();
  });

  it('data survives correctly across both a compaction and a subsequent restart', () => {
    let engine = new LsmEngine(dir, { memtableFlushThreshold: 1 });
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['v0'], first.txn);
    engine.commit(first.txn);
    const second = engine.beginTransaction();
    engine.getTable('t').update(id, ['v1'], second.txn);
    engine.commit(second.txn);
    engine.compactTable('t');
    engine.close();

    engine = new LsmEngine(dir, { memtableFlushThreshold: 1 });
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([['v1']]);
    engine.close();
  });
});

describe('LsmEngine — currentSnapshot', () => {
  it('starts at readTimestamp 0 for a brand-new database', () => {
    const engine = new LsmEngine(dir);
    expect(engine.currentSnapshot()).toEqual({ readTimestamp: 0 });
    engine.close();
  });

  it('advances by exactly 1 per commit, regardless of how many rows that commit touched', () => {
    const engine = new LsmEngine(dir);
    engine.createTable('t');
    const { txn } = engine.beginTransaction();
    engine.getTable('t').insert(['a'], txn);
    engine.getTable('t').insert(['b'], txn);
    engine.getTable('t').insert(['c'], txn);
    engine.commit(txn);
    expect(engine.currentSnapshot()).toEqual({ readTimestamp: 1 });
    engine.close();
  });
});
