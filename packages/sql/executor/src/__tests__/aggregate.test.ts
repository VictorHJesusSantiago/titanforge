import { describe, it, expect } from 'vitest';
import { executeSelect } from '../index.js';
import { makeSchema, planSelect, insertRows } from './test-helpers.js';

describe('hashAggregate — no GROUP BY', () => {
  it('COUNT(*) over an empty table is 0, not zero rows', () => {
    const { catalog, storage } = makeSchema();
    const planned = planSelect(catalog, 'SELECT COUNT(*) AS c FROM users');
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows).toEqual([[0]]);
  });

  it('COUNT(*) counts rows including NULLs; COUNT(col) skips NULLs', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'Ada', 30],
      [2, 'Grace', null],
      [3, 'Alan', null],
    ]);
    const planned = planSelect(catalog, 'SELECT COUNT(*) AS all_rows, COUNT(age) AS with_age FROM users');
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows).toEqual([[3, 1]]);
  });

  it('SUM of an all-NULL group is 0 (documented choice); AVG of an all-NULL group is NULL', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'A', null],
      [2, 'B', null],
    ]);
    const planned = planSelect(catalog, 'SELECT SUM(age) AS s, AVG(age) AS a FROM users');
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows).toEqual([[0, null]]);
  });

  it('SUM / AVG / MIN / MAX skip NULLs among real values', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'A', 10],
      [2, 'B', null],
      [3, 'C', 30],
    ]);
    const planned = planSelect(catalog, 'SELECT SUM(age) AS s, AVG(age) AS a, MIN(age) AS mn, MAX(age) AS mx FROM users');
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows).toEqual([[40, 20, 10, 30]]);
  });

  it('MIN/MAX over an empty table is NULL', () => {
    const { catalog, storage } = makeSchema();
    const planned = planSelect(catalog, 'SELECT MIN(age) AS mn, MAX(age) AS mx FROM users');
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows).toEqual([[null, null]]);
  });
});

describe('hashAggregate — GROUP BY', () => {
  it('groups rows and computes one aggregate per group; an empty table with GROUP BY yields zero groups', () => {
    const { catalog, storage } = makeSchema();
    const planned = planSelect(catalog, 'SELECT age, COUNT(*) AS c FROM users GROUP BY age');
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows).toHaveLength(0);
  });

  it('multiple groups with distinct aggregate values', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'Ada', 30],
      [2, 'Grace', 30],
      [3, 'Alan', 40],
    ]);
    const planned = planSelect(catalog, 'SELECT age, COUNT(*) AS c FROM users GROUP BY age ORDER BY age');
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows).toEqual([
      [30, 2],
      [40, 1],
    ]);
  });
});
