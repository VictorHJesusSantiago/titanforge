import type { BoundExpr, BoundOrderByItem, BoundSelectItem, TableSchema } from '@titanforge/catalog';

/**
 * The physical plan: what `@titanforge/executor` actually walks, Volcano-style — each node is
 * an iterator over its children's rows. Unlike the logical plan, a physical node picks a
 * concrete algorithm; `physical-plan.ts`'s `toPhysicalPlan` is the only place that choice is
 * made (e.g. hash join vs. nested-loop join), which is what "the optimizer" means here beyond
 * the tree rewrites in `rules.ts` — it is a rule too, just one that produces a different node
 * kind instead of a different tree shape.
 */
export type PhysicalPlan =
  | PhysicalSeqScan
  | PhysicalSingleRow
  | PhysicalFilter
  | PhysicalProject
  | PhysicalNestedLoopJoin
  | PhysicalHashJoin
  | PhysicalHashAggregate
  | PhysicalDistinct
  | PhysicalSort
  | PhysicalLimit;

export interface PhysicalSeqScan {
  kind: 'seqScan';
  table: TableSchema;
  alias: string;
  columns: string[] | undefined;
}

export interface PhysicalSingleRow {
  kind: 'singleRow';
}

export interface PhysicalFilter {
  kind: 'filter';
  input: PhysicalPlan;
  predicate: BoundExpr;
}

export interface PhysicalProject {
  kind: 'project';
  input: PhysicalPlan;
  items: BoundSelectItem[];
}

export interface PhysicalNestedLoopJoin {
  kind: 'nestedLoopJoin';
  left: PhysicalPlan;
  right: PhysicalPlan;
  joinKind: 'inner' | 'left';
  on: BoundExpr;
}

/** Chosen instead of `PhysicalNestedLoopJoin` exactly when `on` is a simple equality between one column from each side — see `chooseJoinStrategy` in `physical-plan.ts`. */
export interface PhysicalHashJoin {
  kind: 'hashJoin';
  left: PhysicalPlan;
  right: PhysicalPlan;
  joinKind: 'inner' | 'left';
  leftKey: BoundExpr;
  rightKey: BoundExpr;
}

export interface PhysicalHashAggregate {
  kind: 'hashAggregate';
  input: PhysicalPlan;
  groupBy: BoundExpr[];
  aggregates: BoundExpr[];
}

export interface PhysicalDistinct {
  kind: 'distinct';
  input: PhysicalPlan;
}

export interface PhysicalSort {
  kind: 'sort';
  input: PhysicalPlan;
  items: BoundOrderByItem[];
}

export interface PhysicalLimit {
  kind: 'limit';
  input: PhysicalPlan;
  limit: number;
}
