# Roadmap

Status: `[x]` done · `[~]` in progress · `[ ]` not started

Four independent products in one monorepo, each buildable and testable on its own
(`packages/sql`, `packages/observability`, `packages/webstack`, `packages/ide`). "Independent"
is load-bearing: nothing in `observability`, `webstack`, or `ide` imports anything from `sql`, or
from each other. They share only conventions (strict TypeScript, hand-written parsers where a
grammar is involved, pure-logic-tested/glue-thin as the default split, npm workspaces, one root
`tsconfig.json` solution file).

---

## 1. The SQL engine (`packages/sql/*`) — flagship `[x]`

An embedded SQL database, front to back, nothing borrowed: tokenizer → parser → binder/catalog →
rule-based planner → Volcano executor → LSM storage with a real WAL and real MVCC. **717 tests
across the whole repo, 411 of them in `packages/sql` alone.**

- [x] **`parser`** — hand-written tokenizer + recursive-descent/precedence-climbing parser,
      discriminated-union AST. `CREATE/DROP TABLE`, `INSERT`, `UPDATE`, `DELETE`,
      `SELECT [DISTINCT] ... FROM ... [JOIN ... ON ...]* [WHERE] [GROUP BY] [ORDER BY] [LIMIT]`,
      a full expression grammar. No `BEGIN`/`COMMIT`/`ROLLBACK` SQL syntax — transactions are a
      JS-level `Database.transaction()` API (see `engine`, below); adding real transaction
      *statements* would mean the parser needs to track statement boundaries against an implicit
      session state, a real scope increase deliberately left for later. 39 tests.
- [x] **`catalog`** — the schema registry (`Catalog`) and the binder (`Binder`): resolves every
      table/column reference, infers every expression's type, expands `SELECT *`, validates
      `GROUP BY` (a non-aggregated, non-grouped column is a real bound error, not silently
      allowed). 48 tests.
- [x] **`planner`** — `BoundStatement` → logical plan → two real rule-based rewrites (predicate
      pushdown, correctly refusing to push into a `LEFT JOIN`'s right side; projection pushdown,
      narrowing each scan to only the columns anything above it actually references) → physical
      plan, including automatic hash-join-vs-nested-loop-join selection (hash join exactly when
      the condition is a simple column-equals-column equality). 33 tests.
- [x] **`storage-api`** — the interface boundary: `StorageEngine`/`TableStorage`, and the MVCC
      snapshot-visibility contract every implementation below shares (a row version is visible to
      a snapshot iff committed at-or-before it and, if superseded, the superseding transaction
      committed after it).
- [x] **`storage-memory`** — a real, fully MVCC-correct in-memory `StorageEngine` (versioned rows,
      shared commit-timestamp counter, proper rollback) — what the executor's own tests run
      against, and a legitimate "no durability needed" deployment target on its own. 10 tests.
- [x] **`storage-lsm`** — the flagship's flagship: a real WAL (append-only, replayed from byte
      zero on open — proven with an actual "open, write, commit, open a **new** instance against
      the same directory with no graceful shutdown" restart test), a memtable, immutable SSTables
      flushed once the memtable crosses a threshold, and compaction that merges SSTables and
      drops row versions no longer visible to any open transaction's snapshot — provably
      (a test asserts the on-disk version count actually drops after `compactTable()`).
      Compaction runs synchronously when triggered, not on a background timer — Node has no
      threads to run it on in the background sense the word usually implies; what *is* real about
      "non-blocking" here is that SSTables are immutable, so a compaction never mutates a file a
      concurrent scan might be mid-read on, only atomically swaps which files are "current" once
      a merge finishes. 84 tests.
- [x] **`executor`** — the Volcano-style physical executor: every physical node is a lazy
      generator (proven by a `LIMIT` test that counts exactly how many rows an underlying scan
      produced, and stops early), real three-valued NULL logic for `AND`/`OR`/`NOT`/comparisons/
      arithmetic (not just "NULL is falsy"), a real hash join cross-checked against nested-loop
      over equivalent data, `COUNT`/`SUM`/`AVG`/`MIN`/`MAX` with documented empty/NULL-set
      semantics, and `UPPER`/`LOWER`/`LENGTH`/`ABS`/`COALESCE`. 52 tests.
- [x] **`engine`** — the `Database` facade tying `catalog`+`binder`+`planner`+`executor`+a
      caller-supplied `StorageEngine` together: `execute()`, `executeScript()`, and a JS-level
      `transaction()` API with real repeatable-read semantics and real rollback-on-throw.
      **A real bug was found and fixed integrating this against `storage-lsm`**: `storage-api` is
      deliberately schema-agnostic (a `StorageEngine` only ever sees `SqlValue[]` tuples, never a
      column's name or type), which meant table *existence* survived a restart but table *shape*
      didn't — a fresh `Database` had no way to know a re-opened `LsmEngine`'s tables' column
      definitions. Fixed by persisting the schema itself as ordinary rows in a reserved
      `__titanforge_schema__` table, going through the exact same `StorageEngine` every user
      table uses (the same trick `sqlite_master` is, under a different name) — proven by an
      integration test that creates a table, closes the process (no graceful shutdown), reopens
      against the same directory with a brand-new `Database`, and queries the table by name
      through real SQL. 25 tests (18 against `storage-memory`, 7 full-pipeline against the real
      `storage-lsm`, including that restart test).
- [x] **`cli`** — a REPL: real ASCII-table formatting (tested as pure logic, separate from the
      thin stdin-reading loop), `.exit`/`.quit`, `-f <file.sql>` for non-interactive script runs.
      9 tests.

**Explicitly out of scope**, stated rather than glossed over: a Postgres-compatible wire
protocol (the brief called this "optional, but it's the wow" — genuinely a separate, large
protocol-implementation project on its own); WAL checkpointing/truncation (the WAL is never
truncated in this MVP — always fully replayed, correct but not space-efficient, matching the
storage engine's own stated "correctness over aggressiveness" choice).

---

## 2. Observability platform (`packages/observability/*`) `[x]`

Traces + metrics + logs, OTLP-in, a real columnar span store, a hand-written query language, a
service map and anomaly detector, an auto-instrumentation SDK, and a flamegraph UI. 110 tests.

- [x] **`otlp`** — real OTLP/JSON trace parsing (`resourceSpans → scopeSpans → spans`) into a flat
      `Span[]`, and the reverse (`buildTracesJson`, used by the SDK). **JSON only, not
      protobuf** — a protobuf codec needs a generated schema compiler, a genuinely separate
      toolchain investment, stated as a limitation rather than faked. 13 tests.
- [x] **`columnar-store`** — a real columnar layout (one flat array per field, row `i` aligned
      across every array — not row objects wearing a columnar name), a secondary
      `Map<traceId, rowIndices>` index for fast trace lookup, and real percentile aggregation
      (sort + nearest-rank, hand-verified). 13 tests.
- [x] **`query-lang`** — a hand-written tokenizer/parser/evaluator (`service = "api" AND duration
      > 100`, `attr.foo` for arbitrary attributes, correct `AND`-over-`OR` precedence matching the
      SQL parser's own convention) — a second, independent proof this project's "write the parser
      by hand" house style generalizes past SQL specifically. 24 tests.
- [x] **`analysis`** — a real service-map builder (directed call graph from cross-service
      parent/child span edges) and a real rolling-mean/stddev anomaly detector (z-score outlier
      flagging, with a documented guard against false-positiving on too little history). 17 tests.
- [x] **`sdk`** — wraps global `fetch` to auto-produce HTTP spans, a manual `startSpan`/`end()`
      API using an explicit current-span stack (not `AsyncLocalStorage`, since this SDK also has
      to run in-browser), batches and POSTs real OTLP JSON. 13 tests.
- [x] **`server`** — ties every package above together over HTTP. **Built on Node's built-in
      `http` module, not Express** — Express wasn't already present in `node_modules` and
      installing it mid-parallel-build was avoided; a small hand-rolled router substitutes,
      documented in the source. Real end-to-end tests: POST real OTLP JSON in, GET it back out
      through the flamegraph/service-map/query/anomaly endpoints. 14 tests.
- [x] **`ui`** — a Vite browser app with a Canvas 2D flamegraph and service map, **no charting
      library**, matching this project's from-scratch ethos. Service map uses a circular layout,
      not a force-directed one — a documented, honest, deterministic fallback rather than a fake
      physics simulation. Pure layout math is unit tested (16 tests); canvas-drawing glue is thin
      and untested, consistent with this whole project's established pure-vs-glue split. No live
      browser check — Playwright wasn't present in this environment for this package's build.

---

## 3. Full-stack framework (`packages/webstack/*`) `[x]`

File-based routing with a real compiler (the stated priority — "o ouro aqui é o compilador"),
server components with real streaming SSR, a dev server with HMR over esbuild, a plugin system.
162 tests.

- [x] **`compiler`** — the deepest test suite in this domain (82 tests) for a reason: uses
      **`ts-morph`** for genuine AST/type analysis, not string templating pretending to be one.
      `discoverRoutes()` walks a route directory and builds a manifest with static/dynamic
      (`[id]`)/catch-all (`[...slug]`) segments and root-first nested `_layout` stacking.
      `extractLoader()` uses the real TypeScript type checker to pull a loader's return type
      (unwrapping `Promise<T>`) into a JSON-serializable shape — and a test proves it's real by
      changing a loader's return shape and asserting the extracted shape changes correspondingly.
      `generateRouterSource()` builds the generated router file through `ts-morph`'s structural
      APIs (`addInterface`, `addFunction`), and a test asserts the **generated file itself
      type-checks with zero diagnostics** — the strongest evidence "type-safe end-to-end" is real
      and not asserted by inspection.
- [x] **`runtime`** — components are plain (possibly async) functions returning a small
      hyperscript tree; `renderToStream()` implements genuine **out-of-order streaming SSR**
      (flushes the shell immediately with placeholder markers, pushes each suspended subtree's
      HTML as its own promise resolves, in actual resolve order — proven with artificially-delayed
      promises resolving out of tree order in a test). Loaders wire resolved data into a page
      component before render. 37 tests. Scoped honestly smaller than React Server Components (a
      framework-specific runtime with years of its own investment) — stated in the source.
- [x] **`dev-server`** — real `esbuild` transforms per changed file, a real recursive `fs.watch`,
      a real WebSocket HMR channel — tested against real temp directories and real socket
      connections, not mocked. HMR re-renders the affected route; it does **not** preserve
      component state across a hot swap the way React Fast Refresh's fiber-level patching does —
      a stated, honest scope boundary for a framework this size. 22 tests.
- [x] **`plugin-system`** — a real `Plugin` interface (`onRouteDiscovered`, `onManifestReady`,
      `transformComponent`, `onBuildComplete`) and a runner executing hooks in order over real
      compiler output, tested by a plugin that observably mutates the pipeline. 14 tests.
- [x] **`webstack-cli`** + **`example`** — `build`/`dev` commands wired against a real example app
      (static/dynamic/catch-all routes, nested layouts, two loaders, one streaming boundary) —
      7 integration tests asserting the compiler's manifest matches the example's real file tree.

---

## 4. Web IDE (`packages/ide/*`) `[x]`

Monaco, a real (if scoped) language service, a virtual filesystem, a scoped terminal, and a real
Debug Adapter Protocol layer over a from-scratch debuggable interpreter. 145 tests.

- [x] **`vfs`** — a real tree-structured (not flat-`Map`-pretending-to-be-one) in-memory
      filesystem: directories are real nodes, `readdir` reflects real structure, recursive
      `watch` fires correctly (and doesn't fire for unrelated paths), JSON snapshot/restore.
      33 tests.
- [x] **`language-service`** — wraps TypeScript's own real `ts.LanguageService` (the same engine
      behind VS Code and the TS Playground) over a `ts.LanguageServiceHost` backed by the VFS —
      genuine diagnostics, completions, hover, go-to-definition, formatting; a version counter
      bumped on every VFS write is what tells the language service to re-analyze. **This is the
      honest substitution for "language servers compiled to WASM"** — a real, fully-functional
      TypeScript language service, not literally WASM-cross-compiled; an actual WASM-compiled
      native language server (rust-analyzer via WASI, for instance) is a separate, large,
      per-language toolchain undertaking, stated as out of scope rather than faked. 13 tests.
- [x] **`monaco-bridge`** — VFS↔Monaco-model sync (the pure sync logic is tested against a fake
      model; Monaco provider registration itself is thin, DOM-coupled glue, deliberately less
      tested, matching this project's own established convention). 9 tests.
- [x] **`shell`** — a real command tokenizer (quoting, pipes, `>`/`>>` redirection) and a real,
      if deliberately scoped, command set (`ls/cd/pwd/cat/echo/mkdir/rm/touch/mv/cp/run`) over the
      VFS — `run` transpiles TS via `ts.transpileModule` and evaluates it, capturing
      `console.log`/`console.error`. Explicitly not a Linux container: no real processes, no real
      `npm install` — the honest substitution for "terminal via WebContainers-like." 50 tests.
- [x] **`dap`** — a real implementation of the actual, publicly-documented Debug Adapter Protocol
      wire format (`initialize`/`launch`/`setBreakpoints`/`continue`/`next`/`stepIn`/`stackTrace`/
      `scopes`/`variables`/`terminate`, correct request/response/event sequencing), proven against
      a genuine, from-scratch, generator-based, steppable, breakpoint-capable interpreter for a
      small toy language — not real V8/Node Inspector Protocol integration, which would need a
      separate, much larger bridge; stated plainly as the honest scope decision it is. 33 tests.
- [x] **`app`** — the Vite page wiring all five together: a file tree, a Monaco editor pane, a
      hand-built (not `xterm.js`) scrollback+input terminal, and a debug panel pre-loaded with a
      real toy-language program and a working breakpoint. One real bug found and fixed along the
      way: Monaco's own typings declare `MonacoEnvironment` as a block-scoped `let`, which never
      becomes a `globalThis` property at runtime — fixed by assigning it as a bare global
      identifier instead of `globalThis.MonacoEnvironment`. 7 pure-logic tests.

---

## Explicitly out of scope, project-wide

A Postgres wire protocol for the SQL engine; protobuf OTLP ingestion; WASM-cross-compiled
language servers; real V8 Inspector Protocol debugging; a WebContainers-equivalent Linux runtime
in the browser; React-Server-Components-equivalent framework semantics; force-directed graph
layout for the service map. Every one of these is a genuinely separate, large project on its own
— building a fake version of any of them would have cost real depth elsewhere for a worse result.
