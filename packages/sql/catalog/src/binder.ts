import {
  assertUnreachable,
  type Expr,
  type JoinClause,
  type SelectStmt,
  type Statement,
  type TableRef,
} from '@titanforge/parser';
import { CatalogError } from './catalog.js';
import type { Catalog } from './catalog.js';
import type { ColumnSchema } from './schema.js';
import { findColumn } from './schema.js';
import type {
  BoundAssignment,
  BoundCreateTable,
  BoundDelete,
  BoundDropTable,
  BoundExpr,
  BoundInsert,
  BoundJoin,
  BoundSelect,
  BoundSelectItem,
  BoundSource,
  BoundStatement,
  BoundUpdate,
  SqlType,
} from './bound-ast.js';

export class BinderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinderError';
  }
}

const AGGREGATE_FUNCTIONS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

interface ScalarFunctionDef {
  arity: number;
  returnType: (argTypes: SqlType[]) => SqlType;
}

const SCALAR_FUNCTIONS: Record<string, ScalarFunctionDef> = {
  UPPER: { arity: 1, returnType: () => 'TEXT' },
  LOWER: { arity: 1, returnType: () => 'TEXT' },
  LENGTH: { arity: 1, returnType: () => 'INTEGER' },
  ABS: { arity: 1, returnType: (args) => args[0] ?? 'INTEGER' },
  COALESCE: { arity: -1, returnType: (args) => args.find((t) => t !== 'NULL') ?? 'NULL' },
};

const NUMERIC_TYPES = new Set<SqlType>(['INTEGER', 'REAL']);

function isNumeric(type: SqlType): boolean {
  return NUMERIC_TYPES.has(type);
}

/**
 * Binds a parsed `Statement` against a `Catalog`: resolves every table and column reference,
 * infers every expression's `SqlType`, expands `SELECT *`, and validates the handful of
 * semantic rules a parser cannot check (a table exists, a column isn't ambiguous across a join,
 * an aggregate query's non-aggregated columns are all in `GROUP BY`). What comes out is a
 * `BoundStatement` — the planner never looks up a name again.
 */
export class Binder {
  constructor(private readonly catalog: Catalog) {}

  /**
   * `Catalog`'s own lookups throw `CatalogError` — a distinct class because the catalog is a
   * standalone, binder-independent piece of the public API (`@titanforge/catalog` exports it on
   * its own). Every path through the *binder*, though, should surface exactly one error type at
   * its own boundary; a caller of `Binder.bind()` should never need to catch two different
   * classes to handle "this SQL doesn't resolve." This is the one place that translation happens.
   */
  private getTable(name: string) {
    try {
      return this.catalog.getTable(name);
    } catch (error) {
      if (error instanceof CatalogError) throw new BinderError(error.message);
      throw error;
    }
  }

  bind(stmt: Statement): BoundStatement {
    switch (stmt.kind) {
      case 'createTable':
        return this.bindCreateTable(stmt);
      case 'dropTable':
        return this.bindDropTable(stmt);
      case 'insert':
        return this.bindInsert(stmt);
      case 'update':
        return this.bindUpdate(stmt);
      case 'delete':
        return this.bindDelete(stmt);
      case 'select':
        return this.bindSelect(stmt);
      default:
        return assertUnreachable(stmt);
    }
  }

  private bindCreateTable(stmt: Extract<Statement, { kind: 'createTable' }>): BoundCreateTable {
    const table = this.catalog.createTable(stmt.table, stmt.columns, stmt.ifNotExists);
    return { kind: 'createTable', table };
  }

  private bindDropTable(stmt: Extract<Statement, { kind: 'dropTable' }>): BoundDropTable {
    if (!stmt.ifExists && !this.catalog.hasTable(stmt.table)) {
      throw new BinderError(`table "${stmt.table}" does not exist`);
    }
    return { kind: 'dropTable', table: stmt.table, ifExists: stmt.ifExists };
  }

  private bindInsert(stmt: Extract<Statement, { kind: 'insert' }>): BoundInsert {
    const table = this.getTable(stmt.table);
    const columns: ColumnSchema[] = stmt.columns === undefined
      ? table.columns
      : stmt.columns.map((name) => {
          const col = findColumn(table, name);
          if (col === undefined) throw new BinderError(`unknown column "${name}" in table "${table.name}"`);
          return col;
        });

    for (const row of stmt.values) {
      if (row.length !== columns.length) {
        throw new BinderError(`INSERT has ${row.length} value(s) but ${columns.length} column(s) were specified`);
      }
    }

    // Values bind against an empty scope — an INSERT's VALUES list may reference no columns,
    // only literals and (in principle) constant expressions.
    const values = stmt.values.map((row) => row.map((expr) => this.bindExpr(expr, [])));

    for (const row of values) {
      row.forEach((bound, i) => {
        const col = columns[i];
        if (col === undefined) return;
        assertAssignable(bound.type, col.type, col.name);
      });
    }

    return { kind: 'insert', table, columns, values };
  }

  private bindUpdate(stmt: Extract<Statement, { kind: 'update' }>): BoundUpdate {
    const table = this.getTable(stmt.table);
    const scope: BoundSource[] = [{ alias: table.name, table }];

    const assignments: BoundAssignment[] = stmt.assignments.map((a): BoundAssignment => {
      const column = findColumn(table, a.column);
      if (column === undefined) throw new BinderError(`unknown column "${a.column}" in table "${table.name}"`);
      const value = this.bindExpr(a.value, scope);
      assertAssignable(value.type, column.type, column.name);
      return { column, value };
    });

    const where = stmt.where === undefined ? undefined : this.bindExpr(stmt.where, scope);
    return { kind: 'update', table, assignments, where };
  }

  private bindDelete(stmt: Extract<Statement, { kind: 'delete' }>): BoundDelete {
    const table = this.getTable(stmt.table);
    const scope: BoundSource[] = [{ alias: table.name, table }];
    const where = stmt.where === undefined ? undefined : this.bindExpr(stmt.where, scope);
    return { kind: 'delete', table, where };
  }

  private resolveSource(ref: TableRef): BoundSource {
    const table = this.getTable(ref.table);
    return { alias: ref.alias ?? ref.table, table };
  }

  private bindSelect(stmt: SelectStmt): BoundSelect {
    const scope: BoundSource[] = [];
    if (stmt.from !== undefined) {
      const source = this.resolveSource(stmt.from);
      assertNoDuplicateAlias(scope, source.alias);
      scope.push(source);
    }

    const joins: BoundJoin[] = stmt.joins.map((join: JoinClause): BoundJoin => {
      const source = this.resolveSource({ table: join.table, alias: join.alias });
      assertNoDuplicateAlias(scope, source.alias);
      scope.push(source);
      const on = this.bindExpr(join.on, scope);
      return { joinKind: join.joinKind, source, on };
    });

    const columns: BoundSelectItem[] = [];
    for (const item of stmt.columns) {
      if (item.expr.kind === 'star') {
        if (scope.length === 0) throw new BinderError('SELECT * requires a FROM clause');
        for (const source of scope) {
          for (const col of source.table.columns) {
            columns.push({
              expr: { kind: 'column', source: source.alias, name: col.name, ordinal: col.ordinal, type: col.type },
              alias: col.name,
            });
          }
        }
        continue;
      }
      const expr = this.bindExpr(item.expr, scope);
      columns.push({ expr, alias: item.alias ?? inferAlias(item.expr) });
    }

    const where = stmt.where === undefined ? undefined : this.bindExpr(stmt.where, scope);
    const groupBy = stmt.groupBy.map((expr) => this.bindExpr(expr, scope));
    const orderBy = stmt.orderBy.map((item) => ({ expr: this.bindExpr(item.expr, scope), direction: item.direction }));

    const hasAggregates =
      columns.some((c) => exprHasAggregate(c.expr)) || orderBy.some((o) => exprHasAggregate(o.expr));

    if (hasAggregates && groupBy.length > 0) {
      for (const item of columns) {
        validateGroupedExpr(item.expr, groupBy);
      }
    }

    return {
      kind: 'select',
      distinct: stmt.distinct,
      columns,
      from: scope[0],
      joins,
      where,
      groupBy,
      orderBy,
      limit: stmt.limit,
      hasAggregates,
    };
  }

  private bindExpr(expr: Expr, scope: BoundSource[]): BoundExpr {
    switch (expr.kind) {
      case 'literal':
        return { kind: 'literal', value: expr.value, type: literalType(expr.value.type) };

      case 'column': {
        const [source, column] = this.resolveColumn(scope, expr.table, expr.name);
        return { kind: 'column', source: source.alias, name: column.name, ordinal: column.ordinal, type: column.type };
      }

      case 'unary': {
        const inner = this.bindExpr(expr.expr, scope);
        if (expr.op === '-') {
          if (!isNumeric(inner.type) && inner.type !== 'NULL') {
            throw new BinderError(`unary "-" requires a numeric operand, got ${inner.type}`);
          }
          return { kind: 'unary', op: '-', expr: inner, type: inner.type };
        }
        return { kind: 'unary', op: 'NOT', expr: inner, type: 'BOOLEAN' };
      }

      case 'binary': {
        const left = this.bindExpr(expr.left, scope);
        const right = this.bindExpr(expr.right, scope);
        return { kind: 'binary', op: expr.op, left, right, type: binaryResultType(expr.op, left.type, right.type) };
      }

      case 'call': {
        const name = expr.name;
        const isCountStar = name === 'COUNT' && expr.args.length === 1 && expr.args[0]?.kind === 'star';
        if (isCountStar) {
          return { kind: 'call', name: 'COUNT', args: [], distinct: expr.distinct, type: 'INTEGER', isAggregate: true };
        }

        const args = expr.args.map((a) => {
          if (a.kind === 'star') throw new BinderError(`"*" is only valid as the sole argument to COUNT`);
          return this.bindExpr(a, scope);
        });

        if (AGGREGATE_FUNCTIONS.has(name)) {
          const argType = args[0]?.type ?? 'NULL';
          const type: SqlType = name === 'COUNT' ? 'INTEGER' : name === 'SUM' || name === 'AVG' ? 'REAL' : argType;
          return { kind: 'call', name, args, distinct: expr.distinct, type, isAggregate: true };
        }

        const scalar = SCALAR_FUNCTIONS[name];
        if (scalar === undefined) throw new BinderError(`unknown function "${name}"`);
        if (scalar.arity >= 0 && args.length !== scalar.arity) {
          throw new BinderError(`function "${name}" expects ${scalar.arity} argument(s), got ${args.length}`);
        }
        return { kind: 'call', name, args, distinct: expr.distinct, type: scalar.returnType(args.map((a) => a.type)), isAggregate: false };
      }

      case 'star':
        throw new BinderError('"*" is not valid in this position');

      default:
        return assertUnreachable(expr);
    }
  }

  private resolveColumn(scope: BoundSource[], table: string | undefined, name: string): [BoundSource, ColumnSchema] {
    if (table !== undefined) {
      const source = scope.find((s) => s.alias === table);
      if (source === undefined) throw new BinderError(`unknown table or alias "${table}"`);
      const column = findColumn(source.table, name);
      if (column === undefined) throw new BinderError(`unknown column "${table}.${name}"`);
      return [source, column];
    }

    const matches: Array<[BoundSource, ColumnSchema]> = [];
    for (const source of scope) {
      const column = findColumn(source.table, name);
      if (column !== undefined) matches.push([source, column]);
    }
    if (matches.length === 0) throw new BinderError(`unknown column "${name}"`);
    if (matches.length > 1) {
      throw new BinderError(`column "${name}" is ambiguous between ${matches.map(([s]) => s.alias).join(', ')}`);
    }
    return matches[0]!;
  }
}

function assertNoDuplicateAlias(scope: BoundSource[], alias: string): void {
  if (scope.some((s) => s.alias === alias)) {
    throw new BinderError(`duplicate table name or alias "${alias}"`);
  }
}

function literalType(type: 'integer' | 'real' | 'text' | 'boolean' | 'null'): SqlType {
  switch (type) {
    case 'integer':
      return 'INTEGER';
    case 'real':
      return 'REAL';
    case 'text':
      return 'TEXT';
    case 'boolean':
      return 'BOOLEAN';
    case 'null':
      return 'NULL';
  }
}

function inferAlias(expr: Expr): string {
  if (expr.kind === 'column') return expr.name;
  if (expr.kind === 'call') return expr.name.toLowerCase();
  return 'expr';
}

/** Loose-but-real assignability: `NULL` unifies with anything; otherwise the broad category (numeric/text/boolean) must match. */
function assertAssignable(from: SqlType, to: SqlType, context: string): void {
  if (from === 'NULL' || to === 'NULL') return;
  if (isNumeric(from) && isNumeric(to)) return;
  if (from !== to) {
    throw new BinderError(`cannot assign ${from} to column "${context}" of type ${to}`);
  }
}

function binaryResultType(op: string, leftType: SqlType, rightType: SqlType): SqlType {
  if (op === 'AND' || op === 'OR') {
    assertBooleanish(leftType, op);
    assertBooleanish(rightType, op);
    return 'BOOLEAN';
  }
  if (op === '=' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    assertComparable(leftType, rightType);
    return 'BOOLEAN';
  }
  // arithmetic
  if (leftType !== 'NULL' && !isNumeric(leftType)) throw new BinderError(`operator "${op}" requires a numeric left operand, got ${leftType}`);
  if (rightType !== 'NULL' && !isNumeric(rightType)) throw new BinderError(`operator "${op}" requires a numeric right operand, got ${rightType}`);
  if (leftType === 'NULL' || rightType === 'NULL') return 'NULL';
  return leftType === 'INTEGER' && rightType === 'INTEGER' ? 'INTEGER' : 'REAL';
}

function assertBooleanish(type: SqlType, op: string): void {
  if (type !== 'BOOLEAN' && type !== 'NULL') {
    throw new BinderError(`operator "${op}" requires a boolean operand, got ${type}`);
  }
}

function assertComparable(left: SqlType, right: SqlType): void {
  if (left === 'NULL' || right === 'NULL') return;
  if (isNumeric(left) && isNumeric(right)) return;
  if (left !== right) {
    throw new BinderError(`cannot compare ${left} with ${right}`);
  }
}

function exprHasAggregate(expr: BoundExpr): boolean {
  switch (expr.kind) {
    case 'literal':
    case 'column':
      return false;
    case 'unary':
      return exprHasAggregate(expr.expr);
    case 'binary':
      return exprHasAggregate(expr.left) || exprHasAggregate(expr.right);
    case 'call':
      return expr.isAggregate || expr.args.some(exprHasAggregate);
  }
}

function exprEquals(a: BoundExpr, b: BoundExpr): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A non-aggregate expression in a grouped query's SELECT list must be one of the GROUP BY keys, structurally. */
function validateGroupedExpr(expr: BoundExpr, groupBy: BoundExpr[]): void {
  if (expr.kind === 'call' && expr.isAggregate) return;
  if (groupBy.some((g) => exprEquals(g, expr))) return;
  if (expr.kind === 'column') {
    throw new BinderError(`column "${expr.source}.${expr.name}" must appear in GROUP BY or be used in an aggregate function`);
  }
  if (expr.kind === 'literal') return;
  if (expr.kind === 'unary') return validateGroupedExpr(expr.expr, groupBy);
  if (expr.kind === 'binary') {
    validateGroupedExpr(expr.left, groupBy);
    validateGroupedExpr(expr.right, groupBy);
    return;
  }
  if (expr.kind === 'call') {
    for (const arg of expr.args) validateGroupedExpr(arg, groupBy);
  }
}
