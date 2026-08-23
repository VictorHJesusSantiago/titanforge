import { describe, it, expect } from 'vitest';
import { formatTable, formatQueryResult, formatError } from '../format.js';

describe('formatTable', () => {
  it('aligns columns to the widest cell (including the header) in each column', () => {
    const table = formatTable(['id', 'name'], [
      [1, 'Ada'],
      [2, 'Grace'],
    ]);
    expect(table).toBe(['id | name ', '---+------', '1  | Ada  ', '2  | Grace'].join('\n'));
  });

  it('prints NULL for a null cell, not an empty string', () => {
    const table = formatTable(['a'], [[null]]);
    expect(table).toContain('NULL');
  });

  it('shows "(0 rows)" for a result with columns but no rows', () => {
    const table = formatTable(['a', 'b'], []);
    expect(table).toBe(['a | b', '--+--', '(0 rows)'].join('\n'));
  });

  it('handles a zero-column result (e.g. a DDL-shaped select would never happen, but the function stays total)', () => {
    expect(formatTable([], [])).toBe('(0 columns)');
  });
});

describe('formatQueryResult', () => {
  it('renders a select result as a table', () => {
    const rendered = formatQueryResult({ kind: 'select', columns: ['a'], rows: [[1]] });
    expect(rendered).toContain('a');
    expect(rendered).toContain('1');
  });

  it('renders a mutation result as a row-count summary', () => {
    expect(formatQueryResult({ kind: 'mutation', rowsAffected: 3 })).toBe('3 row(s) affected');
  });

  it('renders a ddl result as OK', () => {
    expect(formatQueryResult({ kind: 'ddl', ok: true })).toBe('OK');
  });
});

describe('formatError', () => {
  it('prefixes an Error message with "Error:" and omits the stack trace', () => {
    const message = formatError(new Error('table "t" does not exist'));
    expect(message).toBe('Error: table "t" does not exist');
    expect(message).not.toContain('at ');
  });

  it('stringifies a non-Error thrown value', () => {
    expect(formatError('boom')).toBe('Error: boom');
  });
});
