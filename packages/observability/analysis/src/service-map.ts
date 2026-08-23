import type { Span } from '@titanforge/otlp';

export interface ServiceMapEdge {
  from: string;
  to: string;
  callCount: number;
}

export interface ServiceMap {
  nodes: string[];
  edges: ServiceMapEdge[];
}

/**
 * Derives a service call graph purely from parent-child span relationships: a span whose parent
 * belongs to a *different* `serviceName` implies its own service was called by the parent's
 * service (an actual cross-process/cross-service hop), while a parent-child pair sharing a
 * `serviceName` is just internal fan-out within one service (e.g. a handler calling a helper
 * function) and produces no edge. This is the same signal Jaeger/Tempo's own service-map
 * derivation is built on — no separate "call" event type is needed, because a trace's span tree
 * already encodes exactly who-called-whom.
 *
 * `callCount` counts spans, not distinct traces: two spans in the same trace where `gateway`
 * calls `auth` twice both increment the `gateway -> auth` edge, since each *is* a real call.
 */
export function buildServiceMap(spans: Span[]): ServiceMap {
  const spanById = new Map<string, Span>();
  for (const span of spans) spanById.set(span.spanId, span);

  const nodes = new Set<string>();
  // Keyed by a NUL-joined "from\0to" pair — NUL is never legal inside a service name, so this
  // stays collision-proof without needing to split a printable delimiter back apart later.
  const edges = new Map<string, ServiceMapEdge>();

  for (const span of spans) {
    nodes.add(span.serviceName);

    if (span.parentSpanId === undefined) continue;
    const parent = spanById.get(span.parentSpanId);
    if (parent === undefined) continue; // parent not in this span set (e.g. partial ingestion) — no edge we can attribute.
    if (parent.serviceName === span.serviceName) continue; // same-service fan-out, not a service-to-service call.

    const key = `${parent.serviceName}\0${span.serviceName}`;
    const existing = edges.get(key);
    if (existing) existing.callCount += 1;
    else edges.set(key, { from: parent.serviceName, to: span.serviceName, callCount: 1 });
  }

  return { nodes: [...nodes], edges: [...edges.values()] };
}
