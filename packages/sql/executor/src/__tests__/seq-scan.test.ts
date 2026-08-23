import { describe, it, expect } from 'vitest';
import { executePlan } from '../executor.js';
import { rowValues } from '../row.js';
import { makeSchema, planSelect, insertRows } from './test-helpers.js';
import type { PhysicalSeqScan } from '@titanforge/planner';

describe('seqScan', () => {
  it('reads every row and projects down to the declared columns, in schema order', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [
      [1, 'Ada', 30],
      [2, 'Grace', 40],
    ]);
    const planned = planSelect(catalog, 'SELECT id, name FROM users');
    const rows = [...executePlan(planned.plan, storage, storage.currentSnapshot())].map(rowValues);
    expect(rows).toEqual([
      [1, 'Ada'],
      [2, 'Grace'],
    ]);
  });

  it('a bare seqScan (no project above it) only reads the columns named on the node, ignoring the rest of the stored row', () => {
    const { catalog, storage } = makeSchema();
    insertRows(storage, 'users', [[1, 'Ada', 30]]);
    const table = catalog.getTable('users');
    const scanAllColumns: PhysicalSeqScan = { kind: 'seqScan', table, alias: 'users', columns: undefined };
    const scanOneColumn: PhysicalSeqScan = { kind: 'seqScan', table, alias: 'users', columns: ['name'] };

    const full = [...executePlan(scanAllColumns, storage, storage.currentSnapshot())];
    expect(full[0]!.frames[0]).toMatchObject({ kind: 'table', alias: 'users', columns: ['id', 'name', 'age'], values: [1, 'Ada', 30] });

    const narrow = [...executePlan(scanOneColumn, storage, storage.currentSnapshot())];
    expect(narrow[0]!.frames[0]).toMatchObject({ kind: 'table', alias: 'users', columns: ['name'], values: ['Ada'] });
  });

  it('an empty table scans to zero rows', () => {
    const { catalog, storage } = makeSchema();
    const planned = planSelect(catalog, 'SELECT id FROM users');
    const rows = [...executePlan(planned.plan, storage, storage.currentSnapshot())];
    expect(rows).toHaveLength(0);
  });
});

describe('singleRow', () => {
  it('a FROM-less SELECT evaluates against exactly one zero-column row', () => {
    const { catalog, storage } = makeSchema();
    const planned = planSelect(catalog, 'SELECT 1 + 1 AS two');
    const rows = [...executePlan(planned.plan, storage, storage.currentSnapshot())].map(rowValues);
    expect(rows).toEqual([[2]]);
  });
});
