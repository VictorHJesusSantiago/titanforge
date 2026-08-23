/**
 * AST node shapes for the toy language, as discriminated unions keyed on `kind` — the same house
 * style as the SQL parser package: no casts anywhere, `node.kind === 'while'` narrows the whole
 * shape. Every *statement* node carries the 1-based source `line` it starts on; breakpoints are
 * set against statement lines only (matching most real debuggers — you don't break mid-expression).
 */

export type Expr =
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'identifier'; name: string }
  | { kind: 'unary'; op: '-' | '!'; operand: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'call'; callee: string; args: Expr[] };

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '<' | '<=' | '>' | '>=' | '==' | '!='
  | '&&' | '||';

export type Stmt =
  | { kind: 'let'; line: number; name: string; init: Expr }
  | { kind: 'assign'; line: number; name: string; value: Expr }
  | { kind: 'if'; line: number; test: Expr; then: Stmt[]; else: Stmt[] | null }
  | { kind: 'while'; line: number; test: Expr; body: Stmt[] }
  | { kind: 'print'; line: number; value: Expr }
  | { kind: 'return'; line: number; value: Expr | null }
  | { kind: 'exprStmt'; line: number; expr: Expr };

export interface FunctionDecl {
  name: string;
  params: string[];
  body: Stmt[];
  line: number;
}

/** A whole parsed program: top-level function declarations plus top-level statements. */
export interface Program {
  functions: FunctionDecl[];
  statements: Stmt[];
}
