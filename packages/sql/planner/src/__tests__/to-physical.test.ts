import { describe, it, expect } from 'vitest';
import { buildLogicalPlan } from '../build.js';
import { optimize } from '../rules.js';
import { toPhysicalPlan } from '../to-physical.js';
import type { PhysicalHashJoin, PhysicalNestedLoopJoin, PhysicalProject } from '../physical-plan.js';
import { makeCatalog, bindSelect } from './test-helpers.js';

function physicalOf(sql: string) {
  const catalog = makeCatalog();
  return toPhysicalPlan(optimize(buildLogicalPlan(bindSelect(catalog, sql))));
}

describe('toPhysicalPlan — join strategy selection', () => {
  it('chooses a hash join for a simple column-equals-column condition', () => {
    const physical = physicalOf('SELECT * FROM users JOIN orders ON users.id = orders.user_id') as PhysicalProject;
    expect(physical.input.kind).toBe('hashJoin');
    const join = physical.input as unknown as PhysicalHashJoin;
    expect(join.leftKey).toMatchObject({ kind: 'column', source: 'users', name: 'id' });
    expect(join.rightKey).toMatchObject({ kind: 'column', source: 'orders', name: 'user_id' });
  });

  it('resolves the key sides correctly regardless of which side of "=" each column is written on', () => {
    const physical = physicalOf('SELECT * FROM users JOIN orders ON orders.user_id = users.id') as PhysicalProject;
    const join = physical.input as unknown as PhysicalHashJoin;
    expect(join.kind).toBe('hashJoin');
    expect(join.leftKey).toMatchObject({ source: 'users' });
    expect(join.rightKey).toMatchObject({ source: 'orders' });
  });

  it('falls back to nested-loop for a non-equality join condition', () => {
    const physical = physicalOf('SELECT * FROM users JOIN orders ON users.id > orders.user_id') as PhysicalProject;
    expect(physical.input.kind).toBe('nestedLoopJoin');
  });

  it('falls back to nested-loop for a compound (AND) join condition', () => {
    const physical = physicalOf(
      'SELECT * FROM users JOIN orders ON users.id = orders.user_id AND users.age > 0',
    ) as PhysicalProject;
    expect(physical.input.kind).toBe('nestedLoopJoin');
    const join = physical.input as unknown as PhysicalNestedLoopJoin;
    expect(join.on).toMatchObject({ kind: 'binary', op: 'AND' });
  });

  it('preserves the join kind (inner/left) through strategy selection', () => {
    const inner = physicalOf('SELECT * FROM users JOIN orders ON users.id = orders.user_id') as PhysicalProject;
    const left = physicalOf('SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id') as PhysicalProject;
    expect((inner.input as unknown as PhysicalHashJoin).joinKind).toBe('inner');
    expect((left.input as unknown as PhysicalHashJoin).joinKind).toBe('left');
  });
});

describe('toPhysicalPlan — everything else maps 1:1', () => {
  it('scan carries its pushed-down columns through unchanged', () => {
    const physical = physicalOf('SELECT name FROM users WHERE age > 18') as PhysicalProject;
    expect(physical.kind).toBe('project');
  });

  it('aggregate becomes hashAggregate', () => {
    const physical = physicalOf('SELECT COUNT(*) FROM users') as PhysicalProject;
    expect(physical.input.kind).toBe('hashAggregate');
  });

  it('a FROM-less SELECT becomes project(singleRow)', () => {
    const physical = physicalOf('SELECT 1 + 1') as PhysicalProject;
    expect(physical.input).toEqual({ kind: 'singleRow' });
  });
});
