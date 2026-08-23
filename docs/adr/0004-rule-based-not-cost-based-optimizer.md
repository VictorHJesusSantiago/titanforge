# ADR 4 — A rule-based optimizer, not a cost-based one

## Context

`@titanforge/planner` rewrites a logical query plan before executing it. Real production
databases (Postgres, MySQL's optimizer) use cost-based optimization: maintain table statistics
(row counts, value distributions), estimate the cost of several candidate physical plans for the
same query, and pick the cheapest estimate.

## Decision

Every optimization in `@titanforge/planner` is a rule that fires unconditionally wherever it
structurally applies — no statistics are gathered, no alternative plans are costed against each
other. Predicate pushdown always pushes a conjunct as far down as it safely can. Projection
pushdown always narrows a scan to its actually-referenced columns. Join strategy selection always
picks a hash join when the condition is a simple equality, nested-loop otherwise — not "usually,
when the estimated row counts suggest it," always.

## Why

This is honest about what's actually being built: the brief calls for "planner com otimizador
baseado em regras" (a rule-based optimizer), not a cost-based one — building a cost-based
optimizer without real statistics collection, cardinality estimation, and a cost model would mean
either faking the cost numbers (worse than not having them) or taking on a second large,
genuinely separate subsystem (statistics maintenance, kept up to date as data changes) that
wasn't asked for. Every rule implemented here is also provably a Pareto improvement — predicate
pushdown can only filter rows earlier, never later; projection pushdown can only narrow what's
read, never widen it; hash join is asymptotically better than nested-loop whenever it applies at
all — which is precisely the property that makes "always apply the rule" a correct, and not just
convenient, choice. A cost-based optimizer earns its complexity by handling cases where a rule
*isn't* always the right call (e.g. nested-loop can beat hash join when one side is tiny enough
that the hash table's construction cost dominates); this system doesn't yet have the statistics
to ever know that, so pretending to choose based on cost would be choosing based on nothing.

## Consequences

A query where nested-loop would genuinely outperform hash join (a very small table joined many
times) always gets the hash join here. This is a real, stated limitation, not a hidden one — see
`docs/ROADMAP.md`.
