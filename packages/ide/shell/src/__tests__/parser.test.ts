import { describe, it, expect } from 'vitest';
import { tokenize, parse, ParseError } from '../parser.js';

describe('tokenize', () => {
  it('splits plain words on whitespace', () => {
    expect(tokenize('ls -la /tmp')).toEqual(['ls', '-la', '/tmp']);
  });

  it('collapses repeated whitespace', () => {
    expect(tokenize('echo   hi   there')).toEqual(['echo', 'hi', 'there']);
  });

  it('keeps a double-quoted string with embedded spaces as one token', () => {
    expect(tokenize('echo "hello world"')).toEqual(['echo', 'hello world']);
  });

  it('keeps a single-quoted string with embedded spaces as one token', () => {
    expect(tokenize("echo 'hello world'")).toEqual(['echo', 'hello world']);
  });

  it('handles an empty quoted string as an empty token', () => {
    expect(tokenize('echo ""')).toEqual(['echo', '']);
  });

  it('tokenizes pipes as standalone tokens', () => {
    expect(tokenize('cat a.txt | echo')).toEqual(['cat', 'a.txt', '|', 'echo']);
  });

  it('tokenizes multiple pipes', () => {
    expect(tokenize('cat a | cat | cat')).toEqual(['cat', 'a', '|', 'cat', '|', 'cat']);
  });

  it('tokenizes redirection operators', () => {
    expect(tokenize('echo hi > out.txt')).toEqual(['echo', 'hi', '>', 'out.txt']);
    expect(tokenize('echo hi >> out.txt')).toEqual(['echo', 'hi', '>>', 'out.txt']);
  });

  it('returns no tokens for empty or whitespace-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   \t  ')).toEqual([]);
  });

  it('throws on an unterminated quote', () => {
    expect(() => tokenize('echo "unterminated')).toThrow(ParseError);
  });
});

describe('parse', () => {
  it('parses a simple command with flags', () => {
    const pipeline = parse('mkdir -p /a/b');
    expect(pipeline.commands).toEqual([{ name: 'mkdir', args: ['-p', '/a/b'] }]);
  });

  it('parses a command with a quoted argument', () => {
    const pipeline = parse('echo "hello world"');
    expect(pipeline.commands).toEqual([{ name: 'echo', args: ['hello world'] }]);
  });

  it('parses -r flag', () => {
    const pipeline = parse('rm -r /a');
    expect(pipeline.commands[0]).toEqual({ name: 'rm', args: ['-r', '/a'] });
  });

  it('parses a two-stage pipeline', () => {
    const pipeline = parse('echo hi | cat');
    expect(pipeline.commands).toEqual([
      { name: 'echo', args: ['hi'] },
      { name: 'cat', args: [] },
    ]);
  });

  it('parses a three-stage pipeline', () => {
    const pipeline = parse('echo hi | cat | cat');
    expect(pipeline.commands).toHaveLength(3);
    expect(pipeline.commands.map((c) => c.name)).toEqual(['echo', 'cat', 'cat']);
  });

  it('returns an empty pipeline for blank input', () => {
    expect(parse('').commands).toEqual([]);
    expect(parse('   ').commands).toEqual([]);
  });

  it('parses redirection into the redirect field', () => {
    const pipeline = parse('echo hi > out.txt');
    expect(pipeline.commands[0]?.redirect).toEqual({ path: 'out.txt', append: false });
  });

  it('parses append redirection', () => {
    const pipeline = parse('echo hi >> out.txt');
    expect(pipeline.commands[0]?.redirect).toEqual({ path: 'out.txt', append: true });
  });

  it('throws when a pipe has no following command', () => {
    expect(() => parse('echo hi |')).toThrow(ParseError);
  });

  it('throws when redirection has no target', () => {
    expect(() => parse('echo hi >')).toThrow(ParseError);
  });
});
