import { describe, it, expect } from 'vitest';
import { executeSelect } from '../index.js';
import { executePlan } from '../executor.js';
import { rowValues } from '../row.js';
import { makeSchema, planSelect, insertRows } from './test-helpers.js';
import type { Snapshot, SqlValue, StoredRow, TableStorage, TransactionId } from '@titanforge/storage-api';

describe('limit', () => {
  it('returns only the first N rows', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'a', 1],
      [2, 'b', 2],
      [3, 'c', 3],
    ]);
    const result = executeSelect(planSelect(catalog, 'SELECT id FROM users ORDER BY id LIMIT 2'), storage, storage.currentSnapshot());
    expect(result.rows).toEqual([[1], [2]]);
  });

  it('LIMIT 0 yields no rows', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [[1, 'a', 1]]);
    const result = executeSelect(planSelect(catalog, 'SELECT id FROM users LIMIT 0'), storage, storage.currentSnapshot());
    expect(result.rows).toEqual([]);
  });

  it('genuinely stops pulling from its input once satisfied — proven by counting rows an underlying scan actually produces, not just the final row count', () => {
    const { catalog, storage } = makeSchema();
    const rows: SqlValue[][] = [];
    for (let i = 1; i <= 1000; i += 1) rows.push([i, `user${i}`, i]);
    insertRows(storage, 'users', rows);

    let pulled = 0;
    const realTable = storage.getTable('users');
    const countingTable: TableStorage = {
      scan(snapshot: Snapshot): IterableIterator<StoredRow> {
        const inner = realTable.scan(snapshot);
        function* wrap(): IterableIterator<StoredRow> {
          for (const row of inner) {
            pulled += 1;
            yield row;
          }
        }
        return wrap();
      },
      insert: (values, txn: TransactionId) => realTable.insert(values, txn),
      update: (id, values, txn: TransactionId) => realTable.update(id, values, txn),
      delete: (id, txn: TransactionId) => realTable.delete(id, txn),
    };
    // Swap in the counting proxy so the physical plan below reads through it — `getTable` is the
    // only entry point the executor ever uses to reach a table's storage.
    (storage as unknown as { tables: Map<string, TableStorage> }).tables.set('users', countingTable);

    const planned = planSelect(catalog, 'SELECT id FROM users LIMIT 5');
    const out = [...executePlan(planned.plan, storage, storage.currentSnapshot())].map(rowValues);

    expect(out).toHaveLength(5);
    expect(pulled).toBe(5); // not 1000 — a bare (unsorted) LIMIT never materializes the whole scan
  });
});
