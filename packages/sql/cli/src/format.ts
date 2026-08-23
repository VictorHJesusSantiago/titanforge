import type { QueryResult } from '@titanforge/engine';
import type { SqlValue } from '@titanforge/storage-api';

/** How one `SqlValue` prints in the ASCII table — `NULL` spelled out (bare `null` printed as an empty cell would be indistinguishable from an empty string). */
function formatCell(value: SqlValue): string {
  if (value === null) return 'NULL';
  return String(value);
}

/**
 * Renders `{ columns, rows }` as a simple aligned ASCII table:
 *
 * ```
 * id | name
 * ---+------
 * 1  | Ada
 * 2  | Grace
 * ```
 *
 * Pure formatting logic — no I/O — so it's unit-testable on its own, matching this project's
 * convention (documented across the other packages) of keeping I/O glue thin and untested while
 * the logic it wraps is thoroughly tested.
 */
export function formatTable(columns: string[], rows: SqlValue[][]): string {
  if (columns.length === 0) return '(0 columns)';

  const cells = rows.map((row) => row.map(formatCell));
  const widths = columns.map((col, i) => Math.max(col.length, ...cells.map((row) => row[i]?.length ?? 0)));

  const formatRow = (values: string[]): string => values.map((v, i) => v.padEnd(widths[i]!)).join(' | ');

  const header = formatRow(columns);
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-');
  const body = cells.map((row) => formatRow(row));

  const lines = [header, separator, ...body];
  if (rows.length === 0) lines.push('(0 rows)');
  return lines.join('\n');
}

/** Renders any `QueryResult` for terminal display — a table for `SELECT`, a one-line summary for a mutation or DDL statement. */
export function formatQueryResult(result: QueryResult): string {
  switch (result.kind) {
    case 'select':
      return formatTable(result.columns, result.rows);
    case 'mutation':
      return `${result.rowsAffected} row(s) affected`;
    case 'ddl':
      return 'OK';
  }
}

/** A clear, single-line error message for anything that fails to parse/bind/plan/execute — never a raw stack trace. */
export function formatError(error: unknown): string {
  if (error instanceof Error) return `Error: ${error.message}`;
  return `Error: ${String(error)}`;
}
