import { describe, it, expect } from 'vitest';
import { Catalog, CatalogError } from '../catalog.js';

const cols = [
  { name: 'id', type: 'INTEGER' as const, primaryKey: true, notNull: false },
  { name: 'name', type: 'TEXT' as const, primaryKey: false, notNull: true },
];

describe('Catalog', () => {
  it('creates a table and assigns column ordinals in declared order', () => {
    const catalog = new Catalog();
    const schema = catalog.createTable('users', cols, false);
    expect(schema?.columns.map((c) => c.ordinal)).toEqual([0, 1]);
  });

  it('a primary key column is implicitly NOT NULL', () => {
    const catalog = new Catalog();
    const schema = catalog.createTable('users', cols, false)!;
    expect(schema.columns[0]?.notNull).toBe(true);
  });

  it('rejects creating a table that already exists', () => {
    const catalog = new Catalog();
    catalog.createTable('t', cols, false);
    expect(() => catalog.createTable('t', cols, false)).toThrow(CatalogError);
  });

  it('IF NOT EXISTS silently no-ops instead of throwing, returning undefined', () => {
    const catalog = new Catalog();
    catalog.createTable('t', cols, false);
    expect(catalog.createTable('t', cols, true)).toBeUndefined();
  });

  it('rejects duplicate column names', () => {
    const catalog = new Catalog();
    expect(() =>
      catalog.createTable('t', [{ name: 'a', type: 'INTEGER', primaryKey: false, notNull: false }, { name: 'a', type: 'TEXT', primaryKey: false, notNull: false }], false),
    ).toThrow(CatalogError);
  });

  it('rejects more than one PRIMARY KEY column', () => {
    const catalog = new Catalog();
    expect(() =>
      catalog.createTable(
        't',
        [
          { name: 'a', type: 'INTEGER', primaryKey: true, notNull: false },
          { name: 'b', type: 'INTEGER', primaryKey: true, notNull: false },
        ],
        false,
      ),
    ).toThrow(CatalogError);
  });

  it('getTable throws for a missing table, tryGetTable returns undefined', () => {
    const catalog = new Catalog();
    expect(() => catalog.getTable('nope')).toThrow(CatalogError);
    expect(catalog.tryGetTable('nope')).toBeUndefined();
  });

  it('dropTable removes a table; IF EXISTS silently tolerates a missing one', () => {
    const catalog = new Catalog();
    catalog.createTable('t', cols, false);
    catalog.dropTable('t', false);
    expect(catalog.hasTable('t')).toBe(false);
    expect(() => catalog.dropTable('nope', false)).toThrow(CatalogError);
    expect(() => catalog.dropTable('nope', true)).not.toThrow();
  });

  it('listTables returns every created table', () => {
    const catalog = new Catalog();
    catalog.createTable('a', cols, false);
    catalog.createTable('b', cols, false);
    expect(catalog.listTables().map((t) => t.name).sort()).toEqual(['a', 'b']);
  });
});
