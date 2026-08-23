import { tokenize, type Keyword, type PunctText, type Token } from './lexer.js';
import type { ComparisonOp, FieldName, FieldRef, Literal, QueryAst } from './ast.js';

export class QueryParseError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(`${message} at position ${pos}`);
    this.name = 'QueryParseError';
  }
}

const FIELD_NAMES = new Set(['service', 'name', 'duration', 'status']);
const COMPARISON_OPS = new Set<PunctText>(['=', '!=', '>', '>=', '<', '<=']);

function describeToken(token: Token): string {
  switch (token.kind) {
    case 'number':
      return `number ${token.value}`;
    case 'string':
      return `string "${token.value}"`;
    case 'identifier':
      return `identifier "${token.name}"`;
    case 'keyword':
      return `keyword ${token.keyword}`;
    case 'punct':
      return `"${token.text}"`;
    case 'eof':
      return 'end of input';
  }
}

/**
 * Precedence climbing by recursive descent, matching `@titanforge/parser`'s SQL expression
 * parser's own convention (and SQL's own operator precedence, which this language deliberately
 * copies since it targets the same audience): `NOT` binds tightest, then `AND`, then `OR` — so
 * `a OR b AND c` parses as `a OR (b AND c)`, not `(a OR b) AND c`.
 */
class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    const token = this.tokens[this.pos + offset];
    if (token === undefined) throw new QueryParseError('unexpected end of input', this.tokens.at(-1)?.pos ?? 0);
    return token;
  }

  private advance(): Token {
    const token = this.peek();
    this.pos += 1;
    return token;
  }

  private isKeyword(keyword: Keyword): boolean {
    const token = this.peek();
    return token.kind === 'keyword' && token.keyword === keyword;
  }

  private isPunct(text: PunctText): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.text === text;
  }

  private expectPunct(text: PunctText): void {
    if (!this.isPunct(text)) {
      throw new QueryParseError(`expected "${text}", got ${describeToken(this.peek())}`, this.peek().pos);
    }
    this.advance();
  }

  parseQuery(): QueryAst {
    const expr = this.parseOr();
    if (this.peek().kind !== 'eof') {
      throw new QueryParseError(`unexpected trailing input: ${describeToken(this.peek())}`, this.peek().pos);
    }
    return expr;
  }

  private parseOr(): QueryAst {
    let left = this.parseAnd();
    while (this.isKeyword('OR')) {
      this.advance();
      const right = this.parseAnd();
      left = { kind: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): QueryAst {
    let left = this.parseUnary();
    while (this.isKeyword('AND')) {
      this.advance();
      const right = this.parseUnary();
      left = { kind: 'and', left, right };
    }
    return left;
  }

  private parseUnary(): QueryAst {
    if (this.isKeyword('NOT')) {
      this.advance();
      return { kind: 'not', expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): QueryAst {
    if (this.isPunct('(')) {
      this.advance();
      const expr = this.parseOr();
      this.expectPunct(')');
      return expr;
    }
    return this.parseComparison();
  }

  private parseComparison(): QueryAst {
    const field = this.parseFieldRef();
    const op = this.parseComparisonOp();
    const value = this.parseLiteral();
    return { kind: 'comparison', field, op, value };
  }

  private parseFieldRef(): FieldRef {
    const token = this.peek();
    if (token.kind !== 'identifier') {
      throw new QueryParseError(`expected a field name, got ${describeToken(token)}`, token.pos);
    }
    this.advance();

    if (token.name === 'attr') {
      this.expectPunct('.');
      const keyToken = this.peek();
      if (keyToken.kind !== 'identifier') {
        throw new QueryParseError(`expected an attribute key after "attr.", got ${describeToken(keyToken)}`, keyToken.pos);
      }
      this.advance();
      return { kind: 'attr', key: keyToken.name };
    }

    if (!FIELD_NAMES.has(token.name)) {
      throw new QueryParseError(
        `unknown field "${token.name}" (expected one of service, name, duration, status, or attr.<key>)`,
        token.pos,
      );
    }
    return { kind: 'field', name: token.name as FieldName };
  }

  private parseComparisonOp(): ComparisonOp {
    const token = this.peek();
    if (token.kind !== 'punct' || !COMPARISON_OPS.has(token.text)) {
      throw new QueryParseError(`expected a comparison operator (= != > >= < <=), got ${describeToken(token)}`, token.pos);
    }
    this.advance();
    return token.text as ComparisonOp;
  }

  private parseLiteral(): Literal {
    const token = this.peek();
    if (token.kind === 'string') {
      this.advance();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'number') {
      this.advance();
      return { kind: 'number', value: token.value };
    }
    throw new QueryParseError(`expected a string or number literal, got ${describeToken(token)}`, token.pos);
  }
}

/** Parses a span query string into a `QueryAst`, throwing `QueryParseError` with a real position on malformed input. */
export function parseQuery(source: string): QueryAst {
  const tokens = tokenize(source);
  return new Parser(tokens).parseQuery();
}
