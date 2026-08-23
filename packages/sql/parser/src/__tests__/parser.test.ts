import { describe, it, expect } from 'vitest';
import { parseStatement, parseScript, ParseError } from '../parser.js';
import type { SelectStmt } from '../ast.js';

describe('parseStatement — CREATE TABLE', () => {
  it('parses columns with types and constraints', () => {
    const stmt = parseStatement('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)');
    expect(stmt).toEqual({
      kind: 'createTable',
      table: 'users',
      ifNotExists: false,
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, notNull: false },
        { name: 'name', type: 'TEXT', primaryKey: false, notNull: true },
        { name: 'age', type: 'INTEGER', primaryKey: false, notNull: false },
      ],
    });
  });

  it('parses IF NOT EXISTS', () => {
    const stmt = parseStatement('CREATE TABLE IF NOT EXISTS t (a INTEGER)');
    expect(stmt).toMatchObject({ kind: 'createTable', ifNotExists: true });
  });
});

describe('parseStatement — DROP TABLE', () => {
  it('parses a plain drop and an IF EXISTS drop', () => {
    expect(parseStatement('DROP TABLE t')).toEqual({ kind: 'dropTable', table: 't', ifExists: false });
    expect(parseStatement('DROP TABLE IF EXISTS t')).toEqual({ kind: 'dropTable', table: 't', ifExists: true });
  });
});

describe('parseStatement — INSERT', () => {
  it('parses an explicit column list with one row', () => {
    const stmt = parseStatement(`INSERT INTO t (a, b) VALUES (1, 'x')`);
    expect(stmt).toEqual({
      kind: 'insert',
      table: 't',
      columns: ['a', 'b'],
      values: [[{ kind: 'literal', value: { type: 'integer', value: 1 } }, { kind: 'literal', value: { type: 'text', value: 'x' } }]],
    });
  });

  it('parses multiple value rows and an omitted column list', () => {
    const stmt = parseStatement('INSERT INTO t VALUES (1), (2), (3)');
    expect(stmt.kind).toBe('insert');
    if (stmt.kind !== 'insert') throw new Error('unreachable');
    expect(stmt.columns).toBeUndefined();
    expect(stmt.values).toHaveLength(3);
  });
});

describe('parseStatement — UPDATE / DELETE', () => {
  it('parses UPDATE with multiple assignments and a WHERE clause', () => {
    const stmt = parseStatement(`UPDATE t SET a = 1, b = 'x' WHERE id = 5`);
    expect(stmt).toMatchObject({
      kind: 'update',
      table: 't',
      assignments: [
        { column: 'a', value: { kind: 'literal', value: { type: 'integer', value: 1 } } },
        { column: 'b', value: { kind: 'literal', value: { type: 'text', value: 'x' } } },
      ],
    });
  });

  it('parses DELETE with and without WHERE', () => {
    expect(parseStatement('DELETE FROM t')).toMatchObject({ kind: 'delete', table: 't', where: undefined });
    expect(parseStatement('DELETE FROM t WHERE id = 1')).toMatchObject({ kind: 'delete', table: 't' });
  });
});

describe('parseStatement — SELECT', () => {
  it('parses a bare SELECT with no FROM', () => {
    const stmt = parseStatement('SELECT 1 + 1') as SelectStmt;
    expect(stmt.from).toBeUndefined();
    expect(stmt.columns).toHaveLength(1);
  });

  it('parses SELECT * FROM', () => {
    const stmt = parseStatement('SELECT * FROM t') as SelectStmt;
    expect(stmt.columns).toEqual([{ expr: { kind: 'star' }, alias: undefined }]);
    expect(stmt.from).toEqual({ table: 't', alias: undefined });
  });

  it('parses column aliases, with and without AS', () => {
    const stmt = parseStatement('SELECT a AS x, b y FROM t') as SelectStmt;
    expect(stmt.columns[0]?.alias).toBe('x');
    expect(stmt.columns[1]?.alias).toBe('y');
  });

  it('parses DISTINCT', () => {
    const stmt = parseStatement('SELECT DISTINCT a FROM t') as SelectStmt;
    expect(stmt.distinct).toBe(true);
  });

  it('parses a table alias', () => {
    const stmt = parseStatement('SELECT a FROM t AS x') as SelectStmt;
    expect(stmt.from).toEqual({ table: 't', alias: 'x' });
  });

  it('parses an INNER JOIN and a LEFT JOIN', () => {
    const stmt = parseStatement('SELECT * FROM a JOIN b ON a.id = b.a_id LEFT JOIN c ON b.id = c.b_id') as SelectStmt;
    expect(stmt.joins).toHaveLength(2);
    expect(stmt.joins[0]?.joinKind).toBe('inner');
    expect(stmt.joins[1]?.joinKind).toBe('left');
  });

  it('parses WHERE with operator precedence: AND binds tighter than OR', () => {
    const stmt = parseStatement('SELECT * FROM t WHERE a = 1 OR b = 2 AND c = 3') as SelectStmt;
    // Expect: a=1 OR (b=2 AND c=3)
    expect(stmt.where).toMatchObject({
      kind: 'binary',
      op: 'OR',
      right: { kind: 'binary', op: 'AND' },
    });
  });

  it('parses arithmetic precedence: * binds tighter than +', () => {
    const stmt = parseStatement('SELECT 1 + 2 * 3') as SelectStmt;
    const expr = stmt.columns[0]?.expr;
    expect(expr).toMatchObject({
      kind: 'binary',
      op: '+',
      left: { kind: 'literal', value: { type: 'integer', value: 1 } },
      right: { kind: 'binary', op: '*' },
    });
  });

  it('parses parentheses overriding precedence', () => {
    const stmt = parseStatement('SELECT (1 + 2) * 3') as SelectStmt;
    expect(stmt.columns[0]?.expr).toMatchObject({ kind: 'binary', op: '*', left: { kind: 'binary', op: '+' } });
  });

  it('parses unary minus and NOT', () => {
    const stmt = parseStatement('SELECT -a, NOT b FROM t') as SelectStmt;
    expect(stmt.columns[0]?.expr).toEqual({ kind: 'unary', op: '-', expr: { kind: 'column', table: undefined, name: 'a' } });
    expect(stmt.columns[1]?.expr).toEqual({ kind: 'unary', op: 'NOT', expr: { kind: 'column', table: undefined, name: 'b' } });
  });

  it('parses a qualified column reference', () => {
    const stmt = parseStatement('SELECT t.a FROM t') as SelectStmt;
    expect(stmt.columns[0]?.expr).toEqual({ kind: 'column', table: 't', name: 'a' });
  });

  it('parses a function call, including COUNT(*) and DISTINCT', () => {
    const stmt = parseStatement('SELECT COUNT(*), COUNT(DISTINCT a), SUM(b) FROM t') as SelectStmt;
    expect(stmt.columns[0]?.expr).toEqual({ kind: 'call', name: 'COUNT', args: [{ kind: 'star' }], distinct: false });
    expect(stmt.columns[1]?.expr).toEqual({ kind: 'call', name: 'COUNT', args: [{ kind: 'column', table: undefined, name: 'a' }], distinct: true });
  });

  it('parses GROUP BY, ORDER BY (with ASC/DESC), and LIMIT', () => {
    const stmt = parseStatement('SELECT a, COUNT(*) FROM t GROUP BY a ORDER BY a DESC, b LIMIT 10') as SelectStmt;
    expect(stmt.groupBy).toEqual([{ kind: 'column', table: undefined, name: 'a' }]);
    expect(stmt.orderBy).toEqual([
      { expr: { kind: 'column', table: undefined, name: 'a' }, direction: 'DESC' },
      { expr: { kind: 'column', table: undefined, name: 'b' }, direction: 'ASC' },
    ]);
    expect(stmt.limit).toBe(10);
  });

  it('parses all comparison operators', () => {
    for (const [src, op] of [['=', '='], ['!=', '!='], ['<>', '!='], ['<', '<'], ['<=', '<='], ['>', '>'], ['>=', '>=']] as const) {
      const stmt = parseStatement(`SELECT * FROM t WHERE a ${src} 1`) as SelectStmt;
      expect(stmt.where).toMatchObject({ kind: 'binary', op });
    }
  });
});

describe('parseStatement — errors', () => {
  it('throws ParseError with a position for a syntax error', () => {
    try {
      parseStatement('SELECT FROM');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).pos).toBeGreaterThanOrEqual(0);
    }
  });

  it('throws on trailing garbage after a complete statement', () => {
    expect(() => parseStatement('SELECT 1 SELECT 2')).toThrow(ParseError);
  });

  it('throws a clear error for an unrecognized statement keyword', () => {
    expect(() => parseStatement('FROB t')).toThrow(ParseError);
  });
});

describe('parseScript', () => {
  it('parses multiple semicolon-separated statements', () => {
    const statements = parseScript('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1); SELECT * FROM t;');
    expect(statements.map((s) => s.kind)).toEqual(['createTable', 'insert', 'select']);
  });

  it('parses a script with no trailing semicolon on the last statement', () => {
    const statements = parseScript('SELECT 1; SELECT 2');
    expect(statements).toHaveLength(2);
  });

  it('returns an empty array for an empty script', () => {
    expect(parseScript('')).toEqual([]);
    expect(parseScript('   ')).toEqual([]);
  });
});
