import type { SqlValue } from '@titanforge/storage-api';

/**
 * A discriminated union rather than one loose shape — a caller switches on `.kind` instead of
 * guessing which fields are present ("does this result have `rows`? Only sometimes, silently").
 */
export type QueryResult = SelectResult | MutationResult | DdlResult;

export interface SelectResult {
  kind: 'select';
  columns: string[];
  rows: SqlValue[][];
}

/** `INSERT` / `UPDATE` / `DELETE`. */
export interface MutationResult {
  kind: 'mutation';
  rowsAffected: number;
}

/** `CREATE TABLE` / `DROP TABLE`. */
export interface DdlResult {
  kind: 'ddl';
  ok: true;
}
