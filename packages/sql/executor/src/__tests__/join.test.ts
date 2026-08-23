import { describe, it, expect } from 'vitest';
import { executePlan } from '../executor.js';
import { executeSelect } from '../index.js';
import { rowValues } from '../row.js';
import { makeSchema, planSelect, insertRows, findNode, replaceNode } from './test-helpers.js';
import type { BoundExpr } from '@titanforge/catalog';
import type { PhysicalNestedLoopJoin } from '@titanforge/planner';

function seed() {
  const { catalog, storage } = makeSchema();
  insertRows(storage, 'users', [
    [1, 'Ada', 30],
    [2, 'Grace', 40],
    [3, 'Lonely', 50], // no matching order
  ]);
  insertRows(storage, 'orders', [
    [1, 1, 100],
    [2, 1, 50],
    [3, 2, 75],
  ]);
  return { catalog, storage };
}

describe('nestedLoopJoin — inner', () => {
  it('emits only matching pairs, and the planner picks nestedLoopJoin for a non-equality condition', () => {
    const { catalog, storage } = seed();
    const planned = planSelect(catalog, 'SELECT u.name, o.total FROM users u JOIN orders o ON o.total > u.age');
    expect(findNode(planned.plan, 'nestedLoopJoin')).toBeDefined();
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    // every order's total (100, 50, 75) compared against every user's age (30, 40, 50)
    expect(result.rows.sort()).toEqual(
      [
        ['Ada', 100],
        ['Ada', 50],
        ['Ada', 75],
        ['Grace', 100],
        ['Grace', 50],
        ['Grace', 75],
        ['Lonely', 100],
        ['Lonely', 75],
      ].sort(),
    );
  });
});

describe('nestedLoopJoin — left', () => {
  it('emits every left row at least once, NULL-filling unmatched right columns', () => {
    const { catalog, storage } = seed();
    const planned = planSelect(catalog, 'SELECT u.name, o.total FROM users u LEFT JOIN orders o ON o.total > 1000000');
    expect(findNode(planned.plan, 'nestedLoopJoin')).toBeDefined();
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows.sort()).toEqual(
      [
        ['Ada', null],
        ['Grace', null],
        ['Lonely', null],
      ].sort(),
    );
  });
});

describe('hashJoin — inner', () => {
  it('is chosen for a column-equals-column condition, and matches nestedLoopJoin over the same equality', () => {
    const { catalog, storage } = seed();
    const planned = planSelect(catalog, 'SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id');
    const hashJoin = findNode(planned.plan, 'hashJoin');
    expect(hashJoin).toBeDefined();

    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows.sort()).toEqual(
      [
        ['Ada', 100],
        ['Ada', 50],
        ['Grace', 75],
      ].sort(),
    );

    // Cross-check: swap the hash join for a nested-loop join over the equivalent equality
    // predicate and confirm they produce the same set of rows.
    const on: BoundExpr = { kind: 'binary', op: '=', left: hashJoin.leftKey, right: hashJoin.rightKey, type: 'BOOLEAN' };
    const nestedLoop: PhysicalNestedLoopJoin = { kind: 'nestedLoopJoin', left: hashJoin.left, right: hashJoin.right, joinKind: hashJoin.joinKind, on };
    const swapped = replaceNode(planned.plan, hashJoin, nestedLoop);
    const nestedRows = [...executePlan(swapped, storage, storage.currentSnapshot())].map(rowValues);
    expect(nestedRows.sort()).toEqual(result.rows.sort());
  });
});

describe('hashJoin — left', () => {
  it('NULL-fills an unmatched left row, same as nestedLoopJoin left semantics', () => {
    const { catalog, storage } = seed();
    const planned = planSelect(catalog, 'SELECT u.name, o.total FROM users u LEFT JOIN orders o ON u.id = o.user_id');
    expect(findNode(planned.plan, 'hashJoin')).toBeDefined();
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows.sort()).toEqual(
      [
        ['Ada', 100],
        ['Ada', 50],
        ['Grace', 75],
        ['Lonely', null],
      ].sort(),
    );
  });

  it('a NULL join key never matches anything, even another NULL', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [[1, 'NoOrders', 20]]);
    insertRows(storage, 'orders', [[1, null, 999]]); // user_id NULL
    const planned = planSelect(catalog, 'SELECT u.name, o.total FROM users u LEFT JOIN orders o ON u.id = o.user_id');
    const result = executeSelect(planned, storage, storage.currentSnapshot());
    expect(result.rows).toEqual([['NoOrders', null]]);
  });
});
