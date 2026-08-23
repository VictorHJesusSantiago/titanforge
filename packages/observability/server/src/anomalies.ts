import type { Span } from '@titanforge/otlp';
import { AnomalyDetector } from '@titanforge/analysis';
import { serializeSpan, type SerializedSpan } from './serialize.js';

/**
 * Scans stored spans grouped by `(serviceName, name)` — the natural key for "the same operation
 * across calls," since duration baselines are only meaningful within one operation, not across
 * unrelated ones — replaying each group's spans in start-time order through a fresh
 * `AnomalyDetector` so every span is judged against only the history that preceded it (not spans
 * that arrive later, which would leak future data into the "was this normal at the time" call).
 * Pure function over `Span[]`, kept separate from the HTTP handler for the same testability reason
 * as `buildFlamegraphNodes`.
 */
export function findAnomalousSpans(spans: Span[], k = 3): SerializedSpan[] {
  const byGroup = new Map<string, Span[]>();
  for (const span of spans) {
    const key = `${span.serviceName}\0${span.name}`;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(span);
    else byGroup.set(key, [span]);
  }

  const flagged: Span[] = [];
  for (const group of byGroup.values()) {
    const ordered = [...group].sort((a, b) => (a.startTimeUnixNano < b.startTimeUnixNano ? -1 : a.startTimeUnixNano > b.startTimeUnixNano ? 1 : 0));
    const detector = new AnomalyDetector(Math.max(ordered.length, 2), k);
    for (const span of ordered) {
      if (detector.observe(Number(span.durationNanos))) flagged.push(span);
    }
  }

  return flagged.map(serializeSpan);
}
