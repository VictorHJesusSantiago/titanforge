import { describe, it, expect } from 'vitest';
import { buildLogicalPlan } from '../build.js';
import { makeCatalog, bindSelect } from './test-helpers.js';

describe('buildLogicalPlan', () => {
  it('a bare SELECT with no FROM produces a singleRow source', () => {
    const catalog = makeCatalog();
    const plan = buildLogicalPlan(bindSelect(catalog, 'SELECT 1 + 1'));
    expect(plan).toMatchObject({ kind: 'project', input: { kind: 'singleRow' } });
  });

  it('SELECT ... FROM t produces project(scan)', () => {
    const catalog = makeCatalog();
    const plan = buildLogicalPlan(bindSelect(catalog, 'SELECT name FROM users'));
    expect(plan).toMatchObject({ kind: 'project', input: { kind: 'scan', alias: 'users' } });
  });

  it('a WHERE clause inserts a filter directly above the scan', () => {
    const catalog = makeCatalog();
    const plan = buildLogicalPlan(bindSelect(catalog, 'SELECT name FROM users WHERE age > 18'));
    expect(plan).toMatchObject({ kind: 'project', input: { kind: 'filter', input: { kind: 'scan' } } });
  });

  it('a JOIN wraps scans in a join node before any filter', () => {
    const catalog = makeCatalog();
    const plan = buildLogicalPlan(bindSelect(catalog, 'SELECT * FROM users JOIN orders ON users.id = orders.user_id WHERE age > 18'));
    expect(plan).toMatchObject({
      kind: 'project',
      input: { kind: 'filter', input: { kind: 'join', left: { kind: 'scan', alias: 'users' }, right: { kind: 'scan', alias: 'orders' } } },
    });
  });

  it('an aggregate query inserts an aggregate node below the project', () => {
    const catalog = makeCatalog();
    const plan = buildLogicalPlan(bindSelect(catalog, 'SELECT COUNT(*) FROM users'));
    expect(plan).toMatchObject({ kind: 'project', input: { kind: 'aggregate' } });
  });

  it('DISTINCT, ORDER BY, and LIMIT stack above the projection in that order', () => {
    const catalog = makeCatalog();
    const plan = buildLogicalPlan(bindSelect(catalog, 'SELECT DISTINCT name FROM users ORDER BY name LIMIT 5'));
    expect(plan).toMatchObject({
      kind: 'limit',
      limit: 5,
      input: { kind: 'sort', input: { kind: 'distinct', input: { kind: 'project' } } },
    });
  });

  it('collects every distinct aggregate call once, even if referenced twice', () => {
    const catalog = makeCatalog();
    const plan = buildLogicalPlan(bindSelect(catalog, 'SELECT COUNT(*), COUNT(*) FROM users'));
    expect(plan.kind).toBe('project');
    if (plan.kind !== 'project') throw new Error('unreachable');
    expect(plan.input).toMatchObject({ kind: 'aggregate', aggregates: [{ name: 'COUNT' }] });
  });
});
