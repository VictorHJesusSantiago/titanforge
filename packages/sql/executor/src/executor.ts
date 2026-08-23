import type {
  PhysicalHashJoin,
  PhysicalNestedLoopJoin,
  PhysicalPlan,
} from '@titanforge/planner';
import type { Snapshot, SqlValue, StorageEngine } from '@titanforge/storage-api';
import { evaluate, ExecutionError } from './expr.js';
import { makeAggregateState } from './aggregate.js';
import { rowValues, type Row, type TableFrame } from './row.js';

/**
 * The Volcano-style entry point: a `PhysicalPlan` in, a lazy `IterableIterator<Row>` out. Every
 * operator below is a generator function that recurses into `executePlan` on its children — so
 * pulling one row from, say, a `limit` on top of a full table scan really does stop pulling from
 * the scan once satisfied (no upstream materialization happens except where an operator is
 * genuinely blocking by nature: `sort` needs every row before it can emit the first one, and
 * `hashJoin`/`nestedLoopJoin` need their build/right side fully read before probing).
 */
export function* executePlan(plan: PhysicalPlan, storage: StorageEngine, snapshot: Snapshot): IterableIterator<Row> {
  switch (plan.kind) {
    case 'seqScan':
      yield* execSeqScan(plan, storage, snapshot);
      return;
    case 'singleRow':
      yield { frames: [] };
      return;
    case 'filter':
      yield* execFilter(plan, storage, snapshot);
      return;
    case 'project':
      yield* execProject(plan, storage, snapshot);
      return;
    case 'nestedLoopJoin':
      yield* execNestedLoopJoin(plan, storage, snapshot);
      return;
    case 'hashJoin':
      yield* execHashJoin(plan, storage, snapshot);
      return;
    case 'hashAggregate':
      yield* execHashAggregate(plan, storage, snapshot);
      return;
    case 'distinct':
      yield* execDistinct(plan, storage, snapshot);
      return;
    case 'sort':
      yield* execSort(plan, storage, snapshot);
      return;
    case 'limit':
      yield* execLimit(plan, storage, snapshot);
      return;
  }
}

function* execSeqScan(plan: Extract<PhysicalPlan, { kind: 'seqScan' }>, storage: StorageEngine, snapshot: Snapshot): IterableIterator<Row> {
  const table = storage.getTable(plan.table.name);
  const columnNames = plan.columns ?? plan.table.columns.map((c) => c.name);
  const ordinals = columnNames.map((name) => {
    const col = plan.table.columns.find((c) => c.name === name);
    if (col === undefined) throw new ExecutionError(`unknown column "${name}" on table "${plan.table.name}"`);
    return col.ordinal;
  });

  for (const stored of table.scan(snapshot)) {
    const values = ordinals.map((ord) => stored.values[ord] ?? null);
    yield { frames: [{ kind: 'table', alias: plan.alias, columns: columnNames, values, id: stored.id }] };
  }
}

function* execFilter(plan: Extract<PhysicalPlan, { kind: 'filter' }>, storage: StorageEngine, snapshot: Snapshot): IterableIterator<Row> {
  for (const row of executePlan(plan.input, storage, snapshot)) {
    // Real SQL WHERE semantics: only `true` (never `null`/falsy-non-boolean) keeps a row.
    if (evaluate(plan.predicate, row.frames) === true) yield row;
  }
}

function* execProject(plan: Extract<PhysicalPlan, { kind: 'project' }>, storage: StorageEngine, snapshot: Snapshot): IterableIterator<Row> {
  for (const row of executePlan(plan.input, storage, snapshot)) {
    const output = plan.items.map((item) => evaluate(item.expr, row.frames));
    yield { frames: row.frames, output };
  }
}

/** The shape (aliases + column names, all-`NULL` values) a join's right side would have if it never produced a single row — needed to null-fill an unmatched LEFT JOIN row without having sampled an actual right row. */
function staticFrameShape(plan: PhysicalPlan): TableFrame[] {
  switch (plan.kind) {
    case 'seqScan': {
      const columns = plan.columns ?? plan.table.columns.map((c) => c.name);
      return [{ kind: 'table', alias: plan.alias, columns, values: columns.map(() => null), id: undefined }];
    }
    case 'singleRow':
      return [];
    case 'nestedLoopJoin':
    case 'hashJoin':
      return [...staticFrameShape(plan.left), ...staticFrameShape(plan.right)];
    case 'filter':
    case 'project':
    case 'distinct':
    case 'sort':
    case 'limit':
      return staticFrameShape(plan.input);
    case 'hashAggregate':
      return [];
  }
}

function* execNestedLoopJoin(plan: PhysicalNestedLoopJoin, storage: StorageEngine, snapshot: Snapshot): IterableIterator<Row> {
  const rightRows = [...executePlan(plan.right, storage, snapshot)];
  const nullRightFrames = plan.joinKind === 'left' ? staticFrameShape(plan.right) : [];

  for (const leftRow of executePlan(plan.left, storage, snapshot)) {
    let matched = false;
    for (const rightRow of rightRows) {
      const frames = [...leftRow.frames, ...rightRow.frames];
      if (evaluate(plan.on, frames) === true) {
        matched = true;
        yield { frames };
      }
    }
    if (!matched && plan.joinKind === 'left') {
      yield { frames: [...leftRow.frames, ...nullRightFrames] };
    }
  }
}

function* execHashJoin(plan: PhysicalHashJoin, storage: StorageEngine, snapshot: Snapshot): IterableIterator<Row> {
  const buckets = new Map<string, Row[]>();
  for (const rightRow of executePlan(plan.right, storage, snapshot)) {
    const key = evaluate(plan.rightKey, rightRow.frames);
    if (key === null) continue; // NULL never equals NULL in an equi-join
    const bucketKey = JSON.stringify(key);
    const bucket = buckets.get(bucketKey);
    if (bucket === undefined) buckets.set(bucketKey, [rightRow]);
    else bucket.push(rightRow);
  }

  const nullRightFrames = plan.joinKind === 'left' ? staticFrameShape(plan.right) : [];

  for (const leftRow of executePlan(plan.left, storage, snapshot)) {
    const key = evaluate(plan.leftKey, leftRow.frames);
    const bucket = key === null ? undefined : buckets.get(JSON.stringify(key));
    if (bucket !== undefined && bucket.length > 0) {
      for (const rightRow of bucket) {
        yield { frames: [...leftRow.frames, ...rightRow.frames] };
      }
    } else if (plan.joinKind === 'left') {
      yield { frames: [...leftRow.frames, ...nullRightFrames] };
    }
  }
}

function* execHashAggregate(plan: Extract<PhysicalPlan, { kind: 'hashAggregate' }>, storage: StorageEngine, snapshot: Snapshot): IterableIterator<Row> {
  interface Group {
    groupValues: SqlValue[];
    states: ReturnType<typeof makeAggregateState>[];
  }
  const groups = new Map<string, Group>();

  for (const row of executePlan(plan.input, storage, snapshot)) {
    const groupValues = plan.groupBy.map((g) => evaluate(g, row.frames));
    const key = JSON.stringify(groupValues);
    let group = groups.get(key);
    if (group === undefined) {
      group = { groupValues, states: plan.aggregates.map(makeAggregateState) };
      groups.set(key, group);
    }
    plan.aggregates.forEach((aggExpr, i) => {
      const argExpr = aggExpr.kind === 'call' ? aggExpr.args[0] : undefined;
      const value = argExpr === undefined ? null : evaluate(argExpr, row.frames);
      group!.states[i]!.add(value);
    });
  }

  // `GROUP BY` with an empty group set over zero input rows produces zero groups (standard SQL);
  // no `GROUP BY` at all always produces exactly one group, even over zero rows (e.g. bare
  // `SELECT COUNT(*) FROM t WHERE false` must still yield one row with `COUNT(*) = 0`).
  if (groups.size === 0 && plan.groupBy.length === 0) {
    const states = plan.aggregates.map(makeAggregateState);
    yield makeAggRow(plan, [], states.map((s) => s.finish()));
    return;
  }

  for (const group of groups.values()) {
    yield makeAggRow(plan, group.groupValues, group.states.map((s) => s.finish()));
  }
}

function makeAggRow(plan: Extract<PhysicalPlan, { kind: 'hashAggregate' }>, groupValues: SqlValue[], aggValues: SqlValue[]): Row {
  return {
    frames: [
      {
        kind: 'agg',
        groupBy: plan.groupBy.map((expr, i) => ({ expr, value: groupValues[i] ?? null })),
        aggregates: plan.aggregates.map((expr, i) => ({ expr, value: aggValues[i] ?? null })),
      },
    ],
  };
}

function* execDistinct(plan: Extract<PhysicalPlan, { kind: 'distinct' }>, storage: StorageEngine, snapshot: Snapshot): IterableIterator<Row> {
  const seen = new Set<string>();
  for (const row of executePlan(plan.input, storage, snapshot)) {
    const key = JSON.stringify(rowValues(row));
    if (seen.has(key)) continue;
    seen.add(key);
    yield row;
  }
}

/** NULLs always sort last, in both `ASC` and `DESC` — a documented, tested choice (see the executor's test suite); this is not universal across real SQL engines but is internally consistent. */
function compareValues(a: SqlValue, b: SqlValue, direction: 'ASC' | 'DESC'): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  let cmp: number;
  if (typeof a === 'number' && typeof b === 'number') cmp = a - b;
  else if (typeof a === 'boolean' && typeof b === 'boolean') cmp = a === b ? 0 : a ? 1 : -1;
  else cmp = a < b ? -1 : a > b ? 1 : 0;

  return direction === 'DESC' ? -cmp : cmp;
}

function* execSort(plan: Extract<PhysicalPlan, { kind: 'sort' }>, storage: StorageEngine, snapshot: Snapshot): IterableIterator<Row> {
  const rows = [...executePlan(plan.input, storage, snapshot)];
  const decorated = rows.map((row, index) => ({
    row,
    index,
    keys: plan.items.map((item) => evaluate(item.expr, row.frames)),
  }));

  decorated.sort((x, y) => {
    for (let i = 0; i < plan.items.length; i += 1) {
      const item = plan.items[i]!;
      const cmp = compareValues(x.keys[i]!, y.keys[i]!, item.direction);
      if (cmp !== 0) return cmp;
    }
    // Explicit index tie-break: guarantees stability (equal-key rows keep source order) even
    // though `Array.prototype.sort` is already spec-stable — belt and suspenders.
    return x.index - y.index;
  });

  for (const d of decorated) yield d.row;
}

function* execLimit(plan: Extract<PhysicalPlan, { kind: 'limit' }>, storage: StorageEngine, snapshot: Snapshot): IterableIterator<Row> {
  if (plan.limit <= 0) return;
  let count = 0;
  for (const row of executePlan(plan.input, storage, snapshot)) {
    yield row;
    count += 1;
    if (count >= plan.limit) return; // stops pulling from the child generator entirely
  }
}
