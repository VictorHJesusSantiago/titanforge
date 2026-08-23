import { describe, expect, it } from 'vitest';
import { parse, ParseError } from '../parser.js';

describe('parse', () => {
  it('parses arithmetic with correct precedence (* before +)', () => {
    const program = parse('let x = 1 + 2 * 3;');
    const stmt = program.statements[0];
    expect(stmt?.kind).toBe('let');
    if (stmt?.kind !== 'let') throw new Error('expected let');
    expect(stmt.init).toEqual({
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 1 },
      right: { kind: 'binary', op: '*', left: { kind: 'number', value: 2 }, right: { kind: 'number', value: 3 } },
    });
  });

  it('parses parenthesized expressions overriding precedence', () => {
    const program = parse('let x = (1 + 2) * 3;');
    const stmt = program.statements[0];
    if (stmt?.kind !== 'let') throw new Error('expected let');
    expect(stmt.init).toEqual({
      kind: 'binary',
      op: '*',
      left: { kind: 'binary', op: '+', left: { kind: 'number', value: 1 }, right: { kind: 'number', value: 2 } },
      right: { kind: 'number', value: 3 },
    });
  });

  it('parses comparison and logical operators at lower precedence than arithmetic', () => {
    const program = parse('let x = 1 + 1 == 2 && 3 > 2;');
    const stmt = program.statements[0];
    if (stmt?.kind !== 'let') throw new Error('expected let');
    expect(stmt.init.kind).toBe('binary');
    if (stmt.init.kind === 'binary') {
      expect(stmt.init.op).toBe('&&');
    }
  });

  it('parses if/else with blocks', () => {
    const program = parse('if (x > 0) { print(1); } else { print(2); }');
    const stmt = program.statements[0];
    expect(stmt?.kind).toBe('if');
    if (stmt?.kind !== 'if') throw new Error('expected if');
    expect(stmt.then).toHaveLength(1);
    expect(stmt.else).toHaveLength(1);
  });

  it('parses if without an else branch', () => {
    const program = parse('if (x > 0) { print(1); }');
    const stmt = program.statements[0];
    if (stmt?.kind !== 'if') throw new Error('expected if');
    expect(stmt.else).toBeNull();
  });

  it('parses while loops', () => {
    const program = parse('while (x < 10) { x = x + 1; }');
    const stmt = program.statements[0];
    expect(stmt?.kind).toBe('while');
    if (stmt?.kind !== 'while') throw new Error('expected while');
    expect(stmt.body).toHaveLength(1);
  });

  it('parses function declarations with parameters and calls', () => {
    const program = parse('function add(a, b) { return a + b; } let x = add(1, 2);');
    expect(program.functions).toHaveLength(1);
    expect(program.functions[0]).toMatchObject({ name: 'add', params: ['a', 'b'] });
    const stmt = program.statements[0];
    if (stmt?.kind !== 'let') throw new Error('expected let');
    expect(stmt.init).toMatchObject({ kind: 'call', callee: 'add' });
  });

  it('parses nested blocks (while inside if)', () => {
    const program = parse('if (true) { while (x < 5) { x = x + 1; } }');
    const outer = program.statements[0];
    if (outer?.kind !== 'if') throw new Error('expected if');
    expect(outer.then[0]?.kind).toBe('while');
  });

  it('throws ParseError on malformed input', () => {
    expect(() => parse('let x = ;')).toThrow(ParseError);
  });

  it('throws ParseError on a missing closing brace', () => {
    expect(() => parse('if (true) { print(1);')).toThrow(ParseError);
  });
});
