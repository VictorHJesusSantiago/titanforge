import { describe, it, expect } from 'vitest';
import { executeSelect } from '../index.js';
import { makeSchema, planSelect, insertRows } from './test-helpers.js';

describe('project', () => {
  it('evaluates each select item and names it by its alias', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [[1, 'Ada', 30]]);
    const planned = planSelect(catalog, 'SELECT name AS n, age + 1 AS next_age FROM users');
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.columns).toEqual(['n', 'next_age']);
    expect(result.rows).toEqual([['Ada', 31]]);
  });

  it('SELECT * expands to every column in FROM order', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [[1, 'Ada', 30]]);
    const planned = planSelect(catalog, 'SELECT * FROM users');
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.columns).toEqual(['id', 'name', 'age']);
    expect(result.rows).toEqual([[1, 'Ada', 30]]);
  });
});
