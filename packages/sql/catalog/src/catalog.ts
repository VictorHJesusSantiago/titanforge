import type { ColumnDef } from '@titanforge/parser';
import type { ColumnSchema, TableSchema } from './schema.js';

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

/**
 * The in-memory table registry every layer above the storage engine consults: the binder to
 * resolve names, the planner to know what indexes/columns exist, the executor to know a row's
 * shape. Persistence of the catalog itself (surviving a restart) is `engine`'s job — replaying
 * `CREATE TABLE` statements from the WAL is what rebuilds this from scratch on open, the same way
 * every other piece of committed state is recovered.
 */
export class Catalog {
  private readonly tables = new Map<string, TableSchema>();

  createTable(name: string, columns: ColumnDef[], ifNotExists: boolean): TableSchema | undefined {
    if (this.tables.has(name)) {
      if (ifNotExists) return undefined;
      throw new CatalogError(`table "${name}" already exists`);
    }

    const seen = new Set<string>();
    for (const col of columns) {
      if (seen.has(col.name)) throw new CatalogError(`duplicate column "${col.name}" in table "${name}"`);
      seen.add(col.name);
    }
    const primaryKeys = columns.filter((c) => c.primaryKey);
    if (primaryKeys.length > 1) {
      throw new CatalogError(`table "${name}" declares more than one PRIMARY KEY column`);
    }

    const schema: TableSchema = {
      name,
      columns: columns.map((c, ordinal): ColumnSchema => ({
        name: c.name,
        type: c.type,
        primaryKey: c.primaryKey,
        notNull: c.notNull || c.primaryKey, // a primary key is implicitly NOT NULL
        ordinal,
      })),
    };
    this.tables.set(name, schema);
    return schema;
  }

  dropTable(name: string, ifExists: boolean): void {
    if (!this.tables.has(name)) {
      if (ifExists) return;
      throw new CatalogError(`table "${name}" does not exist`);
    }
    this.tables.delete(name);
  }

  getTable(name: string): TableSchema {
    const table = this.tables.get(name);
    if (table === undefined) throw new CatalogError(`table "${name}" does not exist`);
    return table;
  }

  tryGetTable(name: string): TableSchema | undefined {
    return this.tables.get(name);
  }

  hasTable(name: string): boolean {
    return this.tables.has(name);
  }

  listTables(): TableSchema[] {
    return [...this.tables.values()];
  }
}
