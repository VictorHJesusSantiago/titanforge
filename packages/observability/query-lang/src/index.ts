export type { ComparisonOp, FieldName, FieldRef, Literal, QueryAst } from './ast.js';
export { tokenize } from './lexer.js';
export type { Token } from './lexer.js';
export { parseQuery, QueryParseError } from './parser.js';
export { evaluateQuery, compileQuery, filterSpans, QueryEvalError } from './evaluator.js';
