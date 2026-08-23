import { parseStatement } from '@titanforge/parser';
import { Binder, Catalog, type BoundSelect, type BoundStatement } from '@titanforge/catalog';

export function makeCatalog(): Catalog {
  const catalog = new Catalog();
  catalog.createTable(
    'users',
    [
      { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
      { name: 'name', type: 'TEXT', primaryKey: false, notNull: true },
      { name: 'age', type: 'INTEGER', primaryKey: false, notNull: false },
    ],
    false,
  );
  catalog.createTable(
    'orders',
    [
      { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
      { name: 'user_id', type: 'INTEGER', primaryKey: false, notNull: false },
      { name: 'total', type: 'REAL', primaryKey: false, notNull: false },
    ],
    false,
  );
  return catalog;
}

export function bind(catalog: Catalog, sql: string): BoundStatement {
  return new Binder(catalog).bind(parseStatement(sql));
}

export function bindSelect(catalog: Catalog, sql: string): BoundSelect {
  return bind(catalog, sql) as BoundSelect;
}
