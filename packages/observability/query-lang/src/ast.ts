/** Discriminated-union AST for the span query language, e.g. `service = "api" AND duration > 100 AND status = "error"`. */

export type ComparisonOp = '=' | '!=' | '>' | '>=' | '<' | '<=';

export type FieldName = 'service' | 'name' | 'duration' | 'status';

/** `service`/`name`/`duration`/`status` reference fixed `Span` fields; `attr.foo` references an arbitrary attribute key. */
export type FieldRef = { kind: 'field'; name: FieldName } | { kind: 'attr'; key: string };

export type Literal = { kind: 'string'; value: string } | { kind: 'number'; value: number };

export type QueryAst =
  | { kind: 'and'; left: QueryAst; right: QueryAst }
  | { kind: 'or'; left: QueryAst; right: QueryAst }
  | { kind: 'not'; expr: QueryAst }
  | { kind: 'comparison'; field: FieldRef; op: ComparisonOp; value: Literal };
