import { describe, expect, it } from 'vitest';
import { tokenize } from '../lexer.js';

describe('tokenize', () => {
  it('tokenizes numbers, including decimals', () => {
    const tokens = tokenize('42 3.14');
    expect(tokens[0]).toMatchObject({ kind: 'number', value: 42 });
    expect(tokens[1]).toMatchObject({ kind: 'number', value: 3.14 });
    expect(tokens[2]?.kind).toBe('eof');
  });

  it('tokenizes identifiers separately from keywords', () => {
    const tokens = tokenize('let x = foo');
    expect(tokens[0]).toMatchObject({ kind: 'keyword', keyword: 'let' });
    expect(tokens[1]).toMatchObject({ kind: 'identifier', name: 'x' });
    expect(tokens[2]).toMatchObject({ kind: 'punct', text: '=' });
    expect(tokens[3]).toMatchObject({ kind: 'identifier', name: 'foo' });
  });

  it('prefers two-character operators over their one-character prefixes', () => {
    const tokens = tokenize('a == b != c && d || !e');
    const puncts = tokens.filter((t) => t.kind === 'punct').map((t) => (t.kind === 'punct' ? t.text : ''));
    expect(puncts).toEqual(['==', '!=', '&&', '||', '!']);
  });

  it('tracks line numbers across newlines', () => {
    const tokens = tokenize('let a = 1;\nlet b = 2;');
    const secondLet = tokens.find((t, i) => t.kind === 'keyword' && t.keyword === 'let' && i > 0);
    expect(secondLet?.line).toBe(2);
  });

  it('skips line comments', () => {
    const tokens = tokenize('1 // this is a comment\n2');
    const numbers = tokens.filter((t) => t.kind === 'number');
    expect(numbers).toHaveLength(2);
  });

  it('throws LexError on an unrecognized character', () => {
    expect(() => tokenize('let x = @;')).toThrow(/Unexpected character/);
  });
});
