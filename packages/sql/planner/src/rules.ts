import type { BoundExpr } from '@titanforge/catalog';
import { scanAliases, type LogicalFilter, type LogicalJoin, type LogicalPlan } from './logical-plan.js';

/**
 * Two rule-based optimizations, each a straight tree rewrite — no cost model, no statistics, no
 * choosing between alternatives by estimated cost. That is what "rule-based" means as opposed to
 * "cost-based": every rule fires unconditionally wherever it structurally applies, because each
 * one is provably never worse (predicate pushdown filters rows out earlier, never later;
 * projection pushdown only ever narrows what a scan materializes).
 */
export function optimize(plan: LogicalPlan): LogicalPlan {
  const afterPredicatePushdown = pushDownPredicates(plan);
  return pushDownProjections(afterPredicatePushdown);
}

// ---- Predicate pushdown ------------------------------------------------------------------

function splitConjuncts(expr: BoundExpr): BoundExpr[] {
  if (expr.kind === 'binary' && expr.op === 'AND') {
    return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  }
  return [expr];
}

function combineConjuncts(conjuncts: BoundExpr[]): BoundExpr | undefined {
  if (conjuncts.length === 0) return undefined;
  return conjuncts.reduce((left, right) => ({ kind: 'binary', op: 'AND', left, right, type: 'BOOLEAN' }));
}

function referencedAliases(expr: BoundExpr, into: Set<string>): void {
  switch (expr.kind) {
    case 'column':
      into.add(expr.source);
      return;
    case 'unary':
      referencedAliases(expr.expr, into);
      return;
    case 'binary':
      referencedAliases(expr.left, into);
      referencedAliases(expr.right, into);
      return;
    case 'call':
      for (const arg of expr.args) referencedAliases(arg, into);
      return;
    case 'literal':
      return;
  }
}

/**
 * Rewrites `Filter(Join(left, right))` by sorting each AND-conjunct of the predicate into
 * "only references `left`'s aliases" (pushed into a new `Filter` under `left`), "only
 * references `right`'s aliases" (pushed under `right`), or "references both" (left at the top,
 * above the join). A conjunct is never pushed into the *right* side of a `LEFT JOIN` — doing so
 * would silently turn unmatched left rows' `NULL`-extended right side into a filtered-out row,
 * changing an outer join into an inner one. That correctness rule, not an optimizer heuristic,
 * is why left-join pushdown is asymmetric here.
 */
function pushDownPredicates(plan: LogicalPlan): LogicalPlan {
  switch (plan.kind) {
    case 'scan':
    case 'singleRow':
      return plan;

    case 'join': {
      const rewritten: LogicalJoin = { ...plan, left: pushDownPredicates(plan.left), right: pushDownPredicates(plan.right) };
      return rewritten;
    }

    case 'filter': {
      const input = pushDownPredicates(plan.input);
      if (input.kind !== 'join') {
        return { ...plan, input } satisfies LogicalFilter;
      }
      return pushFilterIntoJoin(splitConjuncts(plan.predicate), input);
    }

    case 'project':
    case 'aggregate':
    case 'distinct':
    case 'sort':
    case 'limit':
      return { ...plan, input: pushDownPredicates(plan.input) };
  }
}

function pushFilterIntoJoin(conjuncts: BoundExpr[], join: LogicalJoin): LogicalPlan {
  const leftAliases = scanAliases(join.left);
  const rightAliases = scanAliases(join.right);

  const leftOnly: BoundExpr[] = [];
  const rightOnly: BoundExpr[] = [];
  const remaining: BoundExpr[] = [];

  for (const conjunct of conjuncts) {
    const refs = new Set<string>();
    referencedAliases(conjunct, refs);
    const touchesLeft = [...refs].some((a) => leftAliases.has(a));
    const touchesRight = [...refs].some((a) => rightAliases.has(a));

    if (touchesLeft && !touchesRight) {
      leftOnly.push(conjunct);
    } else if (touchesRight && !touchesLeft && join.joinKind === 'inner') {
      rightOnly.push(conjunct);
    } else {
      remaining.push(conjunct);
    }
  }

  const newLeft = wrapWithFilter(join.left, leftOnly);
  const newRight = wrapWithFilter(join.right, rightOnly);
  const newJoin: LogicalJoin = { ...join, left: newLeft, right: newRight };

  const remainingPredicate = combineConjuncts(remaining);
  return remainingPredicate === undefined ? newJoin : { kind: 'filter', input: newJoin, predicate: remainingPredicate };
}

function wrapWithFilter(plan: LogicalPlan, conjuncts: BoundExpr[]): LogicalPlan {
  const predicate = combineConjuncts(conjuncts);
  return predicate === undefined ? plan : { kind: 'filter', input: plan, predicate };
}

// ---- Projection pushdown -----------------------------------------------------------------

function collectRequiredColumns(plan: LogicalPlan, required: Map<string, Set<string>>): void {
  const note = (source: string, name: string): void => {
    let set = required.get(source);
    if (set === undefined) {
      set = new Set();
      required.set(source, set);
    }
    set.add(name);
  };
  const visitExpr = (expr: BoundExpr): void => {
    switch (expr.kind) {
      case 'column':
        note(expr.source, expr.name);
        return;
      case 'unary':
        visitExpr(expr.expr);
        return;
      case 'binary':
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case 'call':
        for (const arg of expr.args) visitExpr(arg);
        return;
      case 'literal':
        return;
    }
  };

  switch (plan.kind) {
    case 'scan':
    case 'singleRow':
      return;
    case 'filter':
      visitExpr(plan.predicate);
      collectRequiredColumns(plan.input, required);
      return;
    case 'project':
      for (const item of plan.items) visitExpr(item.expr);
      collectRequiredColumns(plan.input, required);
      return;
    case 'join':
      visitExpr(plan.on);
      collectRequiredColumns(plan.left, required);
      collectRequiredColumns(plan.right, required);
      return;
    case 'aggregate':
      for (const g of plan.groupBy) visitExpr(g);
      for (const a of plan.aggregates) visitExpr(a);
      collectRequiredColumns(plan.input, required);
      return;
    case 'distinct':
    case 'sort':
    case 'limit':
      if (plan.kind === 'sort') for (const s of plan.items) visitExpr(s.expr);
      collectRequiredColumns(plan.input, required);
      return;
  }
}

/**
 * Narrows every `LogicalScan.columns` to exactly the column names referenced anywhere above it
 * (a filter, a join condition, a projection, an aggregate, an order by) — alias-scoped, so it is
 * correct regardless of *where* in the tree the reference sits relative to the scan, not just
 * references that happen to sit directly above it.
 */
function pushDownProjections(plan: LogicalPlan): LogicalPlan {
  const required = new Map<string, Set<string>>();
  collectRequiredColumns(plan, required);

  const rewrite = (node: LogicalPlan): LogicalPlan => {
    switch (node.kind) {
      case 'scan': {
        const cols = required.get(node.alias);
        return { ...node, columns: cols === undefined ? [] : [...cols].sort() };
      }
      case 'singleRow':
        return node;
      case 'join':
        return { ...node, left: rewrite(node.left), right: rewrite(node.right) };
      default:
        return { ...node, input: rewrite(node.input) };
    }
  };
  return rewrite(plan);
}
