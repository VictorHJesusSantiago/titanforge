import type { Span } from '@titanforge/otlp';
import type { FieldRef, QueryAst } from './ast.js';

export class QueryEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryEvalError';
  }
}

/** Resolves a `FieldRef` against a span, returning `undefined` for an `attr.foo` reference the span doesn't carry. */
function resolveField(field: FieldRef, span: Span): string | number | boolean | undefined {
  if (field.kind === 'attr') return span.attributes[field.key];
  switch (field.name) {
    case 'service':
      return span.serviceName;
    case 'name':
      return span.name;
    case 'duration':
      // durationNanos is a bigint (see @titanforge/otlp); query literals are plain JS numbers, so
      // comparisons against `duration` happen in nanoseconds as a Number — safe for the same
      // reason the columnar store's own bigint->number downgrade is (see columnar-store's
      // `nanosToNumber` doc comment).
      return Number(span.durationNanos);
    case 'status':
      return span.statusCode;
  }
}

function compare(fieldValue: string | number | boolean | undefined, op: string, literalValue: string | number): boolean {
  if (fieldValue === undefined) return false;

  if (op === '=') return fieldValue === literalValue;
  if (op === '!=') return fieldValue !== literalValue;

  // Ordering operators only make sense for numbers; comparing a missing/wrong-typed field never matches.
  if (typeof fieldValue !== 'number' || typeof literalValue !== 'number') return false;
  switch (op) {
    case '>':
      return fieldValue > literalValue;
    case '>=':
      return fieldValue >= literalValue;
    case '<':
      return fieldValue < literalValue;
    case '<=':
      return fieldValue <= literalValue;
    default:
      throw new QueryEvalError(`unknown comparison operator "${op}"`);
  }
}

/** Evaluates a parsed query AST against one span, returning whether it matches. */
export function evaluateQuery(ast: QueryAst, span: Span): boolean {
  switch (ast.kind) {
    case 'and':
      return evaluateQuery(ast.left, span) && evaluateQuery(ast.right, span);
    case 'or':
      return evaluateQuery(ast.left, span) || evaluateQuery(ast.right, span);
    case 'not':
      return !evaluateQuery(ast.expr, span);
    case 'comparison':
      return compare(resolveField(ast.field, span), ast.op, ast.value.value);
  }
}

/** Compiles a query AST into a reusable filter predicate — the form `columnar-store`'s scans and `Span[].filter` both want. */
export function compileQuery(ast: QueryAst): (span: Span) => boolean {
  return (span: Span) => evaluateQuery(ast, span);
}

/** Filters an array of spans by a query AST (or a raw query string, parsed on the fly). */
export function filterSpans(ast: QueryAst, spans: Span[]): Span[] {
  const predicate = compileQuery(ast);
  return spans.filter(predicate);
}
