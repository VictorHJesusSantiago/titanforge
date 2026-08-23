# ADR 1 — One monorepo, four independent products

## Context

The brief asked for four genuinely large, unrelated systems: an embedded SQL database, an
observability platform, a full-stack web framework, and a browser IDE. Each is a flagship-scale
project on its own.

## Decision

One repository, one root `tsconfig.json`/`vitest.config.ts`/`eslint.config.js`, four package
groups (`packages/sql`, `packages/observability`, `packages/webstack`, `packages/ide`) that
**share conventions but never share code**. No package in one group imports from another group.

## Why

Sharing infrastructure (lint config, test runner, TS strictness settings, the npm-workspaces
dependency graph) costs nothing and keeps four different pieces of work looking like one
coherent engineering effort rather than four unrelated snippets glued together. Sharing *code*
between, say, the SQL engine's hand-written parser and the observability platform's query
language would have been a false economy: they're superficially similar (both are small
recursive-descent parsers) but serve different grammars, different ASTs, and different callers —
forcing a shared abstraction over them would mean designing for a hypothetical future need
neither currently has.

## Rejected alternative

Four separate repositories. Rejected because the four systems needed to be built and delivered
together, by parallel background agents working from a shared, already-established house style
(dense why-not comments, discriminated-union ASTs, pure-logic-tested/glue-thin as the default
split) — a single repo with one set of conventions files is what let five agents (one per SQL
sub-area plus one each for the other three products) start from the same rules without
re-deriving them.
