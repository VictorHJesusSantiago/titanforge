# TitanForge

**Four large systems, written from scratch in real TypeScript, in one monorepo.**

An embedded SQL database (tokenizer → parser → binder/catalog → rule-based planner → Volcano
executor → LSM storage with a real WAL and real MVCC) is the flagship. Alongside it: an
observability platform (OTLP traces, a real columnar span store, a hand-written query language),
a full-stack web framework with its own `ts-morph`-based compiler (file-based routing, real
type-safe data loaders, streaming SSR), and a browser IDE (Monaco, a real TypeScript language
service, a virtual filesystem, a scoped shell, a real Debug Adapter Protocol implementation).

Nothing here is built on top of an existing database, framework, or IDE — inspiration, not
dependency.

---

## Status

Every milestone in [docs/ROADMAP.md](docs/ROADMAP.md) is complete: **717 tests, all passing**,
lint clean, `tsc -b` clean across all 22 packages. Every deliberate scope reduction (a real
TypeScript language service standing in for a WASM-cross-compiled one; a scoped shell standing
in for WebContainers; a toy-language interpreter standing in for real V8 debugging; JSON-only
OTLP; a rule-based rather than cost-based query optimizer) is stated plainly in
[docs/ROADMAP.md](docs/ROADMAP.md) and [docs/adr/0005-honest-scope-substitutions.md](docs/adr/0005-honest-scope-substitutions.md)
— every one of them is a genuinely working system in its own right, just narrower than the thing
it stands in for.

Nothing in this README describes something that is not in the repository.

---

## The four products

### 1. `packages/sql/*` — an embedded SQL database (flagship)

```bash
npx vitest run packages/sql   # 411 tests
```

```ts
import { Database } from '@titanforge/engine';
import { LsmEngine } from '@titanforge/storage-lsm';

const db = new Database(new LsmEngine('./data'));
db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)');
db.execute(`INSERT INTO users VALUES (1, 'Ada', 36), (2, 'Alan', 41)`);
const result = db.execute('SELECT name FROM users WHERE age > 40');
// result.kind === 'select', result.rows === [['Alan']]
```

Or from the REPL: `npx tsx packages/sql/cli/src/main.ts` (add `-f script.sql` for a
non-interactive run).

| Package | What it does |
| --- | --- |
| [`parser`](packages/sql/parser) | Hand-written tokenizer + recursive-descent parser, discriminated-union AST |
| [`catalog`](packages/sql/catalog) | Schema registry + binder: resolves names, infers types, expands `SELECT *` |
| [`planner`](packages/sql/planner) | Logical plan → rule-based optimizer (predicate/projection pushdown, join-strategy selection) → physical plan |
| [`storage-api`](packages/sql/storage-api) | The `StorageEngine` interface + the shared MVCC contract |
| [`storage-memory`](packages/sql/storage-memory) | A real MVCC-correct in-memory engine |
| [`storage-lsm`](packages/sql/storage-lsm) | A real WAL + memtable + SSTable + compaction engine |
| [`executor`](packages/sql/executor) | Volcano-style physical executor, real 3-valued NULL logic |
| [`engine`](packages/sql/engine) | The `Database` facade — `execute`/`executeScript`/`transaction` |
| [`cli`](packages/sql/cli) | A REPL |

### 2. `packages/observability/*` — traces, metrics, logs

```bash
npx vitest run packages/observability   # 110 tests
```

OTLP/JSON ingestion → a real columnar span store → a hand-written query language
(`service = "api" AND duration > 100`) → a service-map builder + anomaly detector → a Canvas-based
flamegraph UI, plus an auto-instrumentation SDK that wraps `fetch`.

### 3. `packages/webstack/*` — a full-stack framework with its own compiler

```bash
npx vitest run packages/webstack   # 162 tests
```

`ts-morph`-based file-route discovery and type-safe loader extraction (a generated router file
that itself type-checks with zero diagnostics — see its own test for the proof), real
out-of-order streaming SSR, an esbuild+WebSocket dev server with HMR, and a plugin system. A
working example app lives at [`packages/webstack/example`](packages/webstack/example).

### 4. `packages/ide/*` — a browser IDE

```bash
npx vitest run packages/ide   # 145 tests
```

A real tree-structured virtual filesystem, TypeScript's own `ts.LanguageService` wired to Monaco,
a scoped terminal (`ls/cd/cat/mkdir/rm/run`, real command parsing including pipes and
redirection), and a real Debug Adapter Protocol implementation proven against a from-scratch,
breakpoint-capable toy-language interpreter.

---

## Quick start

```bash
npm install
npm test          # 717 tests, every package
npm run lint
npm run build      # tsc -b across all 22 packages
```

Each product's own README-equivalent is its group's entry in [docs/ROADMAP.md](docs/ROADMAP.md);
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) walks through exactly how one SQL statement flows
from text to rows, and gives a shorter data-flow diagram for each of the other three products.

---

## Design decisions worth arguing about

Each written up as an ADR in [docs/adr](docs/adr), with the rejected alternative and why:

- **One monorepo, four independent products** ([ADR 1](docs/adr/0001-monorepo-four-independent-products.md)) — shared conventions, zero shared code between groups.
- **Hand-written parsers, not a parser generator** ([ADR 2](docs/adr/0002-hand-written-parsers.md)) — for the SQL engine and, independently, the observability platform's query language.
- **The schema catalog persists as rows in a reserved system table** ([ADR 3](docs/adr/0003-schema-catalog-as-a-system-table.md)) — a real bug, found by integration-testing against the real LSM storage engine, not just the in-memory one, and fixed the same way SQLite's `sqlite_master` solves the identical problem.
- **A rule-based optimizer, not cost-based** ([ADR 4](docs/adr/0004-rule-based-not-cost-based-optimizer.md)) — every rule is a provable Pareto improvement, which is what makes "always apply it" correct without needing table statistics this project doesn't collect.
- **Honest, documented scope substitutions** ([ADR 5](docs/adr/0005-honest-scope-substitutions.md)) — where a piece of the brief was a multi-year effort on its own, what was actually built instead, and why it's real rather than faked.

---

## License

MIT — see [LICENSE](LICENSE).
