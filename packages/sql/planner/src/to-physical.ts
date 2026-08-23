import type { BoundExpr } from '@titanforge/catalog';
import { scanAliases, type LogicalJoin, type LogicalPlan } from './logical-plan.js';
import type { PhysicalHashJoin, PhysicalNestedLoopJoin, PhysicalPlan } from './physical-plan.js';

export function toPhysicalPlan(plan: LogicalPlan): PhysicalPlan {
  switch (plan.kind) {
    case 'scan':
      return { kind: 'seqScan', table: plan.table, alias: plan.alias, columns: plan.columns };
    case 'singleRow':
      return { kind: 'singleRow' };
    case 'filter':
      return { kind: 'filter', input: toPhysicalPlan(plan.input), predicate: plan.predicate };
    case 'project':
      return { kind: 'project', input: toPhysicalPlan(plan.input), items: plan.items };
    case 'join':
      return chooseJoinStrategy(plan);
    case 'aggregate':
      return { kind: 'hashAggregate', input: toPhysicalPlan(plan.input), groupBy: plan.groupBy, aggregates: plan.aggregates };
    case 'distinct':
      return { kind: 'distinct', input: toPhysicalPlan(plan.input) };
    case 'sort':
      return { kind: 'sort', input: toPhysicalPlan(plan.input), items: plan.items };
    case 'limit':
      return { kind: 'limit', input: toPhysicalPlan(plan.input), limit: plan.limit };
  }
}

/**
 * A hash join is chosen exactly when `on` is `columnA = columnB` with one column from each
 * side — the only shape a single hash table keyed by one side's join column can serve. Anything
 * else (a non-equality condition, a compound condition, a condition that isn't a bare column
 * comparison) falls back to nested-loop, which can evaluate any predicate `on` at all because it
 * simply re-evaluates it per candidate pair. This is the textbook trade-off: nested-loop is
 * universal but O(n·m); hash join is O(n+m) but only for equi-joins.
 */
function chooseJoinStrategy(join: LogicalJoin): PhysicalHashJoin | PhysicalNestedLoopJoin {
  const left = toPhysicalPlan(join.left);
  const right = toPhysicalPlan(join.right);
  const equiKeys = extractEquiJoinKeys(join);

  if (equiKeys !== undefined) {
    return { kind: 'hashJoin', left, right, joinKind: join.joinKind, leftKey: equiKeys.leftKey, rightKey: equiKeys.rightKey };
  }
  return { kind: 'nestedLoopJoin', left, right, joinKind: join.joinKind, on: join.on };
}

function extractEquiJoinKeys(join: LogicalJoin): { leftKey: BoundExpr; rightKey: BoundExpr } | undefined {
  const on = join.on;
  if (on.kind !== 'binary' || on.op !== '=') return undefined;
  if (on.left.kind !== 'column' || on.right.kind !== 'column') return undefined;

  const leftAliases = scanAliases(join.left);
  const rightAliases = scanAliases(join.right);

  if (leftAliases.has(on.left.source) && rightAliases.has(on.right.source)) {
    return { leftKey: on.left, rightKey: on.right };
  }
  if (leftAliases.has(on.right.source) && rightAliases.has(on.left.source)) {
    return { leftKey: on.right, rightKey: on.left };
  }
  return undefined;
}
