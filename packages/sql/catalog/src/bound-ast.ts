import type { BinaryOp, DataType, LiteralValue, OrderByItem } from '@titanforge/parser';
import type { ColumnSchema, TableSchema } from './schema.js';

/** A resolved expression's static type. `'NULL'` is the type of the `NULL` literal — it unifies with anything. */
export type SqlType = DataType | 'NULL';

export type BoundExpr =
  | { kind: 'literal'; value: LiteralValue; type: SqlType }
  | { kind: 'column'; source: string; name: string; ordinal: number; type: SqlType }
  | { kind: 'unary'; op: '-' | 'NOT'; expr: BoundExpr; type: SqlType }
  | { kind: 'binary'; op: BinaryOp; left: BoundExpr; right: BoundExpr; type: SqlType }
  | { kind: 'call'; name: string; args: BoundExpr[]; distinct: boolean; type: SqlType; isAggregate: boolean };

export interface BoundSelectItem {
  expr: BoundExpr;
  alias: string;
}

/** One resolved `FROM`/`JOIN` source: a table plus the alias every column from it is addressed by. */
export interface BoundSource {
  alias: string;
  table: TableSchema;
}

export interface BoundJoin {
  joinKind: 'inner' | 'left';
  source: BoundSource;
  on: BoundExpr;
}

export interface BoundOrderByItem {
  expr: BoundExpr;
  direction: OrderByItem['direction'];
}

export interface BoundSelect {
  kind: 'select';
  distinct: boolean;
  columns: BoundSelectItem[];
  from: BoundSource | undefined;
  joins: BoundJoin[];
  where: BoundExpr | undefined;
  groupBy: BoundExpr[];
  orderBy: BoundOrderByItem[];
  limit: number | undefined;
  /** True if any select item or ORDER BY expression is an aggregate — the planner inserts a grouping/aggregate node only then. */
  hasAggregates: boolean;
}

export interface BoundInsert {
  kind: 'insert';
  table: TableSchema;
  /** Always the table's full, ordinal-ordered column list — the binder resolves an explicit or implicit column list into this once, so nothing downstream re-derives it. */
  columns: ColumnSchema[];
  values: BoundExpr[][];
}

export interface BoundAssignment {
  column: ColumnSchema;
  value: BoundExpr;
}

export interface BoundUpdate {
  kind: 'update';
  table: TableSchema;
  assignments: BoundAssignment[];
  where: BoundExpr | undefined;
}

export interface BoundDelete {
  kind: 'delete';
  table: TableSchema;
  where: BoundExpr | undefined;
}

export interface BoundCreateTable {
  kind: 'createTable';
  table: TableSchema | undefined; // undefined means IF NOT EXISTS matched an existing table — a no-op
}

export interface BoundDropTable {
  kind: 'dropTable';
  table: string;
  ifExists: boolean;
}

export type BoundStatement = BoundSelect | BoundInsert | BoundUpdate | BoundDelete | BoundCreateTable | BoundDropTable;
