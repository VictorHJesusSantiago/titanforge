import type { BoundExpr } from '@titanforge/catalog';
import type { RowId, SqlValue } from '@titanforge/storage-api';

/**
 * A `Row` flowing between physical operators is not just a flat tuple: it carries a chain of
 * `Frame`s that let an expression bound anywhere in the original (pre-optimization) scope be
 * evaluated correctly no matter how far up the tree it is encountered. This matters because the
 * physical tree's shape is `scan/join -> filter -> aggregate? -> project -> distinct -> sort ->
 * limit` (see `@titanforge/planner`'s `build.ts`) — `sort`'s `BoundOrderByItem.expr` is bound
 * against the *original* FROM/JOIN scope (it can reference an aggregate that never made it into
 * the SELECT list, e.g. `ORDER BY COUNT(*)` with only `a` selected), yet `sort` sits *after*
 * `project` in the tree. So `project` must not collapse a row down to just its displayed
 * columns — it only *adds* a separate `output` tuple for final display, while leaving `frames`
 * (the thing expression evaluation actually reads) untouched, so anything downstream can still
 * resolve any original expression.
 */
export type Frame = TableFrame | AggFrame;

/** One physical row from one source table/alias — what a scan produces, and what two joined frames concatenate to. */
export interface TableFrame {
  kind: 'table';
  alias: string;
  /** Column names present in `values`, in the same order — narrowed to a scan's pushed-down `columns` list, or full if `columns` is `undefined`. */
  columns: string[];
  values: SqlValue[];
  /**
   * The storage-level `RowId` this frame came from, if it came straight from a `seqScan` (a
   * left-join null-fill frame has none). `@titanforge/engine` reads this directly off an
   * `UPDATE`/`DELETE` scan's result rows — the only place a `RowId` needs to survive execution,
   * since `TableStorage.update`/`.delete` are id-keyed.
   */
  id: RowId | undefined;
}

/**
 * Replaces every `TableFrame` once a `hashAggregate` runs: the original per-row columns are gone
 * (an output row now represents a whole group, not one input row), so what's left is exactly the
 * `GROUP BY` key values and the aggregate results, each keyed by the exact `BoundExpr` (compared
 * structurally, the same `JSON.stringify` trick `@titanforge/catalog`'s binder itself uses in
 * `validateGroupedExpr`) that produced it — which is exactly what the binder guarantees every
 * post-aggregation column/call reference structurally matches.
 */
export interface AggFrame {
  kind: 'agg';
  groupBy: Array<{ expr: BoundExpr; value: SqlValue }>;
  aggregates: Array<{ expr: BoundExpr; value: SqlValue }>;
}

export interface Row {
  frames: Frame[];
  /** Set once by `project` (which every SELECT's physical plan always has exactly one of) — the final, display-ordered tuple. */
  output?: SqlValue[];
}

/** A row's "raw" values for structural-equality purposes (`distinct`, and standalone operator tests that never ran a `project`). Prefers `output` when present, since that's what SQL's own DISTINCT dedups on. */
export function rowValues(row: Row): SqlValue[] {
  if (row.output !== undefined) return row.output;
  return row.frames.flatMap((frame) =>
    frame.kind === 'table' ? frame.values : [...frame.groupBy.map((g) => g.value), ...frame.aggregates.map((a) => a.value)],
  );
}
