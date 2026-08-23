# ADR 5 — Honest, documented scope substitutions instead of fake implementations

## Context

Several pieces of the original brief describe systems that are, individually, multi-year efforts
by dedicated teams: a native language server cross-compiled to WASM per language; a full Linux
runtime in the browser (what StackBlitz's proprietary WebContainers actually is); real V8/Node
Inspector Protocol debugging; a protobuf OTLP codec; React Server Components' actual runtime
semantics; force-directed graph layout as a real physics simulation.

## Decision

Each of these was deliberately scoped down to something smaller but **genuinely real and
working**, and the substitution is stated plainly — in the source code at the point it's made,
and in `docs/ROADMAP.md` — rather than either silently built as a shallow stub or silently
omitted:

- WASM-compiled language server → TypeScript's own real `ts.LanguageService`, running against a
  VFS-backed host — genuine diagnostics/completions/hover/go-to-definition, just not
  WASM-cross-compiled and not multi-language.
- WebContainers → a real command parser and a real, if fixed, command set over a real
  tree-structured virtual filesystem — no actual OS processes, no `npm install`.
- Real V8 debugging → a real Debug Adapter Protocol implementation (correct message shapes,
  correct request/response/event sequencing) proven against a genuine, from-scratch,
  breakpoint-capable interpreter for a small toy language, not a Node Inspector Protocol bridge.
- Protobuf OTLP → OTLP's JSON encoding, real and complete for that encoding, with protobuf stated
  as unimplemented rather than faked.
- React Server Components → plain async functions returning a small hyperscript tree, with real
  out-of-order streaming SSR, but not React's fiber-level reconciliation or state model.
- Force-directed layout → a circular layout, stated as the honest deterministic fallback it is.

## Why

A fake version of any of these — a language server that returns hardcoded completions, a
terminal that prints canned output instead of running real commands, a debugger that can't
actually pause execution — would look similar in a demo and be worthless as engineering: none of
it would be extensible, testable in the way the rest of this project is, or honest about what a
reader could rely on. Every substitution above is instead a real, independently useful system in
its own right (the DAP layer genuinely speaks the real protocol; the language service genuinely
type-checks real code; the shell genuinely mutates a real filesystem) — narrower in scope than
the thing it stands in for, never fake about what it actually does.

## Consequences

A reader of this repo needs to read the scope statement next to each of these, not just the
feature name, to know what's actually implemented — which is the whole point: the scope statement
*is* the accurate description, and it's placed exactly where someone would look for it (the
package's own source and `docs/ROADMAP.md`), not buried or omitted.
