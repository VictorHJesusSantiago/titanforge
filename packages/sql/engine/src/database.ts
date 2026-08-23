import { parseScript, parseStatement, type Statement } from '@titanforge/parser';
import { Binder, Catalog, type TableSchema } from '@titanforge/catalog';
import type { DataType } from '@titanforge/parser';
import { plan } from '@titanforge/planner';
import { evaluate, executeSelect, matchingTableRows, type TableFrame } from '@titanforge/executor';
import type { Snapshot, SqlValue, StorageEngine, TransactionId } from '@titanforge/storage-api';
import type { QueryResult } from './query-result.js';

/**
 * A reserved system table, stored through the very same `StorageEngine` every user table goes
 * through — not a separate file, not a new concept `storage-api` has to know about. One row per
 * column: `(table_name, ordinal, column_name, type, primary_key, not_null)`. This is the fix for
 * a real gap: `@titanforge/storage-api` is deliberately schema-agnostic (a `StorageEngine` only
 * ever sees `SqlValue[]` tuples, never a column's name or type), which means table *existence*
 * survives a restart (the storage layer tracks that on its own) but table *shape* does not,
 * unless something durable records it. Real embedded databases solve this the same way —
 * SQLite's `sqlite_master` is exactly this table, stored as ordinary rows in the same file every
 * other table lives in.
 */
const SCHEMA_TABLE_NAME = '__titanforge_schema__';
const SCHEMA_COLUMNS = ['table_name', 'ordinal', 'column_name', 'type', 'primary_key', 'not_null'] as const;

/** A handle into an in-flight transaction — the only place `BEGIN`/`COMMIT`/`ROLLBACK`-equivalent behavior lives, since the SQL grammar itself has no such statements (see the parser's own doc comment). */
export interface TransactionHandle {
  /** Runs one statement against this transaction's fixed snapshot (repeatable-read: every read inside a transaction sees the same snapshot, taken once at `transaction()`'s start) and its writes. */
  execute(sql: string): QueryResult;
}

interface WriteContext {
  txn: TransactionId;
  snapshot: Snapshot;
}

/**
 * Ties `Catalog` + `Binder` + `@titanforge/planner`'s `plan()` + `@titanforge/executor` +
 * a caller-supplied `StorageEngine` into the one object an application actually talks to.
 * Owns its own `Catalog` and keeps it in sync with `CREATE TABLE`/`DROP TABLE` — `Binder` itself
 * already mutates the catalog on `CREATE TABLE` (see `Binder.bindCreateTable`), but *not* on
 * `DROP TABLE` (see `Binder.bindDropTable`, which only validates), so `Database` is the one place
 * that asymmetry gets reconciled with a matching `storage` mutation for both.
 */
export class Database {
  private readonly catalog = new Catalog();
  private readonly binder: Binder;

  constructor(private readonly storage: StorageEngine) {
    this.binder = new Binder(this.catalog);
    this.bootstrapSchema();
  }

  /**
   * Runs once, in the constructor: if the schema table doesn't exist yet, this is a brand-new
   * database and there's nothing to recover. If it does, this `StorageEngine` has been opened
   * before (possibly by a prior process — this is exactly what makes `CREATE TABLE` + data
   * survive a real restart through the LSM engine, not just the row data) — read every recorded
   * column back and replay `catalog.createTable` for each table, in ordinal order, so this
   * fresh `Catalog` matches what was durably recorded before this `Database` even existed.
   */
  private bootstrapSchema(): void {
    if (!this.storage.hasTable(SCHEMA_TABLE_NAME)) {
      this.storage.createTable(SCHEMA_TABLE_NAME);
      return;
    }

    const rows = [...this.storage.getTable(SCHEMA_TABLE_NAME).scan(this.storage.currentSnapshot())];
    const byTable = new Map<string, Array<{ ordinal: number; name: string; type: DataType; primaryKey: boolean; notNull: boolean }>>();
    for (const row of rows) {
      const [tableName, ordinal, columnName, type, primaryKey, notNull] = row.values as [string, number, string, DataType, boolean, boolean];
      let cols = byTable.get(tableName);
      if (cols === undefined) {
        cols = [];
        byTable.set(tableName, cols);
      }
      cols.push({ ordinal, name: columnName, type, primaryKey, notNull });
    }

    for (const [tableName, cols] of byTable) {
      cols.sort((a, b) => a.ordinal - b.ordinal);
      this.catalog.createTable(
        tableName,
        cols.map((c) => ({ name: c.name, type: c.type, primaryKey: c.primaryKey, notNull: c.notNull })),
        false,
      );
    }
  }

  /** Autocommits one row per column into the schema table — called right after a real `CREATE TABLE` (never for an `IF NOT EXISTS` that matched an existing table, since the caller only calls this when `planned.table !== undefined`). */
  private persistTableSchema(table: TableSchema): void {
    const { txn } = this.storage.beginTransaction();
    const schemaTable = this.storage.getTable(SCHEMA_TABLE_NAME);
    for (const col of table.columns) {
      schemaTable.insert([table.name, col.ordinal, col.name, col.type, col.primaryKey, col.notNull], txn);
    }
    this.storage.commit(txn);
  }

  /** Deletes every schema-table row recorded for `tableName` — the `DROP TABLE` half of the same durability fix. */
  private removeTableSchema(tableName: string): void {
    const { txn, snapshot } = this.storage.beginTransaction();
    const schemaTable = this.storage.getTable(SCHEMA_TABLE_NAME);
    const nameOrdinal = SCHEMA_COLUMNS.indexOf('table_name');
    for (const row of schemaTable.scan(snapshot)) {
      if (row.values[nameOrdinal] === tableName) schemaTable.delete(row.id, txn);
    }
    this.storage.commit(txn);
  }

  execute(sql: string): QueryResult {
    return this.executeStatement(parseStatement(sql));
  }

  executeScript(sql: string): QueryResult[] {
    return parseScript(sql).map((stmt) => this.executeStatement(stmt));
  }

  /**
   * Runs `fn` against one transaction: every `execute()` call the callback makes shares one fixed
   * read snapshot and one write transaction id. Committed only if `fn` returns normally;
   * otherwise (it throws, synchronously) the transaction is rolled back and the error re-thrown —
   * so a failed callback leaves no partial effect visible to anyone.
   */
  transaction<T>(fn: (tx: TransactionHandle) => T): T {
    const { txn, snapshot } = this.storage.beginTransaction();
    const handle: TransactionHandle = {
      execute: (sql: string) => this.executeStatement(parseStatement(sql), { txn, snapshot }),
    };
    try {
      const result = fn(handle);
      this.storage.commit(txn);
      return result;
    } catch (error) {
      this.storage.rollback(txn);
      throw error;
    }
  }

  private executeStatement(stmt: Statement, ctx?: WriteContext): QueryResult {
    const bound = this.binder.bind(stmt);
    const planned = plan(bound);

    switch (planned.kind) {
      case 'select': {
        const snapshot = ctx?.snapshot ?? this.storage.currentSnapshot();
        const { columns, rows } = executeSelect(planned, this.storage, snapshot);
        return { kind: 'select', columns, rows };
      }

      case 'insert': {
        return this.withWriteTxn(ctx, (txn) => {
          const table = this.storage.getTable(planned.table.name);
          let count = 0;
          for (const valueRow of planned.values) {
            const full: SqlValue[] = new Array(planned.table.columns.length).fill(null);
            valueRow.forEach((expr, i) => {
              const col = planned.columns[i]!;
              full[col.ordinal] = evaluate(expr, []);
            });
            table.insert(full, txn);
            count += 1;
          }
          return { kind: 'mutation', rowsAffected: count };
        });
      }

      case 'update': {
        return this.withWriteTxn(ctx, (txn, snapshot) => {
          const table = this.storage.getTable(planned.table.name);
          const matches = matchingTableRows(planned.scan, this.storage, snapshot);
          const columnNames = planned.table.columns.map((c) => c.name);

          for (const match of matches) {
            const frame: TableFrame = { kind: 'table', alias: planned.table.name, columns: columnNames, values: match.values, id: match.id };
            const newValues = [...match.values];
            for (const assignment of planned.assignments) {
              newValues[assignment.column.ordinal] = evaluate(assignment.value, [frame]);
            }
            table.update(match.id, newValues, txn);
          }
          return { kind: 'mutation', rowsAffected: matches.length };
        });
      }

      case 'delete': {
        return this.withWriteTxn(ctx, (txn, snapshot) => {
          const table = this.storage.getTable(planned.table.name);
          const matches = matchingTableRows(planned.scan, this.storage, snapshot);
          for (const match of matches) table.delete(match.id, txn);
          return { kind: 'mutation', rowsAffected: matches.length };
        });
      }

      case 'createTable': {
        // `undefined` means IF NOT EXISTS matched an existing table — the binder already left
        // the catalog untouched in that case, so storage must stay untouched too.
        if (planned.table !== undefined) {
          this.storage.createTable(planned.table.name);
          this.persistTableSchema(planned.table);
        }
        return { kind: 'ddl', ok: true };
      }

      case 'dropTable': {
        if (this.storage.hasTable(planned.table)) {
          this.storage.dropTable(planned.table);
          this.removeTableSchema(planned.table);
        }
        // Safe even when the table never existed: `ifExists` was already validated by the
        // binder (it would have thrown a BinderError otherwise), so this never throws here.
        this.catalog.dropTable(planned.table, planned.ifExists);
        return { kind: 'ddl', ok: true };
      }
    }
  }

  /** Runs `fn` inside `ctx`'s transaction if one was supplied (a statement running inside `transaction()`), otherwise opens, commits, and cleans up a one-statement autocommit transaction around it. */
  private withWriteTxn<T>(ctx: WriteContext | undefined, fn: (txn: TransactionId, snapshot: Snapshot) => T): T {
    if (ctx !== undefined) return fn(ctx.txn, ctx.snapshot);

    const { txn, snapshot } = this.storage.beginTransaction();
    try {
      const result = fn(txn, snapshot);
      this.storage.commit(txn);
      return result;
    } catch (error) {
      this.storage.rollback(txn);
      throw error;
    }
  }
}
