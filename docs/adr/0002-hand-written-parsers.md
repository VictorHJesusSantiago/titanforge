# ADR 2 — Hand-written parsers, not a parser generator

## Context

Two grammars needed real parsers: SQL (`@titanforge/parser`) and the observability platform's
span-filtering query language (`@titanforge/query-lang`). Tools like ANTLR, PEG.js, or a
parser-combinator library would produce a working parser faster.

## Decision

Both are hand-written: a tokenizer producing a flat token array, then recursive descent for
statements and precedence climbing for expressions. No generated code, no grammar DSL to learn
to read.

## Why

A generated parser is a black box between the grammar file and the code that runs — debugging a
precedence bug means reading generated output, not the logic. A hand-written recursive-descent
parser is the logic: `parseAnd()` calling `parseComparison()` calling `parseAdditive()` *is* the
precedence table, readable as ordinary control flow, with error messages and source positions
under full control at every point (`ParseError`/`QueryParseError` carry a real character
position, not a generated-parser's line/column guess). It also meant the second parser
(`query-lang`) could reuse the *pattern* — discriminated-union tokens, precedence climbing, dense
comments explaining precedence choices — without reusing a single line of code, proving the
approach generalizes rather than being a one-off.

## Consequences

More code than a grammar file would need, and every new operator or keyword is a manual addition
to the tokenizer and the right precedence level, not a grammar-file edit and a regenerate. For
two parsers of this size (SQL's is under 500 lines including the lexer; query-lang's is smaller
still) that trade was worth it for the debuggability and the "someone reading this repo can
understand exactly how a query gets parsed by reading three files" property.
