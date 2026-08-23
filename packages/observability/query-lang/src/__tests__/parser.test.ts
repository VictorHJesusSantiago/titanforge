import { describe, expect, it } from 'vitest';
import { parseQuery, QueryParseError } from '../parser.js';
import type { QueryAst } from '../ast.js';

describe('parseQuery', () => {
  it('parses a single comparison', () => {
    const ast = parseQuery('service = "api"');
    expect(ast).toEqual({
      kind: 'comparison',
      field: { kind: 'field', name: 'service' },
      op: '=',
      value: { kind: 'string', value: 'api' },
    });
  });

  it('parses a numeric comparison', () => {
    const ast = parseQuery('duration > 100');
    expect(ast).toEqual({
      kind: 'comparison',
      field: { kind: 'field', name: 'duration' },
      op: '>',
      value: { kind: 'number', value: 100 },
    });
  });

  it('parses an attr.<key> field reference', () => {
    const ast = parseQuery('attr.http_method = "GET"');
    expect(ast).toEqual({
      kind: 'comparison',
      field: { kind: 'attr', key: 'http_method' },
      op: '=',
      value: { kind: 'string', value: 'GET' },
    });
  });

  it('parses all six comparison operators', () => {
    const ops = ['=', '!=', '>', '>=', '<', '<='] as const;
    for (const op of ops) {
      const ast = parseQuery(`duration ${op} 5`);
      expect(ast).toEqual({
        kind: 'comparison',
        field: { kind: 'field', name: 'duration' },
        op,
        value: { kind: 'number', value: 5 },
      });
    }
  });

  it('parses AND as left-associative', () => {
    const ast = parseQuery('service = "a" AND name = "b" AND status = "c"');
    expect(ast).toEqual({
      kind: 'and',
      left: {
        kind: 'and',
        left: { kind: 'comparison', field: { kind: 'field', name: 'service' }, op: '=', value: { kind: 'string', value: 'a' } },
        right: { kind: 'comparison', field: { kind: 'field', name: 'name' }, op: '=', value: { kind: 'string', value: 'b' } },
      },
      right: { kind: 'comparison', field: { kind: 'field', name: 'status' }, op: '=', value: { kind: 'string', value: 'c' } },
    });
  });

  it('gives AND higher precedence than OR: "a OR b AND c" parses as "a OR (b AND c)"', () => {
    const ast = parseQuery('service = "a" OR service = "b" AND service = "c"');
    expect(ast.kind).toBe('or');
    if (ast.kind !== 'or') throw new Error('unreachable');
    expect(ast.left).toEqual({ kind: 'comparison', field: { kind: 'field', name: 'service' }, op: '=', value: { kind: 'string', value: 'a' } });
    expect(ast.right.kind).toBe('and');
  });

  it('parentheses override precedence: "(a OR b) AND c"', () => {
    const ast = parseQuery('(service = "a" OR service = "b") AND service = "c"');
    expect(ast.kind).toBe('and');
    if (ast.kind !== 'and') throw new Error('unreachable');
    expect(ast.left.kind).toBe('or');
  });

  it('parses NOT as binding tighter than AND/OR', () => {
    const ast = parseQuery('NOT status = "error" AND service = "api"');
    expect(ast).toEqual({
      kind: 'and',
      left: {
        kind: 'not',
        expr: { kind: 'comparison', field: { kind: 'field', name: 'status' }, op: '=', value: { kind: 'string', value: 'error' } },
      },
      right: { kind: 'comparison', field: { kind: 'field', name: 'service' }, op: '=', value: { kind: 'string', value: 'api' } },
    });
  });

  it('parses the full example query from the spec', () => {
    const ast = parseQuery('service = "api" AND duration > 100 AND status = "error"');
    const expected: QueryAst = {
      kind: 'and',
      left: {
        kind: 'and',
        left: { kind: 'comparison', field: { kind: 'field', name: 'service' }, op: '=', value: { kind: 'string', value: 'api' } },
        right: { kind: 'comparison', field: { kind: 'field', name: 'duration' }, op: '>', value: { kind: 'number', value: 100 } },
      },
      right: { kind: 'comparison', field: { kind: 'field', name: 'status' }, op: '=', value: { kind: 'string', value: 'error' } },
    };
    expect(ast).toEqual(expected);
  });

  it('supports single-quoted strings', () => {
    const ast = parseQuery("service = 'api'");
    expect(ast).toEqual({ kind: 'comparison', field: { kind: 'field', name: 'service' }, op: '=', value: { kind: 'string', value: 'api' } });
  });

  it('throws QueryParseError with a position for an unknown field', () => {
    expect(() => parseQuery('bogus = 1')).toThrow(QueryParseError);
    try {
      parseQuery('bogus = 1');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QueryParseError);
      expect((e as InstanceType<typeof QueryParseError>).pos).toBe(0);
    }
  });

  it('throws QueryParseError for a missing operator', () => {
    expect(() => parseQuery('service "api"')).toThrow(QueryParseError);
  });

  it('throws QueryParseError for an unterminated string', () => {
    expect(() => parseQuery('service = "api')).toThrow();
  });

  it('throws QueryParseError for trailing garbage input', () => {
    expect(() => parseQuery('service = "api" )')).toThrow(QueryParseError);
  });

  it('throws QueryParseError for an unclosed parenthesis', () => {
    expect(() => parseQuery('(service = "api"')).toThrow(QueryParseError);
  });

  it('throws QueryParseError for a value where a field is expected', () => {
    expect(() => parseQuery('= "api"')).toThrow(QueryParseError);
  });
});
