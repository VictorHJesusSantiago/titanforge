/**
 * Tokenizer for the toy debug-target language.
 *
 * The language is deliberately tiny (integers/floats, identifiers, the handful of operators
 * below, and a small keyword set) — just enough surface for `if`/`while`/functions/`print` so the
 * interpreter has real control flow and scoping to pause inside of. Every token records the
 * 1-based source `line` it started on, because that's the unit breakpoints are set against.
 */

export const KEYWORDS = [
  'let', 'if', 'else', 'while', 'function', 'return', 'print', 'true', 'false',
] as const;

export type Keyword = (typeof KEYWORDS)[number];

const KEYWORD_SET = new Set<string>(KEYWORDS);

function isKeyword(word: string): word is Keyword {
  return KEYWORD_SET.has(word);
}

export type PunctText =
  | '(' | ')' | '{' | '}' | ',' | ';'
  | '+' | '-' | '*' | '/' | '%'
  | '=' | '==' | '!=' | '<' | '<=' | '>' | '>='
  | '&&' | '||' | '!';

export type Token =
  | { kind: 'number'; value: number; raw: string; line: number }
  | { kind: 'identifier'; name: string; line: number }
  | { kind: 'keyword'; keyword: Keyword; line: number }
  | { kind: 'punct'; text: PunctText; line: number }
  | { kind: 'eof'; line: number };

export class LexError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(`${message} at line ${line}`);
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

/**
 * Two-character punctuation must be attempted before its one-character prefix (`==` before `=`,
 * `&&` has no single-char prefix meaning at all so it's checked outright), otherwise the scanner
 * would greedily emit `=` `=` instead of `==`.
 */
const TWO_CHAR_PUNCT: Record<string, PunctText> = {
  '==': '==',
  '!=': '!=',
  '<=': '<=',
  '>=': '>=',
  '&&': '&&',
  '||': '||',
};

const ONE_CHAR_PUNCT = new Set<string>([
  '(', ')', '{', '}', ',', ';', '+', '-', '*', '/', '%', '=', '<', '>', '!',
]);

/** Tokenizes the whole source up front into a flat array — programs here are short scripts. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  let line = 1;

  const peekChar = (offset = 0): string => source[i + offset] ?? '\0';

  while (i < n) {
    const c = peekChar();

    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
      continue;
    }

    // Line comment: `// ...` to end of line.
    if (c === '/' && peekChar(1) === '/') {
      while (i < n && peekChar() !== '\n') i += 1;
      continue;
    }

    if (isDigit(c)) {
      const start = i;
      const startLine = line;
      while (isDigit(peekChar())) i += 1;
      if (peekChar() === '.' && isDigit(peekChar(1))) {
        i += 1;
        while (isDigit(peekChar())) i += 1;
      }
      const raw = source.slice(start, i);
      tokens.push({ kind: 'number', value: Number(raw), raw, line: startLine });
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      const startLine = line;
      while (isIdentPart(peekChar())) i += 1;
      const word = source.slice(start, i);
      if (isKeyword(word)) {
        tokens.push({ kind: 'keyword', keyword: word, line: startLine });
      } else {
        tokens.push({ kind: 'identifier', name: word, line: startLine });
      }
      continue;
    }

    const two = c + peekChar(1);
    const twoPunct = TWO_CHAR_PUNCT[two];
    if (twoPunct !== undefined) {
      tokens.push({ kind: 'punct', text: twoPunct, line });
      i += 2;
      continue;
    }

    if (ONE_CHAR_PUNCT.has(c)) {
      tokens.push({ kind: 'punct', text: c as PunctText, line });
      i += 1;
      continue;
    }

    throw new LexError(`Unexpected character '${c}'`, line);
  }

  tokens.push({ kind: 'eof', line });
  return tokens;
}
