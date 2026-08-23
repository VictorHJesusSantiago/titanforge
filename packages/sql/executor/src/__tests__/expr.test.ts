import { describe, it, expect } from 'vitest';
import type { BoundExpr } from '@titanforge/catalog';
import { evaluate, ExecutionError } from '../expr.js';

function litInt(value: number): BoundExpr {
  return { kind: 'literal', value: { type: 'integer', value }, type: 'INTEGER' };
}
function litReal(value: number): BoundExpr {
  return { kind: 'literal', value: { type: 'real', value }, type: 'REAL' };
}
function litText(value: string): BoundExpr {
  return { kind: 'literal', value: { type: 'text', value }, type: 'TEXT' };
}
function litBool(value: boolean): BoundExpr {
  return { kind: 'literal', value: { type: 'boolean', value }, type: 'BOOLEAN' };
}
const NULL: BoundExpr = { kind: 'literal', value: { type: 'null' }, type: 'NULL' };

function bin(op: string, left: BoundExpr, right: BoundExpr): BoundExpr {
  return { kind: 'binary', op: op as never, left, right, type: 'BOOLEAN' };
}
function unary(op: '-' | 'NOT', expr: BoundExpr): BoundExpr {
  return { kind: 'unary', op, expr, type: 'BOOLEAN' };
}
function call(name: string, args: BoundExpr[]): BoundExpr {
  return { kind: 'call', name, args, distinct: false, type: 'TEXT', isAggregate: false };
}

describe('evaluate — literals', () => {
  it('returns a literal value as-is, and NULL literal as null', () => {
    expect(evaluate(litInt(42), [])).toBe(42);
    expect(evaluate(litText('hi'), [])).toBe('hi');
    expect(evaluate(litBool(true), [])).toBe(true);
    expect(evaluate(NULL, [])).toBeNull();
  });
});

describe('evaluate — unary', () => {
  it('negates a number', () => {
    expect(evaluate(unary('-', litInt(5)), [])).toBe(-5);
  });
  it('-NULL = NULL', () => {
    expect(evaluate(unary('-', NULL), [])).toBeNull();
  });
  it('NOT true = false, NOT false = true', () => {
    expect(evaluate(unary('NOT', litBool(true)), [])).toBe(false);
    expect(evaluate(unary('NOT', litBool(false)), [])).toBe(true);
  });
  it('NOT NULL = NULL', () => {
    expect(evaluate(unary('NOT', NULL), [])).toBeNull();
  });
});

describe('evaluate — arithmetic with NULL propagation', () => {
  it('computes +, -, *, / normally', () => {
    expect(evaluate(bin('+', litInt(2), litInt(3)), [])).toBe(5);
    expect(evaluate(bin('-', litInt(5), litInt(3)), [])).toBe(2);
    expect(evaluate(bin('*', litInt(4), litInt(3)), [])).toBe(12);
    expect(evaluate(bin('/', litReal(10), litReal(4)), [])).toBe(2.5);
    expect(evaluate(bin('%', litInt(10), litInt(3)), [])).toBe(1);
  });

  it('any arithmetic op with a NULL operand is NULL', () => {
    for (const op of ['+', '-', '*', '/', '%']) {
      expect(evaluate(bin(op, NULL, litInt(1)), [])).toBeNull();
      expect(evaluate(bin(op, litInt(1), NULL), [])).toBeNull();
    }
  });

  it('division by zero throws a clear ExecutionError, not Infinity/NaN', () => {
    expect(() => evaluate(bin('/', litInt(1), litInt(0)), [])).toThrow(ExecutionError);
    expect(() => evaluate(bin('/', litInt(1), litInt(0)), [])).toThrow(/division by zero/);
  });

  it('modulo by zero also throws', () => {
    expect(() => evaluate(bin('%', litInt(1), litInt(0)), [])).toThrow(ExecutionError);
  });
});

describe('evaluate — comparisons with NULL propagation', () => {
  it('compares numbers and text normally', () => {
    expect(evaluate(bin('=', litInt(1), litInt(1)), [])).toBe(true);
    expect(evaluate(bin('!=', litInt(1), litInt(2)), [])).toBe(true);
    expect(evaluate(bin('<', litInt(1), litInt(2)), [])).toBe(true);
    expect(evaluate(bin('>=', litText('b'), litText('a')), [])).toBe(true);
  });

  it('any comparison with a NULL operand is NULL, not true or false', () => {
    for (const op of ['=', '!=', '<', '<=', '>', '>=']) {
      expect(evaluate(bin(op, NULL, litInt(1)), [])).toBeNull();
      expect(evaluate(bin(op, litInt(1), NULL), [])).toBeNull();
      expect(evaluate(bin(op, NULL, NULL), [])).toBeNull();
    }
  });
});

describe('evaluate — three-valued AND/OR', () => {
  it('AND truth table', () => {
    expect(evaluate(bin('AND', litBool(true), litBool(true)), [])).toBe(true);
    expect(evaluate(bin('AND', litBool(true), litBool(false)), [])).toBe(false);
    expect(evaluate(bin('AND', litBool(false), litBool(true)), [])).toBe(false);
    expect(evaluate(bin('AND', litBool(false), litBool(false)), [])).toBe(false);
    // NULL AND false = false (false dominates)
    expect(evaluate(bin('AND', NULL, litBool(false)), [])).toBe(false);
    expect(evaluate(bin('AND', litBool(false), NULL), [])).toBe(false);
    // NULL AND true = NULL
    expect(evaluate(bin('AND', NULL, litBool(true)), [])).toBeNull();
    expect(evaluate(bin('AND', litBool(true), NULL), [])).toBeNull();
    expect(evaluate(bin('AND', NULL, NULL), [])).toBeNull();
  });

  it('OR truth table', () => {
    expect(evaluate(bin('OR', litBool(true), litBool(true)), [])).toBe(true);
    expect(evaluate(bin('OR', litBool(true), litBool(false)), [])).toBe(true);
    expect(evaluate(bin('OR', litBool(false), litBool(true)), [])).toBe(true);
    expect(evaluate(bin('OR', litBool(false), litBool(false)), [])).toBe(false);
    // NULL OR true = true (true dominates)
    expect(evaluate(bin('OR', NULL, litBool(true)), [])).toBe(true);
    expect(evaluate(bin('OR', litBool(true), NULL), [])).toBe(true);
    // NULL OR false = NULL
    expect(evaluate(bin('OR', NULL, litBool(false)), [])).toBeNull();
    expect(evaluate(bin('OR', litBool(false), NULL), [])).toBeNull();
    expect(evaluate(bin('OR', NULL, NULL), [])).toBeNull();
  });

  it('AND short-circuits: a false left operand never evaluates the right (division by zero would otherwise throw)', () => {
    const rightThatWouldThrow = bin('=', bin('/', litInt(1), litInt(0)), litInt(1));
    expect(evaluate(bin('AND', litBool(false), rightThatWouldThrow), [])).toBe(false);
  });

  it('OR short-circuits: a true left operand never evaluates the right', () => {
    const rightThatWouldThrow = bin('=', bin('/', litInt(1), litInt(0)), litInt(1));
    expect(evaluate(bin('OR', litBool(true), rightThatWouldThrow), [])).toBe(true);
  });
});

describe('evaluate — scalar functions', () => {
  it('UPPER / LOWER', () => {
    expect(evaluate(call('UPPER', [litText('hi')]), [])).toBe('HI');
    expect(evaluate(call('LOWER', [litText('HI')]), [])).toBe('hi');
  });
  it('LENGTH', () => {
    expect(evaluate(call('LENGTH', [litText('hello')]), [])).toBe(5);
  });
  it('ABS', () => {
    expect(evaluate(call('ABS', [litInt(-7)]), [])).toBe(7);
    expect(evaluate(call('ABS', [litInt(7)]), [])).toBe(7);
  });
  it('COALESCE returns the first non-NULL argument', () => {
    expect(evaluate(call('COALESCE', [NULL, NULL, litInt(3), litInt(4)]), [])).toBe(3);
    expect(evaluate(call('COALESCE', [NULL, NULL]), [])).toBeNull();
  });
  it('UPPER/LOWER/LENGTH/ABS of NULL is NULL', () => {
    expect(evaluate(call('UPPER', [NULL]), [])).toBeNull();
    expect(evaluate(call('LOWER', [NULL]), [])).toBeNull();
    expect(evaluate(call('LENGTH', [NULL]), [])).toBeNull();
    expect(evaluate(call('ABS', [NULL]), [])).toBeNull();
  });
  it('throws ExecutionError for an unknown function', () => {
    expect(() => evaluate(call('NOPE', [litInt(1)]), [])).toThrow(ExecutionError);
  });
});
