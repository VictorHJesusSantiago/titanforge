import type { DataType } from '@titanforge/parser';

export interface ColumnSchema {
  name: string;
  type: DataType;
  primaryKey: boolean;
  notNull: boolean;
  /** Position within the table's row tuple — what the executor actually indexes by. */
  ordinal: number;
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
}

export function findColumn(table: TableSchema, name: string): ColumnSchema | undefined {
  return table.columns.find((c) => c.name === name);
}

export function primaryKeyColumn(table: TableSchema): ColumnSchema | undefined {
  return table.columns.find((c) => c.primaryKey);
}
