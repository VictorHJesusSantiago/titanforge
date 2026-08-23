import { describe, it, expect } from 'vitest';
import { tokenize, LexError } from '../lexer.js';

describe('tokenize', () => {
  it('tokenizes a simple SELECT', () => {
    const tokens = tokenize('SELECT a FROM t');
    expect(tokens.map((t) => t.kind)).toEqual(['keyword', 'identifier', 'keyword', 'identifier', 'eof']);
  });

  it('is case-insensitive for keywords but preserves identifier case', () => {
    const tokens = tokenize('select Foo from Bar');
    expect(tokens[0]).toMatchObject({ kind: 'keyword', keyword: 'SELECT' });
    expect(tokens[1]).toMatchObject({ kind: 'identifier', name: 'Foo' });
  });

  it('tokenizes integer and real number literals', () => {
    const tokens = tokenize('42 3.14');
    expect(tokens[0]).toMatchObject({ kind: 'number', value: 42, raw: '42' });
    expect(tokens[1]).toMatchObject({ kind: 'number', value: 3.14, raw: '3.14' });
  });

  it('tokenizes a plain string literal', () => {
    const tokens = tokenize(`'hello'`);
    expect(tokens[0]).toMatchObject({ kind: 'string', value: 'hello' });
  });

  it('tokenizes a backslash-escaped quote inside a string literal', () => {
    const tokens = tokenize("'it\\'s'");
    expect(tokens[0]).toMatchObject({ kind: 'string', value: "it's" });
  });

  it('throws LexError on an unterminated string', () => {
    expect(() => tokenize("'unterminated")).toThrow(LexError);
  });

  it('throws LexError on an unrecognized character', () => {
    expect(() => tokenize('SELECT @foo')).toThrow(LexError);
  });

  it('tokenizes two-character operators as single tokens', () => {
    const tokens = tokenize('a <= b <> c != d >= e');
    const puncts = tokens.filter((t) => t.kind === 'punct').map((t) => t.text);
    expect(puncts).toEqual(['<=', '<>', '!=', '>=']);
  });

  it('skips line comments', () => {
    const tokens = tokenize('SELECT a -- this is a comment\nFROM t');
    expect(tokens.map((t) => t.kind)).toEqual(['keyword', 'identifier', 'keyword', 'identifier', 'eof']);
  });

  it('distinguishes a leading-dot decimal from the dot punctuator', () => {
    const tokens = tokenize('.5');
    expect(tokens[0]).toMatchObject({ kind: 'number', value: 0.5 });
  });

  it('tokenizes a qualified column reference as identifier dot identifier', () => {
    const tokens = tokenize('t.col');
    expect(tokens.map((t) => t.kind)).toEqual(['identifier', 'punct', 'identifier', 'eof']);
  });

  it('every token records its source position', () => {
    const tokens = tokenize('SELECT a');
    expect(tokens[0]?.pos).toBe(0);
    expect(tokens[1]?.pos).toBe(7);
  });
});
