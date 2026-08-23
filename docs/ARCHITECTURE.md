# Architecture

Four independent products, each with its own internal pipeline. This document is mostly about
the SQL engine's, since it's the flagship and the one with the most interesting data flow; the
other three get a shorter treatment each.

---

## The SQL engine: how one statement actually runs

```
"SELECT name FROM users WHERE age > 18"
        │
        ▼
   @titanforge/parser         tokenize() → Token[] → parseStatement() → Statement (AST)
        │                     A discriminated union: { kind: 'select', columns, from, where, ... }
        ▼
   @titanforge/catalog        new Binder(catalog).bind(statement) → BoundStatement
        │                     Every table/column reference resolved against the Catalog; every
        │                     expression's SqlType inferred; SELECT * expanded to explicit columns.
        │                     A BoundExpr's 'column' node carries { source, name, ordinal, type } —
        │                     nothing downstream ever looks a name up again.
        ▼
   @titanforge/planner        plan(boundStatement) → PlannedStatement
        │                     1. buildLogicalPlan(): scan/join → filter → aggregate? → project
        │                        → distinct? → sort? → limit?  (relational algebra, unoptimized)
        │                     2. optimize(): predicate pushdown (splits WHERE's AND-conjuncts,
        │                        pushes each into a Filter under whichever side of a Join it
        │                        references — never into a LEFT JOIN's right side) + projection
        │                        pushdown (narrows each Scan to only the columns anything above
        │                        it actually needs)
        │                     3. toPhysicalPlan(): picks a concrete algorithm per node — a Join
        │                        becomes a HashJoin if its condition is a simple column=column
        │                        equality, a NestedLoopJoin otherwise
        ▼
   @titanforge/executor        executeSelect(plannedSelect, storage, snapshot) → { columns, rows }
        │                     Volcano model: every physical node is a generator function pulling
        │                     from its children lazily, one row at a time — a LIMIT 5 on top of a
        │                     full table scan can stop pulling after 5 rows without materializing
        │                     the rest. Expression evaluation implements real three-valued NULL
        │                     logic, not "NULL is falsy."
        ▼
   @titanforge/storage-lsm    table.scan(snapshot) → IterableIterator<StoredRow>
   (or storage-memory)        Reads the memtable first, then each SSTable newest-to-oldest,
                              applying MVCC visibility: a row version is visible iff committed
                              at-or-before the snapshot's readTimestamp and (if superseded) the
                              superseding transaction committed strictly after it.
```

`INSERT`/`UPDATE`/`DELETE`/`CREATE TABLE`/`DROP TABLE` take a shorter path — `planner` produces a
`PlannedInsert`/`PlannedUpdate`/etc. instead of a physical query tree, and `@titanforge/engine`'s
`Database` class executes it directly against the `StorageEngine`, using the executor only for
`UPDATE`/`DELETE`'s `WHERE`-clause row-matching (via `matchingTableRows`, the same physical-plan
machinery a `SELECT` uses).

**The one piece of state that doesn't fit this otherwise-clean pipeline**: `storage-api` is
deliberately schema-agnostic (a `StorageEngine` only ever sees `SqlValue[]` tuples — it doesn't
know a column's name or type, on purpose, so the same interface serves an in-memory engine and a
disk-backed one with zero SQL-specific code in either). That means table *shape* — which
`Catalog` needs on every startup — isn't something `storage-lsm` can hand back on its own.
`Database` solves this by storing its own schema as ordinary rows in a reserved
`__titanforge_schema__` table, going through the exact same `StorageEngine` every user table
does — the same technique SQLite's `sqlite_master` uses, independently arrived at here. See
`docs/adr/0003-schema-catalog-as-a-system-table.md`.

### Package dependency direction

```
storage-api  (interfaces only, zero deps)
    ▲   ▲
    │   └── storage-memory
    └────── storage-lsm

parser  (zero deps)
    ▲
    └── catalog
            ▲
            └── planner
                    ▲
                    └── executor ── storage-api
                            ▲            ▲
                            └── engine ──┘── catalog, parser, planner
                                    ▲
                                    └── cli
```

A package may only depend on packages above it in this diagram. `executor` and `engine` are the
only packages that know `storage-api` exists; `parser`/`catalog`/`planner` are pure — no I/O, no
knowledge that a database file or an in-memory `Map` is even a concept.

---

## Observability platform

```
OTLP JSON ──▶ otlp (parse) ──▶ columnar-store (append) ──▶ server (HTTP)
                                       │                        │
                                query-lang (filter)  ◀──────────┤
                                analysis (service map,          │
                                          anomalies)  ◀──────────┘
                                                                 │
                                                                 ▼
                                                          ui (flamegraph,
                                                              service map,
                                                              search)

sdk ──(wraps fetch, emits spans)──▶ POSTs OTLP JSON ──▶ server's /v1/traces
```

`columnar-store` is genuinely columnar (one flat array per field, not row objects), which is what
makes an aggregation over just `durations` cheap — it never touches `attributes`.

---

## Full-stack framework

```
routes/*.tsx ──▶ compiler (ts-morph: discoverRoutes, extractLoader, generateRouterSource)
                       │
                       ▼
                 RouteManifest ──▶ plugin-system (hooks run over it)
                       │
                       ▼
              runtime (renderToStream: shell flushes immediately,
                        suspended subtrees stream in as their
                        promises resolve, out of tree order)
                       ▲
                       │
              dev-server (esbuild transform + fs.watch + WebSocket HMR)
```

The compiler is the deliberate center of gravity here — real `ts-morph` AST/type analysis, not
string templates, proven by a test asserting the *generated router file itself type-checks with
zero diagnostics*.

---

## Web IDE

```
vfs (real tree-structured in-memory filesystem)
 │
 ├──▶ language-service (ts.LanguageService over a VFS-backed Host)
 │         │
 │         ▼
 │    monaco-bridge (registers providers, syncs VFS ↔ Monaco models)
 │
 ├──▶ shell (tokenizer/parser + command set over the VFS)
 │
 └──▶ dap (DAP protocol layer) ──▶ a from-scratch toy-language interpreter
                                    (generator-based, so it can pause on a
                                     breakpoint and yield control back to DAP)
                       │
                       ▼
                     app (Vite page: file tree + Monaco pane + terminal pane
                          + debug panel, wiring everything above together)
```

Every "this would normally need X" substitution (WASM-compiled LSP → real `ts.LanguageService`;
WebContainers → a scoped VFS-backed shell; real V8 debugging → a real DAP layer over a toy
interpreter) is documented at the point it's made, in both the source and `docs/ROADMAP.md` —
each is a genuine, working system in its own right, just narrower in scope than the full-native
equivalent it stands in for.
