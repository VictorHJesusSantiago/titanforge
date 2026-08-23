# ADR 3 — The schema catalog persists as rows in a reserved system table

## Context

`@titanforge/storage-api`'s `StorageEngine`/`TableStorage` interface is deliberately
schema-agnostic — every method deals in `SqlValue[]` tuples, never a column's name or type. That
abstraction is what let `storage-memory` and `storage-lsm` be built in parallel against the same
contract with zero SQL-specific code in either, and it's correct: a storage engine shouldn't need
to know what a `VARCHAR` is to store bytes durably.

The gap this created was found late, by integration-testing `@titanforge/engine`'s `Database`
against the real `storage-lsm` engine rather than only against `storage-memory` (which has no
restart to test across — an in-memory engine's state is definitionally gone on process exit, so
this bug was invisible to every one of `storage-memory`'s own tests and every one of `engine`'s
tests that only used it): `LsmEngine` durably remembers that a table named `users` *exists*
(replayed from its WAL's `createTable` records) but has no way to know, and no obligation to
know, that it has an `id INTEGER PRIMARY KEY` column and a `name TEXT NOT NULL` column — that's
`Catalog`'s job, and `Catalog` is constructed fresh, empty, in-memory, every time `new Database()`
runs. Reopening a database against the same on-disk directory produced a `Database` that could
see `users`' *rows* were still there but threw `table "users" does not exist` on `SELECT * FROM
users`, because its brand-new `Catalog` had never been told.

## Decision

`Database` persists its own schema as ordinary rows in a reserved table,
`__titanforge_schema__` (one row per column: `table_name, ordinal, column_name, type,
primary_key, not_null`), written through the exact same `StorageEngine` every user table goes
through — no new file, no new concept added to `storage-api`. On construction, `Database` checks
whether this table already exists; if so, it reads every row back and replays
`catalog.createTable(...)` for each distinct `table_name`, reconstructing the in-memory `Catalog`
to match what was durably recorded before this `Database` instance even existed.

## Why this shape specifically

Extending `storage-api` itself to carry schema (e.g. `createTable(name, columns)` instead of
`createTable(name)`) was rejected: it would mean every `StorageEngine` implementation needs to
either store schema itself (duplicating what `Catalog` already does) or ignore it (a dead
parameter), and it would have required both parallel storage-engine implementations to change
after they were already built and tested against the narrower contract. Storing schema as data,
through the interface that already exists, needed zero changes to `storage-api`,
`storage-memory`, or `storage-lsm` — only `Database` gained the responsibility, which is exactly
where it belongs: `Database` is the SQL layer's own state, and the SQL layer already knows how to
turn rows into `Catalog` entries in the opposite direction (`Binder.bindInsert` does exactly
that).

## Consequences

Every `Database` now creates one extra table on first use, invisible to a caller's own SQL
(nothing prevents `SELECT * FROM __titanforge_schema__` today — there's no reserved-name
enforcement at the parser or binder level, a stated, minor gap rather than a hidden one). Real
production embedded databases (SQLite's `sqlite_master`, Postgres's `pg_catalog`) solve this
exact problem the exact same way — this wasn't discovered as a novel technique, it was recognized
as the standard one once the gap showed up.
