import { describe, it, expect } from 'vitest';
import { parseStatement } from '@titanforge/parser';
import { Binder } from '@titanforge/catalog';
import { plan } from '../plan.js';
import type { PhysicalFilter, PhysicalSeqScan } from '../physical-plan.js';
import { makeCatalog, bind } from './test-helpers.js';

describe('plan — SELECT', () => {
  it('produces a select plan with the resolved output column aliases', () => {
    const catalog = makeCatalog();
    const planned = plan(bind(catalog, 'SELECT name AS n, age FROM users'));
    expect(planned).toMatchObject({ kind: 'select', outputColumns: ['n', 'age'] });
  });
});

describe('plan — INSERT', () => {
  it('carries the resolved table, columns, and bound values through untouched', () => {
    const catalog = makeCatalog();
    const planned = plan(bind(catalog, `INSERT INTO users (id, name) VALUES (1, 'Ada')`));
    expect(planned.kind).toBe('insert');
    if (planned.kind !== 'insert') throw new Error('unreachable');
    expect(planned.table.name).toBe('users');
    expect(planned.columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(planned.values).toHaveLength(1);
  });
});

describe('plan — UPDATE / DELETE', () => {
  it('UPDATE with a WHERE clause plans a filter-over-scan, with every column materialized (no projection pushdown)', () => {
    const catalog = makeCatalog();
    const planned = plan(bind(catalog, 'UPDATE users SET age = 31 WHERE id = 1'));
    expect(planned.kind).toBe('update');
    if (planned.kind !== 'update') throw new Error('unreachable');
    expect(planned.scan.kind).toBe('filter');
    const scan = (planned.scan as PhysicalFilter).input as PhysicalSeqScan;
    expect(scan.kind).toBe('seqScan');
    // The critical regression this guards: pruning to only `id` (the WHERE column) would lose
    // `name`/`age`'s current values, which the executor needs to write a complete row back.
    expect(scan.columns).toBeUndefined();
  });

  it('UPDATE with no WHERE plans a bare scan (every row)', () => {
    const catalog = makeCatalog();
    const planned = plan(bind(catalog, 'UPDATE users SET age = 0'));
    if (planned.kind !== 'update') throw new Error('unreachable');
    expect(planned.scan.kind).toBe('seqScan');
  });

  it('DELETE plans a filter-over-scan the same way', () => {
    const catalog = makeCatalog();
    const planned = plan(bind(catalog, 'DELETE FROM users WHERE age < 18'));
    if (planned.kind !== 'delete') throw new Error('unreachable');
    expect(planned.scan.kind).toBe('filter');
    expect(((planned.scan as PhysicalFilter).input as PhysicalSeqScan).columns).toBeUndefined();
  });
});

describe('plan — DDL', () => {
  it('CREATE TABLE carries the new TableSchema through', () => {
    const catalog = makeCatalog();
    const planned = plan(bind(catalog, 'CREATE TABLE t (a INTEGER)'));
    expect(planned).toMatchObject({ kind: 'createTable', table: { name: 't' } });
  });

  it('DROP TABLE carries the table name and ifExists flag through', () => {
    const catalog = makeCatalog();
    const planned = plan(bind(catalog, 'DROP TABLE IF EXISTS users'));
    expect(planned).toEqual({ kind: 'dropTable', table: 'users', ifExists: true });
  });
});

describe('plan — Binder is reused correctly across statements', () => {
  it('a table created by one bound statement is visible to the next', () => {
    const catalog = makeCatalog();
    const binder = new Binder(catalog);
    binder.bind(parseStatement('CREATE TABLE t (a INTEGER)'));
    const planned = plan(binder.bind(parseStatement('SELECT a FROM t')));
    expect(planned.kind).toBe('select');
  });
});
