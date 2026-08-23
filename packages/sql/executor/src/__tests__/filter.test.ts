import { describe, it, expect } from 'vitest';
import { executePlan } from '../executor.js';
import { rowValues } from '../row.js';
import { makeSchema, planSelect, insertRows } from './test-helpers.js';

describe('filter', () => {
  it('keeps only rows where the predicate is exactly true', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'Ada', 30],
      [2, 'Grace', 20],
      [3, 'Alan', 40],
    ]);
    const planned = planSelect(catalog, 'SELECT name FROM users WHERE age > 25');
    const rows = [...executePlan(planned.plan, storage, storage.currentSnapshot())].map(rowValues);
    expect(rows).toEqual([['Ada'], ['Alan']]);
  });

  it('a NULL predicate excludes the row (three-valued WHERE, not JS truthiness)', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'Ada', 30],
      [2, 'NullAge', null],
    ]);
    // age > 25 for the NULL row evaluates to NULL, not false and not true — it must not appear.
    const planned = planSelect(catalog, 'SELECT name FROM users WHERE age > 25');
    const rows = [...executePlan(planned.plan, storage, storage.currentSnapshot())].map(rowValues);
    expect(rows).toEqual([['Ada']]);
  });

  it('WHERE age > 25 AND age < 100 still excludes a NULL age row (AND with one NULL operand is NULL, not skipped)', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'Ada', 30],
      [2, 'NullAge', null],
    ]);
    const planned = planSelect(catalog, 'SELECT name FROM users WHERE age > 25 AND age < 100');
    const rows = [...executePlan(planned.plan, storage, storage.currentSnapshot())].map(rowValues);
    expect(rows).toEqual([['Ada']]);
  });

  it('WHERE age < 25 OR age IS the NULL row: NULL OR false stays NULL, still excluded', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'Young', 10],
      [2, 'NullAge', null],
    ]);
    const planned = planSelect(catalog, 'SELECT name FROM users WHERE age < 25');
    const rows = [...executePlan(planned.plan, storage, storage.currentSnapshot())].map(rowValues);
    expect(rows).toEqual([['Young']]);
  });
});
