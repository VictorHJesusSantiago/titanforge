import { describe, it, expect } from 'vitest';
import { executeSelect } from '../index.js';
import { makeSchema, planSelect, insertRows } from './test-helpers.js';

describe('sort', () => {
  it('orders ASC and DESC', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'Ada', 30],
      [2, 'Grace', 20],
      [3, 'Alan', 40],
    ]);
    const asc = executeSelect(planSelect(catalog, 'SELECT name FROM users ORDER BY age ASC'), storage, storage.currentSnapshot());
    expect(asc.rows).toEqual([['Grace'], ['Ada'], ['Alan']]);

    const desc = executeSelect(planSelect(catalog, 'SELECT name FROM users ORDER BY age DESC'), storage, storage.currentSnapshot());
    expect(desc.rows).toEqual([['Alan'], ['Ada'], ['Grace']]);
  });

  it('NULLs sort last in both ASC and DESC (documented choice)', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'HasAge', 10],
      [2, 'NoAge', null],
    ]);
    const asc = executeSelect(planSelect(catalog, 'SELECT name FROM users ORDER BY age ASC'), storage, storage.currentSnapshot());
    expect(asc.rows).toEqual([['HasAge'], ['NoAge']]);

    const desc = executeSelect(planSelect(catalog, 'SELECT name FROM users ORDER BY age DESC'), storage, storage.currentSnapshot());
    expect(desc.rows).toEqual([['HasAge'], ['NoAge']]);
  });

  it('multi-key ORDER BY a, b breaks ties on the second key', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'Bob', 30],
      [2, 'Ada', 30],
      [3, 'Zeta', 20],
    ]);
    const result = executeSelect(planSelect(catalog, 'SELECT name FROM users ORDER BY age ASC, name ASC'), storage, storage.currentSnapshot());
    expect(result.rows).toEqual([['Zeta'], ['Ada'], ['Bob']]);
  });

  it('is stable: rows with equal sort keys keep their relative (scan) order', () => {
    const { catalog, storage } = makeSchema();
    // All three rows share age=30 — inserted in this id order; a stable sort on age alone must
    // preserve this exact relative order in the output.
    insertRows(storage, 'users', [
      [5, 'Five', 30],
      [3, 'Three', 30],
      [1, 'One', 30],
    ]);
    const result = executeSelect(planSelect(catalog, 'SELECT id FROM users ORDER BY age ASC'), storage, storage.currentSnapshot());
    expect(result.rows).toEqual([[5], [3], [1]]);
  });
});
