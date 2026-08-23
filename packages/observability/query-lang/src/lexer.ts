/**
 * The tokenizer for the span query language, deliberately mirroring `@titanforge/parser`'s
 * lexer: a discriminated union of token kinds so the parser never casts, tokenized eagerly into
 * an array (queries here are a single short filter expression, never worth streaming), and real
 * character-offset positions on every token so parse errors can point at the offending character.
 */

export const KEYWORDS = ['AND', 'OR', 'NOT'] as const;
export type Keyword = (typeof KEYWORDS)[number];

const KEYWORD_SET = new Set<string>(KEYWORDS);

function isKeyword(word: string): word is Keyword {
  return KEYWORD_SET.has(word);
}

export type PunctText = '(' | ')' | '.' | '=' | '!=' | '>' | '>=' | '<' | '<=';

export type Token =
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'identifier'; name: string; pos: number }
  | { kind: 'keyword'; keyword: Keyword; pos: number }
  | { kind: 'punct'; text: PunctText; pos: number }
  | { kind: 'eof'; pos: number };

export class LexError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(`${message} at position ${pos}`);
    this.name = 'LexError';
  }
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  const peekChar = (offset = 0): string => source[i + offset] ?? '\0';

  while (i < n) {
    const c = peekChar();

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }

    const start = i;

    if (isDigit(c) || (c === '.' && isDigit(peekChar(1)))) {
      let sawDot = false;
      while (i < n && (isDigit(peekChar()) || (peekChar() === '.' && !sawDot))) {
        if (peekChar() === '.') sawDot = true;
        i += 1;
      }
      tokens.push({ kind: 'number', value: Number(source.slice(start, i)), pos: start });
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      let value = '';
      while (i < n && peekChar() !== quote) {
        if (peekChar() === '\\' && i + 1 < n) {
          i += 1;
          value += peekChar();
        } else {
          value += peekChar();
        }
        i += 1;
      }
      if (i >= n) throw new LexError('unterminated string literal', start);
      i += 1; // closing quote
      tokens.push({ kind: 'string', value, pos: start });
      continue;
    }

    if (isIdentStart(c)) {
      while (i < n && isIdentPart(peekChar())) i += 1;
      const word = source.slice(start, i);
      const upper = word.toUpperCase();
      if (isKeyword(upper)) {
        tokens.push({ kind: 'keyword', keyword: upper, pos: start });
      } else {
        tokens.push({ kind: 'identifier', name: word, pos: start });
      }
      continue;
    }

    const two = c + peekChar(1);
    if (two === '!=' || two === '>=' || two === '<=') {
      i += 2;
      tokens.push({ kind: 'punct', text: two as PunctText, pos: start });
      continue;
    }

    if ('().=><'.includes(c)) {
      i += 1;
      tokens.push({ kind: 'punct', text: c as PunctText, pos: start });
      continue;
    }

    throw new LexError(`unexpected character "${c}"`, start);
  }

  tokens.push({ kind: 'eof', pos: n });
  return tokens;
}
