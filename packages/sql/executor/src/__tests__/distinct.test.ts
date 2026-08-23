import { describe, it, expect } from 'vitest';
import { executeSelect } from '../index.js';
import { makeSchema, planSelect, insertRows } from './test-helpers.js';

describe('distinct', () => {
  it('deduplicates rows with identical projected values', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'Ada', 30],
      [2, 'Grace', 30],
      [3, 'Alan', 40],
    ]);
    const planned = planSelect(catalog, 'SELECT DISTINCT age FROM users ORDER BY age');
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows).toEqual([[30], [40]]);
  });

  it('keeps rows that differ in any projected column', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'Ada', 30],
      [2, 'Ada', 40],
    ]);
    const planned = planSelect(catalog, 'SELECT DISTINCT name, age FROM users ORDER BY age');
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows).toEqual([
      ['Ada', 30],
      ['Ada', 40],
    ]);
  });
});
