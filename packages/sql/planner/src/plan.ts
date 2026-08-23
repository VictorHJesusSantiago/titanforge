import type { BoundAssignment, BoundExpr, BoundStatement, ColumnSchema, TableSchema } from '@titanforge/catalog';
import { buildLogicalPlan } from './build.js';
import { optimize } from './rules.js';
import { toPhysicalPlan } from './to-physical.js';
import type { LogicalPlan } from './logical-plan.js';
import type { PhysicalPlan } from './physical-plan.js';

export interface PlannedSelect {
  kind: 'select';
  plan: PhysicalPlan;
  outputColumns: string[];
}

export interface PlannedInsert {
  kind: 'insert';
  table: TableSchema;
  columns: ColumnSchema[];
  values: BoundExpr[][];
}

export interface PlannedUpdate {
  kind: 'update';
  table: TableSchema;
  /** Finds the rows to update — a `seqScan`, or a `filter` over one if there's a `WHERE`. Always over `table.name` aliased to itself. */
  scan: PhysicalPlan;
  assignments: BoundAssignment[];
}

export interface PlannedDelete {
  kind: 'delete';
  table: TableSchema;
  scan: PhysicalPlan;
}

export interface PlannedCreateTable {
  kind: 'createTable';
  table: TableSchema | undefined;
}

export interface PlannedDropTable {
  kind: 'dropTable';
  table: string;
  ifExists: boolean;
}

export type PlannedStatement = PlannedSelect | PlannedInsert | PlannedUpdate | PlannedDelete | PlannedCreateTable | PlannedDropTable;

/** The planner's single entry point: a `BoundStatement` in, something the executor can run directly out. */
export function plan(stmt: BoundStatement): PlannedStatement {
  switch (stmt.kind) {
    case 'select': {
      const logical = buildLogicalPlan(stmt);
      const optimized = optimize(logical);
      return { kind: 'select', plan: toPhysicalPlan(optimized), outputColumns: stmt.columns.map((c) => c.alias) };
    }
    case 'insert':
      return { kind: 'insert', table: stmt.table, columns: stmt.columns, values: stmt.values };
    case 'update':
      return { kind: 'update', table: stmt.table, scan: planTableScan(stmt.table, stmt.where), assignments: stmt.assignments };
    case 'delete':
      return { kind: 'delete', table: stmt.table, scan: planTableScan(stmt.table, stmt.where) };
    case 'createTable':
      return { kind: 'createTable', table: stmt.table };
    case 'dropTable':
      return { kind: 'dropTable', table: stmt.table, ifExists: stmt.ifExists };
  }
}

/**
 * Deliberately skips projection pushdown (unlike `plan()`'s `select` path) — an `UPDATE`/
 * `DELETE` needs every column's current value to write a complete new row back (storage's
 * `update()` takes a full `values` array, not a sparse patch), even though only the columns the
 * `WHERE` clause touches would otherwise survive pruning. Predicate pushdown doesn't apply here
 * either: there is exactly one table, nothing to push a filter across.
 */
function planTableScan(table: TableSchema, where: BoundExpr | undefined): PhysicalPlan {
  let logical: LogicalPlan = { kind: 'scan', table, alias: table.name, columns: undefined };
  if (where !== undefined) {
    logical = { kind: 'filter', input: logical, predicate: where };
  }
  return toPhysicalPlan(logical);
}
