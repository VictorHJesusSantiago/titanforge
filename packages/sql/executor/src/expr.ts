import type { BoundExpr } from '@titanforge/catalog';
import type { SqlValue } from '@titanforge/storage-api';
import type { Frame } from './row.js';

export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionError';
  }
}

const NOT_FOUND = Symbol('not-found');

/**
 * Evaluates a `BoundExpr` against a row's `frames`. Implements real SQL three-valued logic: a
 * `NULL` operand in a comparison, arithmetic op, or `AND`/`OR`/`NOT` propagates per the standard
 * truth tables documented on each branch below, rather than JS's own (wrong, for SQL purposes)
 * falsy/truthy rules.
 */
export function evaluate(expr: BoundExpr, frames: Frame[]): SqlValue {
  const structural = tryStructuralMatch(expr, frames);
  if (structural !== NOT_FOUND) return structural;

  switch (expr.kind) {
    case 'literal':
      return expr.value.type === 'null' ? null : expr.value.value;

    case 'column':
      return resolveColumn(expr, frames);

    case 'unary':
      return evalUnary(expr.op, evaluate(expr.expr, frames));

    case 'binary':
      return evalBinary(expr.op, expr, frames);

    case 'call':
      return evalScalarCall(expr, frames);
  }
}

/**
 * Post-aggregation, a `column` or aggregate `call` expression is resolved by exact structural
 * match against the enclosing `AggFrame`'s `groupBy`/`aggregates` lists — never by re-deriving it
 * from underlying table columns, because those are gone. This also transparently handles a
 * `GROUP BY` on a compound expression (e.g. `GROUP BY a + b`): the select-list `a + b` matches the
 * groupBy list structurally as a whole, short-circuiting before any attempt to evaluate `a`/`b`
 * as bare columns (which would fail — no `TableFrame` survives an aggregate).
 */
function tryStructuralMatch(expr: BoundExpr, frames: Frame[]): SqlValue | typeof NOT_FOUND {
  for (const frame of frames) {
    if (frame.kind !== 'agg') continue;
    const key = JSON.stringify(expr);
    for (const g of frame.groupBy) {
      if (JSON.stringify(g.expr) === key) return g.value;
    }
    for (const a of frame.aggregates) {
      if (JSON.stringify(a.expr) === key) return a.value;
    }
  }
  return NOT_FOUND;
}

function resolveColumn(expr: Extract<BoundExpr, { kind: 'column' }>, frames: Frame[]): SqlValue {
  for (const frame of frames) {
    if (frame.kind !== 'table' || frame.alias !== expr.source) continue;
    const idx = frame.columns.indexOf(expr.name);
    if (idx === -1) continue;
    return frame.values[idx] ?? null;
  }
  throw new ExecutionError(`cannot resolve column "${expr.source}.${expr.name}" at execution time`);
}

/** `NOT NULL = NULL`; `-NULL = NULL`. */
function evalUnary(op: '-' | 'NOT', value: SqlValue): SqlValue {
  if (value === null) return null;
  if (op === '-') return -(value as number);
  return !(value as boolean);
}

function evalBinary(op: string, expr: Extract<BoundExpr, { kind: 'binary' }>, frames: Frame[]): SqlValue {
  if (op === 'AND') return evalAnd(() => evaluate(expr.left, frames), () => evaluate(expr.right, frames));
  if (op === 'OR') return evalOr(() => evaluate(expr.left, frames), () => evaluate(expr.right, frames));

  const left = evaluate(expr.left, frames);
  const right = evaluate(expr.right, frames);

  if (['=', '!=', '<', '<=', '>', '>='].includes(op)) {
    if (left === null || right === null) return null;
    return evalComparison(op, left, right);
  }

  // arithmetic
  if (left === null || right === null) return null;
  return evalArithmetic(op, left as number, right as number);
}

/** `NULL AND false = false`; `NULL AND true = NULL`; `false AND anything = false`. Short-circuits like real SQL: a `false` left operand skips evaluating the right at all. */
function evalAnd(left: () => SqlValue, right: () => SqlValue): SqlValue {
  const l = left();
  if (l === false) return false;
  const r = right();
  if (r === false) return false;
  if (l === null || r === null) return null;
  return true;
}

/** `NULL OR true = true`; `NULL OR false = NULL`; `true OR anything = true`. */
function evalOr(left: () => SqlValue, right: () => SqlValue): SqlValue {
  const l = left();
  if (l === true) return true;
  const r = right();
  if (r === true) return true;
  if (l === null || r === null) return null;
  return false;
}

function evalComparison(op: string, left: SqlValue, right: SqlValue): boolean {
  switch (op) {
    case '=':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
      return (left as number | string) < (right as number | string);
    case '<=':
      return (left as number | string) <= (right as number | string);
    case '>':
      return (left as number | string) > (right as number | string);
    case '>=':
      return (left as number | string) >= (right as number | string);
    default:
      throw new ExecutionError(`unknown comparison operator "${op}"`);
  }
}

function evalArithmetic(op: string, left: number, right: number): number {
  switch (op) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      if (right === 0) throw new ExecutionError('division by zero');
      return left / right;
    case '%':
      if (right === 0) throw new ExecutionError('division by zero');
      return left % right;
    default:
      throw new ExecutionError(`unknown arithmetic operator "${op}"`);
  }
}

/**
 * Scalar functions only — `COUNT`/`SUM`/`AVG`/`MIN`/`MAX` are never evaluated here. Every
 * aggregate `call` in a bound tree is always resolved by `tryStructuralMatch` above (it always
 * sits, post-aggregation, inside an `AggFrame`); reaching this function with `isAggregate: true`
 * means the plan referenced an aggregate outside any aggregate context, which is a planner/binder
 * invariant violation, not something a well-formed plan can produce.
 */
function evalScalarCall(expr: Extract<BoundExpr, { kind: 'call' }>, frames: Frame[]): SqlValue {
  if (expr.isAggregate) {
    throw new ExecutionError(`aggregate "${expr.name}" referenced outside of an aggregate context`);
  }
  const args = expr.args.map((a) => evaluate(a, frames));
  switch (expr.name) {
    case 'UPPER':
      return args[0] === null || args[0] === undefined ? null : String(args[0]).toUpperCase();
    case 'LOWER':
      return args[0] === null || args[0] === undefined ? null : String(args[0]).toLowerCase();
    case 'LENGTH':
      return args[0] === null || args[0] === undefined ? null : String(args[0]).length;
    case 'ABS':
      return args[0] === null || args[0] === undefined ? null : Math.abs(args[0] as number);
    case 'COALESCE':
      for (const v of args) {
        if (v !== null && v !== undefined) return v;
      }
      return null;
    default:
      throw new ExecutionError(`unknown function "${expr.name}"`);
  }
}
