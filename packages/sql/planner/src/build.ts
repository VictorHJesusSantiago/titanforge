import type { BoundExpr, BoundSelect } from '@titanforge/catalog';
import type { LogicalPlan } from './logical-plan.js';

/**
 * Straight, un-optimized construction from a `BoundSelect` — the textbook relational-algebra
 * shape: scan/join the sources, filter, aggregate, project, distinct, sort, limit, in that
 * order. `rules.ts` is where this gets rewritten into something better; this function's only
 * job is correctness, not efficiency.
 */
export function buildLogicalPlan(select: BoundSelect): LogicalPlan {
  let plan: LogicalPlan =
    select.from === undefined ? { kind: 'singleRow' } : { kind: 'scan', table: select.from.table, alias: select.from.alias, columns: undefined };

  for (const join of select.joins) {
    plan = {
      kind: 'join',
      left: plan,
      right: { kind: 'scan', table: join.source.table, alias: join.source.alias, columns: undefined },
      joinKind: join.joinKind,
      on: join.on,
    };
  }

  if (select.where !== undefined) {
    plan = { kind: 'filter', input: plan, predicate: select.where };
  }

  if (select.hasAggregates) {
    plan = { kind: 'aggregate', input: plan, groupBy: select.groupBy, aggregates: collectAggregateCalls(select) };
  }

  plan = { kind: 'project', input: plan, items: select.columns };

  if (select.distinct) {
    plan = { kind: 'distinct', input: plan };
  }

  if (select.orderBy.length > 0) {
    plan = { kind: 'sort', input: plan, items: select.orderBy };
  }

  if (select.limit !== undefined) {
    plan = { kind: 'limit', input: plan, limit: select.limit };
  }

  return plan;
}

/** Every distinct aggregate `call` expression reachable from the select list or ORDER BY, in first-seen order — what the aggregate node computes one running value per group for. */
function collectAggregateCalls(select: BoundSelect): BoundExpr[] {
  const found: BoundExpr[] = [];
  const seen = new Set<string>();

  const visit = (expr: BoundExpr): void => {
    if (expr.kind === 'call' && expr.isAggregate) {
      const key = JSON.stringify(expr);
      if (!seen.has(key)) {
        seen.add(key);
        found.push(expr);
      }
      return;
    }
    if (expr.kind === 'unary') visit(expr.expr);
    if (expr.kind === 'binary') {
      visit(expr.left);
      visit(expr.right);
    }
    if (expr.kind === 'call') {
      for (const arg of expr.args) visit(arg);
    }
  };

  for (const item of select.columns) visit(item.expr);
  for (const item of select.orderBy) visit(item.expr);
  return found;
}
