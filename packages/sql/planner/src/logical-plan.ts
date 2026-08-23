import type { BoundExpr, BoundOrderByItem, BoundSelectItem, TableSchema } from '@titanforge/catalog';

/**
 * The logical plan: relational algebra, no opinion yet about *how* a join or a scan actually
 * runs. `build.ts` constructs one straight from a `BoundSelect`; `rules.ts` rewrites it;
 * `physical-plan.ts` is the only place a logical node picks a concrete algorithm.
 */
export type LogicalPlan =
  | LogicalScan
  | LogicalSingleRow
  | LogicalFilter
  | LogicalProject
  | LogicalJoin
  | LogicalAggregate
  | LogicalDistinct
  | LogicalSort
  | LogicalLimit;

export interface LogicalScan {
  kind: 'scan';
  table: TableSchema;
  alias: string;
  /** Set by projection pushdown (`rules.ts`) to the column names actually referenced anywhere above this scan — `undefined` means "not yet pruned, materialize everything." */
  columns: string[] | undefined;
}

/** Exactly one zero-column row — what a `FROM`-less `SELECT 1 + 1` projects over, the same role Oracle's `DUAL` table plays. */
export interface LogicalSingleRow {
  kind: 'singleRow';
}

export interface LogicalFilter {
  kind: 'filter';
  input: LogicalPlan;
  predicate: BoundExpr;
}

export interface LogicalProject {
  kind: 'project';
  input: LogicalPlan;
  items: BoundSelectItem[];
}

export interface LogicalJoin {
  kind: 'join';
  left: LogicalPlan;
  right: LogicalPlan;
  joinKind: 'inner' | 'left';
  on: BoundExpr;
}

export interface LogicalAggregate {
  kind: 'aggregate';
  input: LogicalPlan;
  groupBy: BoundExpr[];
  /** The aggregate `call` expressions actually referenced by the SELECT list, deduplicated — what the physical node computes one running value per group for. */
  aggregates: BoundExpr[];
}

export interface LogicalDistinct {
  kind: 'distinct';
  input: LogicalPlan;
}

export interface LogicalSort {
  kind: 'sort';
  input: LogicalPlan;
  items: BoundOrderByItem[];
}

export interface LogicalLimit {
  kind: 'limit';
  input: LogicalPlan;
  limit: number;
}

/** Every table alias reachable under a plan node — used by both predicate pushdown (which side of a join does a conjunct belong to) and join-strategy selection (is a column on the left or the right). */
export function scanAliases(plan: LogicalPlan): Set<string> {
  const aliases = new Set<string>();
  const visit = (node: LogicalPlan): void => {
    if (node.kind === 'scan') {
      aliases.add(node.alias);
    } else if (node.kind === 'singleRow') {
      // no alias
    } else if (node.kind === 'join') {
      visit(node.left);
      visit(node.right);
    } else {
      visit(node.input);
    }
  };
  visit(plan);
  return aliases;
}

/** Every logical node has exactly zero, one, or two children — this is the one place that shape is named, so a tree-walking rule doesn't hand-roll it per node kind. */
export function children(plan: LogicalPlan): LogicalPlan[] {
  switch (plan.kind) {
    case 'scan':
    case 'singleRow':
      return [];
    case 'join':
      return [plan.left, plan.right];
    case 'filter':
    case 'project':
    case 'aggregate':
    case 'distinct':
    case 'sort':
    case 'limit':
      return [plan.input];
  }
}
