import { parseStatement } from '@titanforge/parser';
import { Binder, Catalog } from '@titanforge/catalog';
import { plan as planStatement, type PhysicalPlan, type PlannedSelect } from '@titanforge/planner';
import { MemoryStorageEngine } from '@titanforge/storage-memory';
import type { SqlValue } from '@titanforge/storage-api';

/** A `users(id, name, age)` / `orders(id, user_id, total)` schema, present in both the catalog (for binding/planning) and a fresh `MemoryStorageEngine` (for actually reading/writing rows) — set up together so a test never has to keep the two in sync by hand. */
export function makeSchema(): { catalog: Catalog; storage: MemoryStorageEngine } {
  const catalog = new Catalog();
  catalog.createTable(
    'users',
    [
      { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
      { name: 'name', type: 'TEXT', primaryKey: false, notNull: true },
      { name: 'age', type: 'INTEGER', primaryKey: false, notNull: false },
    ],
    false,
  );
  catalog.createTable(
    'orders',
    [
      { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
      { name: 'user_id', type: 'INTEGER', primaryKey: false, notNull: false },
      { name: 'total', type: 'REAL', primaryKey: false, notNull: false },
    ],
    false,
  );

  const storage = new MemoryStorageEngine();
  storage.createTable('users');
  storage.createTable('orders');

  return { catalog, storage };
}

export function planSelect(catalog: Catalog, sql: string): PlannedSelect {
  const bound = new Binder(catalog).bind(parseStatement(sql));
  const planned = planStatement(bound);
  if (planned.kind !== 'select') throw new Error(`expected a select plan, got "${planned.kind}"`);
  return planned;
}

/** Autocommit-style bulk insert: one transaction, every row, then commit — mirrors what `@titanforge/engine` will do for a real `INSERT`. */
export function insertRows(storage: MemoryStorageEngine, tableName: string, rows: SqlValue[][]): void {
  const table = storage.getTable(tableName);
  const { txn } = storage.beginTransaction();
  for (const row of rows) table.insert(row, txn);
  storage.commit(txn);
}

/** Finds the first node of the given `kind` anywhere in a physical plan tree (depth-first). Used by join tests to swap a planner-chosen `hashJoin` for an equivalent hand-built `nestedLoopJoin` and cross-check the two algorithms agree. */
export function findNode<K extends PhysicalPlan['kind']>(plan: PhysicalPlan, kind: K): Extract<PhysicalPlan, { kind: K }> {
  if (plan.kind === kind) return plan as Extract<PhysicalPlan, { kind: K }>;
  switch (plan.kind) {
    case 'seqScan':
    case 'singleRow':
      throw new Error(`node of kind "${kind}" not found`);
    case 'nestedLoopJoin':
    case 'hashJoin':
      try {
        return findNode(plan.left, kind);
      } catch {
        return findNode(plan.right, kind);
      }
    default:
      return findNode(plan.input, kind);
  }
}

/** Rebuilds a physical plan tree, replacing every occurrence of `target` with `replacement` (by reference equality) — used to swap one join node for another while keeping the rest of the tree (project, filter, etc.) intact. */
export function replaceNode(plan: PhysicalPlan, target: PhysicalPlan, replacement: PhysicalPlan): PhysicalPlan {
  if (plan === target) return replacement;
  switch (plan.kind) {
    case 'seqScan':
    case 'singleRow':
      return plan;
    case 'filter':
      return { ...plan, input: replaceNode(plan.input, target, replacement) };
    case 'project':
      return { ...plan, input: replaceNode(plan.input, target, replacement) };
    case 'nestedLoopJoin':
    case 'hashJoin':
      return { ...plan, left: replaceNode(plan.left, target, replacement), right: replaceNode(plan.right, target, replacement) };
    case 'hashAggregate':
      return { ...plan, input: replaceNode(plan.input, target, replacement) };
    case 'distinct':
      return { ...plan, input: replaceNode(plan.input, target, replacement) };
    case 'sort':
      return { ...plan, input: replaceNode(plan.input, target, replacement) };
    case 'limit':
      return { ...plan, input: replaceNode(plan.input, target, replacement) };
  }
}
