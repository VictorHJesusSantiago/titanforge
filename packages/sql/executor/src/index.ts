import type { PhysicalPlan, PlannedSelect } from '@titanforge/planner';
import type { RowId, Snapshot, SqlValue, StorageEngine } from '@titanforge/storage-api';
import { executePlan } from './executor.js';

export { executePlan } from './executor.js';
export { evaluate, ExecutionError } from './expr.js';
export { AggregateState, makeAggregateState } from './aggregate.js';
export { rowValues, type Row, type Frame, type TableFrame, type AggFrame } from './row.js';

/** Runs a planned `SELECT` end to end and materializes `{ columns, rows }` — the shape `@titanforge/engine` hands back to a caller. Every SELECT's physical plan always has exactly one `project` node (see `@titanforge/planner`'s `build.ts`), so `row.output` is always defined here. */
export function executeSelect(planned: PlannedSelect, storage: StorageEngine, snapshot: Snapshot): { columns: string[]; rows: SqlValue[][] } {
  const rows: SqlValue[][] = [];
  for (const row of executePlan(planned.plan, storage, snapshot)) {
    if (row.output === undefined) throw new Error('executeSelect: row produced by a select plan has no output — malformed plan');
    rows.push(row.output);
  }
  return { columns: planned.outputColumns, rows };
}

/** One matched row from a `matchingTableRows` scan: its `RowId` plus its full, ordinal-ordered column values (since `planTableScan` never prunes columns — see its own doc comment). */
export interface MatchedTableRow {
  id: RowId;
  values: SqlValue[];
}

/**
 * Runs a `PlannedUpdate.scan`/`PlannedDelete.scan` (always a bare `seqScan`, or a `filter` over
 * one, over exactly one table — see `@titanforge/planner`'s `planTableScan`) and returns every
 * matching row's `RowId` and full current values, in scan order. `@titanforge/engine` uses this
 * to find which rows an `UPDATE`/`DELETE` touches before calling `TableStorage.update`/`.delete`,
 * which are id-keyed and (for `update`) need a complete new row — the executor's generic
 * `Row`/`Frame` model has no other place either survives execution.
 */
export function matchingTableRows(scan: PhysicalPlan, storage: StorageEngine, snapshot: Snapshot): MatchedTableRow[] {
  const results: MatchedTableRow[] = [];
  for (const row of executePlan(scan, storage, snapshot)) {
    const tableFrame = row.frames.find((f) => f.kind === 'table' && f.id !== undefined);
    if (tableFrame === undefined || tableFrame.kind !== 'table' || tableFrame.id === undefined) {
      throw new Error('matchingTableRows: scan plan produced a row with no RowId — expected a bare single-table scan');
    }
    results.push({ id: tableFrame.id, values: tableFrame.values });
  }
  return results;
}
