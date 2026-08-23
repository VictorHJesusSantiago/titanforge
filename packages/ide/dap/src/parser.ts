/**
 * Recursive-descent parser for the toy language, producing the `Program` AST defined in
 * `ast.ts`. Expression parsing is precedence climbing implemented as a chain of methods, one per
 * precedence level (lowest to highest: `||`, `&&`, equality, relational, additive,
 * multiplicative, unary, primary) — the classic, easy-to-audit way to encode operator precedence
 * by hand without a table-driven Pratt parser.
 */

import type { BinaryOp, Expr, FunctionDecl, Program, Stmt } from './ast.js';
import type { Keyword, PunctText, Token } from './lexer.js';
import { tokenize } from './lexer.js';

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(`${message} at line ${line}`);
    this.name = 'ParseError';
  }
}

export function parse(source: string): Program {
  const tokens = tokenize(source);
  return new Parser(tokens).parseProgram();
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    // noUncheckedIndexedAccess would make this `Token | undefined`, but the token stream always
    // ends in an `eof` token that parsing never advances past, so an out-of-range read can only
    // happen if we walk off the end — clamp to the last token (eof) defensively.
    const idx = Math.min(this.pos + offset, this.tokens.length - 1);
    return this.tokens[idx] ?? this.tokens[this.tokens.length - 1]!;
  }

  private advance(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.pos += 1;
    return t;
  }

  private isPunct(text: PunctText): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.text === text;
  }

  private isKeyword(word: Keyword): boolean {
    const t = this.peek();
    return t.kind === 'keyword' && t.keyword === word;
  }

  private expectPunct(text: PunctText): Token {
    if (!this.isPunct(text)) {
      throw new ParseError(`Expected '${text}'`, this.peek().line);
    }
    return this.advance();
  }

  private expectKeyword(word: Keyword): Token {
    if (!this.isKeyword(word)) {
      throw new ParseError(`Expected keyword '${word}'`, this.peek().line);
    }
    return this.advance();
  }

  private expectIdentifier(): string {
    const t = this.peek();
    if (t.kind !== 'identifier') {
      throw new ParseError('Expected identifier', t.line);
    }
    this.advance();
    return t.name;
  }

  parseProgram(): Program {
    const functions: FunctionDecl[] = [];
    const statements: Stmt[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.isKeyword('function')) {
        functions.push(this.parseFunctionDecl());
      } else {
        statements.push(this.parseStatement());
      }
    }
    return { functions, statements };
  }

  private parseFunctionDecl(): FunctionDecl {
    const line = this.expectKeyword('function').line;
    const name = this.expectIdentifier();
    this.expectPunct('(');
    const params: string[] = [];
    if (!this.isPunct(')')) {
      params.push(this.expectIdentifier());
      while (this.isPunct(',')) {
        this.advance();
        params.push(this.expectIdentifier());
      }
    }
    this.expectPunct(')');
    const body = this.parseBlock();
    return { name, params, body, line };
  }

  private parseBlock(): Stmt[] {
    this.expectPunct('{');
    const stmts: Stmt[] = [];
    while (!this.isPunct('}')) {
      stmts.push(this.parseStatement());
    }
    this.expectPunct('}');
    return stmts;
  }

  private parseStatement(): Stmt {
    const t = this.peek();

    if (t.kind === 'keyword' && t.keyword === 'let') {
      return this.parseLet();
    }
    if (t.kind === 'keyword' && t.keyword === 'if') {
      return this.parseIf();
    }
    if (t.kind === 'keyword' && t.keyword === 'while') {
      return this.parseWhile();
    }
    if (t.kind === 'keyword' && t.keyword === 'print') {
      return this.parsePrint();
    }
    if (t.kind === 'keyword' && t.keyword === 'return') {
      return this.parseReturn();
    }
    const next = this.peek(1);
    if (t.kind === 'identifier' && next.kind === 'punct' && next.text === '=') {
      return this.parseAssign();
    }

    const line = t.line;
    const expr = this.parseExpr();
    this.expectPunct(';');
    return { kind: 'exprStmt', line, expr };
  }

  private parseLet(): Stmt {
    const line = this.expectKeyword('let').line;
    const name = this.expectIdentifier();
    this.expectPunct('=');
    const init = this.parseExpr();
    this.expectPunct(';');
    return { kind: 'let', line, name, init };
  }

  private parseAssign(): Stmt {
    const line = this.peek().line;
    const name = this.expectIdentifier();
    this.expectPunct('=');
    const value = this.parseExpr();
    this.expectPunct(';');
    return { kind: 'assign', line, name, value };
  }

  private parseIf(): Stmt {
    const line = this.expectKeyword('if').line;
    this.expectPunct('(');
    const test = this.parseExpr();
    this.expectPunct(')');
    const then = this.parseBlock();
    let elseBranch: Stmt[] | null = null;
    if (this.isKeyword('else')) {
      this.advance();
      elseBranch = this.parseBlock();
    }
    return { kind: 'if', line, test, then, else: elseBranch };
  }

  private parseWhile(): Stmt {
    const line = this.expectKeyword('while').line;
    this.expectPunct('(');
    const test = this.parseExpr();
    this.expectPunct(')');
    const body = this.parseBlock();
    return { kind: 'while', line, test, body };
  }

  private parsePrint(): Stmt {
    const line = this.expectKeyword('print').line;
    this.expectPunct('(');
    const value = this.parseExpr();
    this.expectPunct(')');
    this.expectPunct(';');
    return { kind: 'print', line, value };
  }

  private parseReturn(): Stmt {
    const line = this.expectKeyword('return').line;
    let value: Expr | null = null;
    if (!this.isPunct(';')) {
      value = this.parseExpr();
    }
    this.expectPunct(';');
    return { kind: 'return', line, value };
  }

  // --- Expressions, lowest to highest precedence -----------------------------------------

  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isPunct('||')) {
      this.advance();
      const right = this.parseAnd();
      left = { kind: 'binary', op: '||', left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseEquality();
    while (this.isPunct('&&')) {
      this.advance();
      const right = this.parseEquality();
      left = { kind: 'binary', op: '&&', left, right };
    }
    return left;
  }

  private parseEquality(): Expr {
    let left = this.parseRelational();
    while (this.isPunct('==') || this.isPunct('!=')) {
      const op = this.advance() as Token & { kind: 'punct' };
      const right = this.parseRelational();
      left = { kind: 'binary', op: op.text as BinaryOp, left, right };
    }
    return left;
  }

  private parseRelational(): Expr {
    let left = this.parseAdditive();
    while (this.isPunct('<') || this.isPunct('<=') || this.isPunct('>') || this.isPunct('>=')) {
      const op = this.advance() as Token & { kind: 'punct' };
      const right = this.parseAdditive();
      left = { kind: 'binary', op: op.text as BinaryOp, left, right };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.isPunct('+') || this.isPunct('-')) {
      const op = this.advance() as Token & { kind: 'punct' };
      const right = this.parseMultiplicative();
      left = { kind: 'binary', op: op.text as BinaryOp, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.isPunct('*') || this.isPunct('/') || this.isPunct('%')) {
      const op = this.advance() as Token & { kind: 'punct' };
      const right = this.parseUnary();
      left = { kind: 'binary', op: op.text as BinaryOp, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isPunct('-') || this.isPunct('!')) {
      const op = this.advance() as Token & { kind: 'punct' };
      const operand = this.parseUnary();
      return { kind: 'unary', op: op.text as '-' | '!', operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.kind === 'number') {
      this.advance();
      return { kind: 'number', value: t.value };
    }
    if (t.kind === 'keyword' && (t.keyword === 'true' || t.keyword === 'false')) {
      this.advance();
      return { kind: 'bool', value: t.keyword === 'true' };
    }
    if (t.kind === 'identifier') {
      // Lookahead distinguishes a bare variable reference from a call: `foo` vs `foo(...)`.
      const next = this.peek(1);
      if (next.kind === 'punct' && next.text === '(') {
        const callee = t.name;
        this.advance();
        this.expectPunct('(');
        const args: Expr[] = [];
        if (!this.isPunct(')')) {
          args.push(this.parseExpr());
          while (this.isPunct(',')) {
            this.advance();
            args.push(this.parseExpr());
          }
        }
        this.expectPunct(')');
        return { kind: 'call', callee, args };
      }
      this.advance();
      return { kind: 'identifier', name: t.name };
    }
    if (t.kind === 'punct' && t.text === '(') {
      this.advance();
      const expr = this.parseExpr();
      this.expectPunct(')');
      return expr;
    }

    throw new ParseError(`Unexpected token in expression`, t.line);
  }
}
