import { tokenize, type Token, type Keyword, type PunctText } from './lexer.js';
import type {
  Assignment,
  BinaryOp,
  ColumnDef,
  DataType,
  DeleteStmt,
  Expr,
  InsertStmt,
  JoinClause,
  OrderByItem,
  SelectItem,
  SelectStmt,
  Statement,
  TableRef,
  UpdateStmt,
} from './ast.js';

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(`${message} at position ${pos}`);
    this.name = 'ParseError';
  }
}

const DATA_TYPES = new Set<string>(['INTEGER', 'REAL', 'TEXT', 'BOOLEAN']);

/**
 * Recursive descent for statements, precedence climbing for expressions. One `Parser` instance
 * per statement, holding a cursor into the token array — no token is ever re-lexed, and
 * backtracking (there is exactly one place it happens: distinguishing a bare column reference
 * from a `table.column` reference) is a token-index save/restore, never a re-parse.
 */
class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    const token = this.tokens[this.pos + offset];
    if (token === undefined) throw new ParseError('unexpected end of input', this.tokens.at(-1)?.pos ?? 0);
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

  private expectKeyword(keyword: Keyword): void {
    if (!this.isKeyword(keyword)) {
      throw new ParseError(`expected keyword ${keyword}, got ${describeToken(this.peek())}`, this.peek().pos);
    }
    this.advance();
  }

  private expectPunct(text: PunctText): void {
    if (!this.isPunct(text)) {
      throw new ParseError(`expected "${text}", got ${describeToken(this.peek())}`, this.peek().pos);
    }
    this.advance();
  }

  private expectIdentifier(): string {
    const token = this.peek();
    if (token.kind !== 'identifier') {
      throw new ParseError(`expected an identifier, got ${describeToken(token)}`, token.pos);
    }
    this.advance();
    return token.name;
  }

  // ---- Statements ------------------------------------------------------------------------

  parseStatement(): Statement {
    if (this.isKeyword('CREATE')) return this.parseCreateTable();
    if (this.isKeyword('DROP')) return this.parseDropTable();
    if (this.isKeyword('INSERT')) return this.parseInsert();
    if (this.isKeyword('UPDATE')) return this.parseUpdate();
    if (this.isKeyword('DELETE')) return this.parseDelete();
    if (this.isKeyword('SELECT')) return this.parseSelect();
    throw new ParseError(`expected a statement, got ${describeToken(this.peek())}`, this.peek().pos);
  }

  finish(): void {
    if (this.isPunct(';')) this.advance();
    if (this.peek().kind !== 'eof') {
      throw new ParseError(`unexpected trailing input: ${describeToken(this.peek())}`, this.peek().pos);
    }
  }

  atEnd(): boolean {
    return this.peek().kind === 'eof';
  }

  consumeStatementSeparator(): void {
    if (this.isPunct(';')) this.advance();
  }

  private parseCreateTable(): Statement {
    this.expectKeyword('CREATE');
    this.expectKeyword('TABLE');
    let ifNotExists = false;
    if (this.isKeyword('IF')) {
      this.advance();
      this.expectKeyword('NOT');
      this.expectKeyword('EXISTS');
      ifNotExists = true;
    }
    const table = this.expectIdentifier();
    this.expectPunct('(');
    const columns: ColumnDef[] = [];
    for (;;) {
      columns.push(this.parseColumnDef());
      if (this.isPunct(',')) {
        this.advance();
        continue;
      }
      break;
    }
    this.expectPunct(')');
    return { kind: 'createTable', table, ifNotExists, columns };
  }

  private parseColumnDef(): ColumnDef {
    const name = this.expectIdentifier();
    const type = this.parseDataType();
    let primaryKey = false;
    let notNull = false;
    for (;;) {
      if (this.isKeyword('PRIMARY')) {
        this.advance();
        this.expectKeyword('KEY');
        primaryKey = true;
        continue;
      }
      if (this.isKeyword('NOT')) {
        this.advance();
        this.expectKeyword('NULL');
        notNull = true;
        continue;
      }
      break;
    }
    return { name, type, primaryKey, notNull };
  }

  private parseDataType(): DataType {
    const token = this.peek();
    if (token.kind === 'keyword' && DATA_TYPES.has(token.keyword)) {
      this.advance();
      return token.keyword as DataType;
    }
    throw new ParseError(`expected a data type (INTEGER, REAL, TEXT, BOOLEAN), got ${describeToken(token)}`, token.pos);
  }

  private parseDropTable(): Statement {
    this.expectKeyword('DROP');
    this.expectKeyword('TABLE');
    let ifExists = false;
    if (this.isKeyword('IF')) {
      this.advance();
      this.expectKeyword('EXISTS');
      ifExists = true;
    }
    const table = this.expectIdentifier();
    return { kind: 'dropTable', table, ifExists };
  }

  private parseInsert(): InsertStmt {
    this.expectKeyword('INSERT');
    this.expectKeyword('INTO');
    const table = this.expectIdentifier();

    let columns: string[] | undefined;
    if (this.isPunct('(')) {
      this.advance();
      columns = [];
      for (;;) {
        columns.push(this.expectIdentifier());
        if (this.isPunct(',')) {
          this.advance();
          continue;
        }
        break;
      }
      this.expectPunct(')');
    }

    this.expectKeyword('VALUES');
    const values: Expr[][] = [];
    for (;;) {
      this.expectPunct('(');
      const row: Expr[] = [];
      for (;;) {
        row.push(this.parseExpr());
        if (this.isPunct(',')) {
          this.advance();
          continue;
        }
        break;
      }
      this.expectPunct(')');
      values.push(row);
      if (this.isPunct(',')) {
        this.advance();
        continue;
      }
      break;
    }

    return { kind: 'insert', table, columns, values };
  }

  private parseUpdate(): UpdateStmt {
    this.expectKeyword('UPDATE');
    const table = this.expectIdentifier();
    this.expectKeyword('SET');
    const assignments: Assignment[] = [];
    for (;;) {
      const column = this.expectIdentifier();
      this.expectPunct('=');
      const value = this.parseExpr();
      assignments.push({ column, value });
      if (this.isPunct(',')) {
        this.advance();
        continue;
      }
      break;
    }
    const where = this.parseOptionalWhere();
    return { kind: 'update', table, assignments, where };
  }

  private parseDelete(): DeleteStmt {
    this.expectKeyword('DELETE');
    this.expectKeyword('FROM');
    const table = this.expectIdentifier();
    const where = this.parseOptionalWhere();
    return { kind: 'delete', table, where };
  }

  private parseOptionalWhere(): Expr | undefined {
    if (!this.isKeyword('WHERE')) return undefined;
    this.advance();
    return this.parseExpr();
  }

  private parseSelect(): SelectStmt {
    this.expectKeyword('SELECT');
    let distinct = false;
    if (this.isKeyword('DISTINCT')) {
      this.advance();
      distinct = true;
    }

    const columns: SelectItem[] = [];
    for (;;) {
      columns.push(this.parseSelectItem());
      if (this.isPunct(',')) {
        this.advance();
        continue;
      }
      break;
    }

    let from: TableRef | undefined;
    const joins: JoinClause[] = [];
    if (this.isKeyword('FROM')) {
      this.advance();
      from = this.parseTableRef();
      while (this.isJoinStart()) {
        joins.push(this.parseJoin());
      }
    }

    const where = this.parseOptionalWhere();

    const groupBy: Expr[] = [];
    if (this.isKeyword('GROUP')) {
      this.advance();
      this.expectKeyword('BY');
      for (;;) {
        groupBy.push(this.parseExpr());
        if (this.isPunct(',')) {
          this.advance();
          continue;
        }
        break;
      }
    }

    const orderBy: OrderByItem[] = [];
    if (this.isKeyword('ORDER')) {
      this.advance();
      this.expectKeyword('BY');
      for (;;) {
        const expr = this.parseExpr();
        let direction: 'ASC' | 'DESC' = 'ASC';
        if (this.isKeyword('ASC')) {
          this.advance();
        } else if (this.isKeyword('DESC')) {
          this.advance();
          direction = 'DESC';
        }
        orderBy.push({ expr, direction });
        if (this.isPunct(',')) {
          this.advance();
          continue;
        }
        break;
      }
    }

    let limit: number | undefined;
    if (this.isKeyword('LIMIT')) {
      this.advance();
      const token = this.advance();
      if (token.kind !== 'number') throw new ParseError('expected a number after LIMIT', token.pos);
      limit = token.value;
    }

    return { kind: 'select', distinct, columns, from, joins, where, groupBy, orderBy, limit };
  }

  private parseSelectItem(): SelectItem {
    const expr = this.parseExpr();
    let alias: string | undefined;
    if (this.isKeyword('AS')) {
      this.advance();
      alias = this.expectIdentifier();
    } else if (this.peek().kind === 'identifier') {
      alias = this.expectIdentifier();
    }
    return { expr, alias };
  }

  private parseTableRef(): TableRef {
    const table = this.expectIdentifier();
    let alias: string | undefined;
    if (this.isKeyword('AS')) {
      this.advance();
      alias = this.expectIdentifier();
    } else if (this.peek().kind === 'identifier') {
      alias = this.expectIdentifier();
    }
    return { table, alias };
  }

  private isJoinStart(): boolean {
    return this.isKeyword('JOIN') || this.isKeyword('INNER') || this.isKeyword('LEFT');
  }

  private parseJoin(): JoinClause {
    let joinKind: 'inner' | 'left' = 'inner';
    if (this.isKeyword('LEFT')) {
      this.advance();
      if (this.isKeyword('OUTER')) this.advance();
      joinKind = 'left';
    } else if (this.isKeyword('INNER')) {
      this.advance();
    }
    this.expectKeyword('JOIN');
    const { table, alias } = this.parseTableRef();
    this.expectKeyword('ON');
    const on = this.parseExpr();
    return { joinKind, table, alias, on };
  }

  // ---- Expressions: precedence climbing ---------------------------------------------------
  // OR (lowest) < AND < comparison < additive < multiplicative < unary < primary (highest)

  parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isKeyword('OR')) {
      this.advance();
      const right = this.parseAnd();
      left = { kind: 'binary', op: 'OR', left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.isKeyword('AND')) {
      this.advance();
      const right = this.parseComparison();
      left = { kind: 'binary', op: 'AND', left, right };
    }
    return left;
  }

  private static readonly COMPARISON_OPS: PunctText[] = ['=', '!=', '<>', '<', '<=', '>', '>='];

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'punct' || !Parser.COMPARISON_OPS.includes(token.text)) break;
      this.advance();
      const right = this.parseAdditive();
      const op: BinaryOp = token.text === '<>' ? '!=' : (token.text as BinaryOp);
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'punct' || (token.text !== '+' && token.text !== '-')) break;
      this.advance();
      const right = this.parseMultiplicative();
      left = { kind: 'binary', op: token.text, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'punct' || (token.text !== '*' && token.text !== '/' && token.text !== '%')) break;
      this.advance();
      const right = this.parseUnary();
      left = { kind: 'binary', op: token.text, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isPunct('-')) {
      this.advance();
      return { kind: 'unary', op: '-', expr: this.parseUnary() };
    }
    if (this.isKeyword('NOT')) {
      this.advance();
      return { kind: 'unary', op: 'NOT', expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.peek();

    if (token.kind === 'number') {
      this.advance();
      return {
        kind: 'literal',
        value: token.raw.includes('.') ? { type: 'real', value: token.value } : { type: 'integer', value: token.value },
      };
    }
    if (token.kind === 'string') {
      this.advance();
      return { kind: 'literal', value: { type: 'text', value: token.value } };
    }
    if (token.kind === 'keyword' && token.keyword === 'TRUE') {
      this.advance();
      return { kind: 'literal', value: { type: 'boolean', value: true } };
    }
    if (token.kind === 'keyword' && token.keyword === 'FALSE') {
      this.advance();
      return { kind: 'literal', value: { type: 'boolean', value: false } };
    }
    if (token.kind === 'keyword' && token.keyword === 'NULL') {
      this.advance();
      return { kind: 'literal', value: { type: 'null' } };
    }
    if (token.kind === 'punct' && token.text === '(') {
      this.advance();
      const inner = this.parseExpr();
      this.expectPunct(')');
      return inner;
    }
    if (token.kind === 'punct' && token.text === '*') {
      this.advance();
      return { kind: 'star' };
    }
    if (token.kind === 'identifier') {
      this.advance();
      if (this.isPunct('(')) {
        this.advance();
        let distinct = false;
        if (this.isKeyword('DISTINCT')) {
          this.advance();
          distinct = true;
        }
        const args: Expr[] = [];
        if (this.isPunct('*')) {
          this.advance();
          args.push({ kind: 'star' });
        } else if (!this.isPunct(')')) {
          for (;;) {
            args.push(this.parseExpr());
            if (this.isPunct(',')) {
              this.advance();
              continue;
            }
            break;
          }
        }
        this.expectPunct(')');
        return { kind: 'call', name: token.name.toUpperCase(), args, distinct };
      }
      if (this.isPunct('.')) {
        this.advance();
        const column = this.expectIdentifier();
        return { kind: 'column', table: token.name, name: column };
      }
      return { kind: 'column', table: undefined, name: token.name };
    }

    throw new ParseError(`unexpected token ${describeToken(token)}`, token.pos);
  }
}

function describeToken(token: Token): string {
  switch (token.kind) {
    case 'number':
      return `number "${token.raw}"`;
    case 'string':
      return `string literal`;
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

/** Parses exactly one statement, optionally trailed by a single `;`. */
export function parseStatement(sql: string): Statement {
  const parser = new Parser(tokenize(sql));
  const stmt = parser.parseStatement();
  parser.finish();
  return stmt;
}

/** Parses `;`-separated statements — what a `.sql` script file or a multi-statement REPL paste needs. */
export function parseScript(sql: string): Statement[] {
  const parser = new Parser(tokenize(sql));
  const statements: Statement[] = [];
  while (!parser.atEnd()) {
    statements.push(parser.parseStatement());
    parser.consumeStatementSeparator();
  }
  return statements;
}
