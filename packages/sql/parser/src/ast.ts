/**
 * The typed AST. Every node is part of a discriminated union keyed on `kind` — the binder,
 * planner and executor all switch on it exhaustively, and TypeScript's exhaustiveness checking
 * (a `never` in the `default` branch) is what catches "added a new statement kind, forgot to
 * handle it in the planner" at compile time instead of at 2am against a customer's database.
 */

export type DataType = 'INTEGER' | 'REAL' | 'TEXT' | 'BOOLEAN';

export type LiteralValue =
  | { type: 'integer'; value: number }
  | { type: 'real'; value: number }
  | { type: 'text'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' };

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '=' | '!=' | '<' | '<=' | '>' | '>='
  | 'AND' | 'OR';

export type Expr =
  | { kind: 'literal'; value: LiteralValue }
  | { kind: 'column'; table: string | undefined; name: string }
  | { kind: 'unary'; op: '-' | 'NOT'; expr: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'call'; name: string; args: Expr[]; distinct: boolean }
  | { kind: 'star' };

export interface ColumnDef {
  name: string;
  type: DataType;
  primaryKey: boolean;
  notNull: boolean;
}

export interface CreateTableStmt {
  kind: 'createTable';
  table: string;
  ifNotExists: boolean;
  columns: ColumnDef[];
}

export interface DropTableStmt {
  kind: 'dropTable';
  table: string;
  ifExists: boolean;
}

export interface InsertStmt {
  kind: 'insert';
  table: string;
  columns: string[] | undefined;
  values: Expr[][];
}

export interface Assignment {
  column: string;
  value: Expr;
}

export interface UpdateStmt {
  kind: 'update';
  table: string;
  assignments: Assignment[];
  where: Expr | undefined;
}

export interface DeleteStmt {
  kind: 'delete';
  table: string;
  where: Expr | undefined;
}

export interface SelectItem {
  expr: Expr;
  alias: string | undefined;
}

export interface JoinClause {
  joinKind: 'inner' | 'left';
  table: string;
  alias: string | undefined;
  on: Expr;
}

export interface TableRef {
  table: string;
  alias: string | undefined;
}

export interface OrderByItem {
  expr: Expr;
  direction: 'ASC' | 'DESC';
}

export interface SelectStmt {
  kind: 'select';
  distinct: boolean;
  columns: SelectItem[];
  from: TableRef | undefined;
  joins: JoinClause[];
  where: Expr | undefined;
  groupBy: Expr[];
  orderBy: OrderByItem[];
  limit: number | undefined;
}

export type Statement = CreateTableStmt | DropTableStmt | InsertStmt | UpdateStmt | DeleteStmt | SelectStmt;

/** Exhaustiveness helper — call in a `default` branch so a new `Statement`/`Expr` kind is a compile error until every switch handles it. */
export function assertUnreachable(value: never): never {
  throw new Error(`unreachable: unhandled variant ${JSON.stringify(value)}`);
}
