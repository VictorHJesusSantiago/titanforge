import type { OtlpAnyValue, OtlpTracesPayload, Span } from './types.js';

/** The inverse of `normalizeAttributeValue` in parse-json.ts — picks the one `AnyValue` variant matching the JS runtime type. */
function toAnyValue(value: string | number | boolean): OtlpAnyValue {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  return { doubleValue: value };
}

/** OTLP's `Status.code` numeric encoding — the inverse of `normalizeStatusCode` in parse-json.ts. */
function toStatusCode(statusCode: Span['statusCode']): number {
  if (statusCode === 'ok') return 1;
  if (statusCode === 'error') return 2;
  return 0;
}

/**
 * Builds a valid OTLP/JSON traces payload from our internal `Span[]`, grouping spans back into
 * one `resourceSpans` entry per distinct `serviceName` (each with a single `scopeSpans` entry,
 * since this repo's SDK doesn't track separate instrumentation scopes per span) — the shape the
 * `@titanforge/sdk` package POSTs to a collector, and the exact shape `parseTracesJson` above
 * accepts back, so round-tripping `spans -> buildTracesJson -> parseTracesJson` is lossless for
 * every field except attribute numeric subtype (int vs. double both become `doubleValue`, matching
 * `normalizeAttributeValue`'s own collapse of `intValue`/`doubleValue` into a single JS `number`).
 */
export function buildTracesJson(spans: Span[]): OtlpTracesPayload {
  const byService = new Map<string, Span[]>();
  for (const span of spans) {
    const bucket = byService.get(span.serviceName);
    if (bucket) bucket.push(span);
    else byService.set(span.serviceName, [span]);
  }

  return {
    resourceSpans: [...byService.entries()].map(([serviceName, serviceSpans]) => ({
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
      },
      scopeSpans: [
        {
          scope: { name: '@titanforge/sdk' },
          spans: serviceSpans.map((span) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name,
            startTimeUnixNano: span.startTimeUnixNano.toString(),
            endTimeUnixNano: span.endTimeUnixNano.toString(),
            attributes: Object.entries(span.attributes).map(([key, value]) => ({
              key,
              value: toAnyValue(value),
            })),
            status: { code: toStatusCode(span.statusCode) },
          })),
        },
      ],
    })),
  };
}
