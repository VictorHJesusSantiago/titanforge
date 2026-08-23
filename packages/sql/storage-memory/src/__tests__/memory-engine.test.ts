import { describe, it, expect } from 'vitest';
import { MemoryStorageEngine } from '../memory-engine.js';

function values(engine: MemoryStorageEngine, table: string, snapshotTs: number): unknown[][] {
  return [...engine.getTable(table).scan({ readTimestamp: snapshotTs })].map((r) => r.values);
}

describe('MemoryStorageEngine — basic CRUD, autocommit style', () => {
  it('inserts are visible only after commit', () => {
    const engine = new MemoryStorageEngine();
    engine.createTable('t');
    const { txn } = engine.beginTransaction();
    engine.getTable('t').insert([1], txn);

    // A snapshot taken before commit sees nothing.
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([]);
    engine.commit(txn);
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([[1]]);
  });

  it('update supersedes the prior version', () => {
    const engine = new MemoryStorageEngine();
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['a'], first.txn);
    engine.commit(first.txn);

    const second = engine.beginTransaction();
    engine.getTable('t').update(id, ['b'], second.txn);
    engine.commit(second.txn);

    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([['b']]);
  });

  it('delete removes a row from later snapshots', () => {
    const engine = new MemoryStorageEngine();
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['a'], first.txn);
    engine.commit(first.txn);

    const second = engine.beginTransaction();
    engine.getTable('t').delete(id, second.txn);
    engine.commit(second.txn);

    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([]);
  });
});

describe('MemoryStorageEngine — MVCC snapshot isolation', () => {
  it('a snapshot taken before an update still sees the old value, even after the update commits', () => {
    const engine = new MemoryStorageEngine();
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['old'], first.txn);
    engine.commit(first.txn);

    const oldSnapshot = engine.currentSnapshot();

    const second = engine.beginTransaction();
    engine.getTable('t').update(id, ['new'], second.txn);
    engine.commit(second.txn);

    // The snapshot taken before the update is untouched by it — this is the entire point of MVCC.
    expect(values(engine, 't', oldSnapshot.readTimestamp)).toEqual([['old']]);
    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([['new']]);
  });

  it('a snapshot taken before a delete still sees the deleted row', () => {
    const engine = new MemoryStorageEngine();
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
  });

  it('an uncommitted write from another (concurrent) transaction is invisible', () => {
    const engine = new MemoryStorageEngine();
    engine.createTable('t');
    const writer = engine.beginTransaction();
    engine.getTable('t').insert(['dirty'], writer.txn);

    const reader = engine.beginTransaction();
    expect(values(engine, 't', reader.snapshot.readTimestamp)).toEqual([]);
    // Still invisible even after the writer commits, because the reader's snapshot was fixed earlier.
    engine.commit(writer.txn);
    expect(values(engine, 't', reader.snapshot.readTimestamp)).toEqual([]);
  });
});

describe('MemoryStorageEngine — rollback', () => {
  it('a rolled-back insert never becomes visible to any snapshot', () => {
    const engine = new MemoryStorageEngine();
    engine.createTable('t');
    const { txn } = engine.beginTransaction();
    engine.getTable('t').insert(['x'], txn);
    engine.rollback(txn);

    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([]);
  });

  it('a rolled-back delete leaves the original row intact', () => {
    const engine = new MemoryStorageEngine();
    engine.createTable('t');
    const first = engine.beginTransaction();
    const id = engine.getTable('t').insert(['x'], first.txn);
    engine.commit(first.txn);

    const second = engine.beginTransaction();
    engine.getTable('t').delete(id, second.txn);
    engine.rollback(second.txn);

    expect(values(engine, 't', engine.currentSnapshot().readTimestamp)).toEqual([['x']]);
  });

  it('committing or rolling back an already-finished transaction throws', () => {
    const engine = new MemoryStorageEngine();
    const { txn } = engine.beginTransaction();
    engine.commit(txn);
    expect(() => engine.commit(txn)).toThrow();
    expect(() => engine.rollback(txn)).toThrow();
  });
});

describe('MemoryStorageEngine — table lifecycle', () => {
  it('createTable rejects a duplicate name; getTable/dropTable reject a missing one', () => {
    const engine = new MemoryStorageEngine();
    engine.createTable('t');
    expect(() => engine.createTable('t')).toThrow();
    expect(() => engine.getTable('nope')).toThrow();
    expect(() => engine.dropTable('nope')).toThrow();
    expect(engine.hasTable('t')).toBe(true);
    engine.dropTable('t');
    expect(engine.hasTable('t')).toBe(false);
  });
});
