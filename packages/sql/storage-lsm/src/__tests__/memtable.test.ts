import { describe, expect, it } from 'vitest';
import { Memtable } from '../memtable.js';

describe('Memtable — pending writes are invisible until finalized', () => {
  it('a pending (uncommitted) write has createdAt undefined and is excluded from committedVersions', () => {
    const m = new Memtable();
    m.writePending('1', ['a'], 1);
    expect(m.committedVersions()).toEqual([]);
    expect(m.committedCount()).toBe(0);
    expect(m.allVersions()).toEqual([{ id: '1', values: ['a'], createdAt: undefined, createdTxn: 1 }]);
  });

  it('finalizeCommit stamps createdAt only for the given txn, leaving others pending', () => {
    const m = new Memtable();
    m.writePending('1', ['a'], 1);
    m.writePending('2', ['b'], 2);
    m.finalizeCommit(1, 100);

    expect(m.committedVersions()).toEqual([{ id: '1', values: ['a'], createdAt: 100, createdTxn: 1 }]);
    expect(m.committedCount()).toBe(1);
  });

  it('finalizeCommit is a no-op for a txn that never wrote anything to this table', () => {
    const m = new Memtable();
    m.writePending('1', ['a'], 1);
    m.finalizeCommit(999, 5);
    expect(m.committedVersions()).toEqual([]);
  });

  it('finalizeCommit does not re-stamp an already-finalized version', () => {
    const m = new Memtable();
    m.writePending('1', ['a'], 1);
    m.finalizeCommit(1, 10);
    m.finalizeCommit(1, 20); // e.g. called again defensively; must not overwrite
    expect(m.committedVersions()[0]!.createdAt).toBe(10);
  });
});

describe('Memtable — deletes are tombstones', () => {
  it('deletePending records values: null', () => {
    const m = new Memtable();
    m.deletePending('1', 1);
    m.finalizeCommit(1, 5);
    expect(m.committedVersions()).toEqual([{ id: '1', values: null, createdAt: 5, createdTxn: 1 }]);
  });
});

describe('Memtable — discardTransaction (rollback)', () => {
  it('removes only the pending versions written by the given txn', () => {
    const m = new Memtable();
    m.writePending('1', ['a'], 1);
    m.writePending('2', ['b'], 2);
    m.discardTransaction(1);
    expect(m.allVersions()).toEqual([{ id: '2', values: ['b'], createdAt: undefined, createdTxn: 2 }]);
  });

  it('does not touch a version already finalized under the same txn id (defensive: should never be called after commit, but must not corrupt committed data if it is)', () => {
    const m = new Memtable();
    m.writePending('1', ['a'], 1);
    m.finalizeCommit(1, 5);
    m.discardTransaction(1);
    expect(m.committedVersions()).toEqual([{ id: '1', values: ['a'], createdAt: 5, createdTxn: 1 }]);
  });

  it('discarding a txn with no pending writes is a harmless no-op', () => {
    const m = new Memtable();
    m.writePending('1', ['a'], 1);
    m.discardTransaction(999);
    expect(m.allVersions()).toHaveLength(1);
  });
});

describe('Memtable — multiple versions of one id can coexist before flush', () => {
  it('insert then update before commit both sit in the memtable as separate versions', () => {
    const m = new Memtable();
    m.writePending('1', ['old'], 1);
    m.writePending('1', ['new'], 1);
    expect(m.allVersions()).toHaveLength(2);
  });
});

describe('Memtable — removeFlushed', () => {
  it('removes exactly the given versions by identity, keeping everything else', () => {
    const m = new Memtable();
    m.writePending('1', ['a'], 1);
    m.writePending('2', ['b'], 2);
    m.finalizeCommit(1, 10);
    m.finalizeCommit(2, 20);

    const flushed = [m.committedVersions()[0]!]; // just the version for id '1'
    m.removeFlushed(flushed);

    expect(m.allVersions()).toEqual([{ id: '2', values: ['b'], createdAt: 20, createdTxn: 2 }]);
  });

  it('leaves still-pending (uncommitted) versions alone even if they share a row id with a flushed version', () => {
    const m = new Memtable();
    m.writePending('1', ['old'], 1);
    m.finalizeCommit(1, 10);
    m.writePending('1', ['new'], 2); // update, still pending

    const flushed = m.committedVersions();
    m.removeFlushed(flushed);

    expect(m.allVersions()).toEqual([{ id: '1', values: ['new'], createdAt: undefined, createdTxn: 2 }]);
  });
});
