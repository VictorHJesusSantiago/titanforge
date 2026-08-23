import type { Span } from '@titanforge/otlp';
import { type SerializedSpan, serializeSpan } from './serialize.js';

export interface FlamegraphNode extends SerializedSpan {
  /** Nanoseconds since the earliest span in the trace — what a flamegraph renderer needs for each rectangle's x position, rather than an absolute epoch timestamp. */
  startOffsetNanos: string;
  /** How many ancestor spans (within this trace) this span is nested under — the flamegraph's y position (row index). */
  depth: number;
}

/**
 * Reshapes a flat set of same-trace spans into what a flamegraph renderer needs: each span's
 * offset from the trace's earliest start (not its absolute timestamp — a flamegraph's x-axis is
 * relative to trace start) and its nesting depth (the flamegraph's row). Pure function, no HTTP
 * concerns, so it's unit-testable without spinning up the server.
 */
export function buildFlamegraphNodes(spans: Span[]): FlamegraphNode[] {
  if (spans.length === 0) return [];

  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const minStart = spans.reduce((min, s) => (s.startTimeUnixNano < min ? s.startTimeUnixNano : min), spans[0]!.startTimeUnixNano);

  function depthOf(span: Span, seen = new Set<string>()): number {
    if (span.parentSpanId === undefined) return 0;
    if (seen.has(span.spanId)) return 0; // defends against a malformed cyclic parent chain rather than looping forever.
    const parent = byId.get(span.parentSpanId);
    if (parent === undefined) return 0; // parent outside this span set (e.g. only a subtree was fetched) — treat as a root for layout purposes.
    seen.add(span.spanId);
    return 1 + depthOf(parent, seen);
  }

  return spans.map((span) => ({
    ...serializeSpan(span),
    startOffsetNanos: (span.startTimeUnixNano - minStart).toString(),
    depth: depthOf(span),
  }));
}
