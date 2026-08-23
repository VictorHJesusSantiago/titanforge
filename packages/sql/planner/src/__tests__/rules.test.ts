import { describe, it, expect } from 'vitest';
import { buildLogicalPlan } from '../build.js';
import { optimize } from '../rules.js';
import type { LogicalFilter, LogicalJoin, LogicalScan } from '../logical-plan.js';
import { makeCatalog, bindSelect } from './test-helpers.js';

describe('predicate pushdown', () => {
  it('pushes a single-side conjunct down into a filter directly under that side\'s scan', () => {
    const catalog = makeCatalog();
    const select = bindSelect(catalog, 'SELECT * FROM users JOIN orders ON users.id = orders.user_id WHERE users.age > 18');
    const optimized = optimize(buildLogicalPlan(select));

    // project -> join(filter(scan users), scan orders) — the filter moved below the join.
    const project = optimized as { kind: 'project'; input: LogicalJoin };
    expect(project.input.kind).toBe('join');
    expect(project.input.left).toMatchObject({ kind: 'filter', input: { kind: 'scan', alias: 'users' } });
    expect(project.input.right).toMatchObject({ kind: 'scan', alias: 'orders' });
  });

  it('splits an AND predicate and pushes each conjunct to its own side', () => {
    const catalog = makeCatalog();
    const select = bindSelect(
      catalog,
      'SELECT * FROM users JOIN orders ON users.id = orders.user_id WHERE users.age > 18 AND orders.total > 100',
    );
    const optimized = optimize(buildLogicalPlan(select));
    const project = optimized as { kind: 'project'; input: LogicalJoin };
    expect(project.input.left).toMatchObject({ kind: 'filter', input: { kind: 'scan', alias: 'users' } });
    expect(project.input.right).toMatchObject({ kind: 'filter', input: { kind: 'scan', alias: 'orders' } });
  });

  it('a conjunct referencing both sides stays above the join, not pushed to either side', () => {
    const catalog = makeCatalog();
    const select = bindSelect(catalog, 'SELECT * FROM users JOIN orders ON users.id = orders.user_id WHERE users.age > orders.total');
    const optimized = optimize(buildLogicalPlan(select));
    const project = optimized as { kind: 'project'; input: LogicalFilter };
    expect(project.input.kind).toBe('filter');
    expect(project.input.input.kind).toBe('join');
  });

  it('never pushes a predicate into the right side of a LEFT JOIN', () => {
    const catalog = makeCatalog();
    const select = bindSelect(
      catalog,
      'SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id WHERE orders.total > 100',
    );
    const optimized = optimize(buildLogicalPlan(select));
    // The right-side-only conjunct must remain above the join (as a filter), not be pushed into orders' scan.
    const project = optimized as { kind: 'project'; input: LogicalFilter };
    expect(project.input.kind).toBe('filter');
    expect(project.input.input).toMatchObject({ kind: 'join', joinKind: 'left', right: { kind: 'scan' } });
  });

  it('still pushes a left-side-only predicate into a LEFT JOIN\'s left side', () => {
    const catalog = makeCatalog();
    const select = bindSelect(catalog, 'SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id WHERE users.age > 18');
    const optimized = optimize(buildLogicalPlan(select));
    const project = optimized as { kind: 'project'; input: LogicalJoin };
    expect(project.input.left).toMatchObject({ kind: 'filter', input: { kind: 'scan', alias: 'users' } });
  });

  it('a query with no WHERE clause at all is left with no filter node', () => {
    const catalog = makeCatalog();
    const optimized = optimize(buildLogicalPlan(bindSelect(catalog, 'SELECT * FROM users')));
    expect(optimized).toMatchObject({ kind: 'project', input: { kind: 'scan' } });
  });
});

describe('projection pushdown', () => {
  it('narrows a scan to exactly the columns referenced in SELECT and WHERE', () => {
    const catalog = makeCatalog();
    const optimized = optimize(buildLogicalPlan(bindSelect(catalog, 'SELECT name FROM users WHERE age > 18')));
    const project = optimized as { kind: 'project'; input: LogicalFilter };
    const scan = project.input.input as LogicalScan;
    expect(scan.columns).toEqual(['age', 'name']);
  });

  it('a join narrows each side independently, by that side\'s own alias', () => {
    const catalog = makeCatalog();
    const optimized = optimize(
      buildLogicalPlan(bindSelect(catalog, 'SELECT users.name, orders.total FROM users JOIN orders ON users.id = orders.user_id')),
    );
    const project = optimized as { kind: 'project'; input: LogicalJoin };
    const usersScan = project.input.left as LogicalScan;
    const ordersScan = project.input.right as LogicalScan;
    expect(usersScan.columns).toEqual(['id', 'name']); // id: needed by the join condition
    expect(ordersScan.columns).toEqual(['total', 'user_id']);
  });

  it('SELECT * still narrows to (all) explicitly-named columns rather than leaving columns undefined', () => {
    const catalog = makeCatalog();
    const optimized = optimize(buildLogicalPlan(bindSelect(catalog, 'SELECT * FROM users')));
    const project = optimized as { kind: 'project'; input: LogicalScan };
    expect(project.input.columns).toEqual(['age', 'id', 'name']);
  });

  it('a column used only in GROUP BY / an aggregate argument is still counted as required', () => {
    const catalog = makeCatalog();
    const optimized = optimize(buildLogicalPlan(bindSelect(catalog, 'SELECT age, SUM(age) FROM users GROUP BY age')));
    const project = optimized as { kind: 'project'; input: { kind: 'aggregate'; input: LogicalScan } };
    expect(project.input.input.columns).toEqual(['age']);
  });
});
