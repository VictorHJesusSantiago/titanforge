import type {
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpResourceSpans,
  OtlpTracesPayload,
  Span,
} from './types.js';

/**
 * Deliberate scope limitation: this package implements OTLP's **JSON** encoding only, not its
 * canonical protobuf encoding. Real OTLP collectors accept both, and protobuf is the wire format
 * most production SDKs actually send — but decoding it correctly requires either a generated
 * schema (from OpenTelemetry's `.proto` definitions, via `protoc`/`ts-proto` or similar) or a
 * hand-rolled protobuf varint/wire-type decoder shaped around that exact schema. Both are a
 * meaningfully sized project on their own and orthogonal to everything this package is actually
 * here to demonstrate (normalizing OTLP's nested resource/scope/span structure into a flat,
 * queryable `Span`). JSON is a fully spec-legal OTLP encoding — every collector that speaks OTLP
 * HTTP accepts `Content-Type: application/json` — so this is a real subset, not a toy stand-in.
 */
export class OtlpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtlpParseError';
  }
}

function toNanos(value: string | number): bigint {
  return typeof value === 'string' ? BigInt(value) : BigInt(Math.trunc(value));
}

/**
 * OTLP/JSON's `AnyValue` is a one-of encoded as an object with at most one of
 * `stringValue`/`intValue`/`doubleValue`/`boolValue` set (the protobuf oneof, mirrored in JSON as
 * "whichever field happens to be present"). `intValue` is additionally special-cased as a string
 * in real OTLP payloads because protobuf's 64-bit `int64` doesn't fit JS's `number` losslessly —
 * we accept both string and number forms for leniency but always narrow the attribute down to a
 * plain JS `number`, since attributes are for display/filtering, not exact 64-bit arithmetic (span
 * timestamps, where precision actually matters, are kept as `bigint` instead — see `toNanos`).
 */
function normalizeAttributeValue(value: OtlpAnyValue): string | number | boolean {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  throw new OtlpParseError('attribute value has no recognized variant (stringValue/intValue/doubleValue/boolValue)');
}

function normalizeAttributes(attrs: OtlpKeyValue[] | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of attrs ?? []) {
    out[kv.key] = normalizeAttributeValue(kv.value);
  }
  return out;
}

/** OTLP's `Status.code`: 0 = STATUS_CODE_UNSET, 1 = STATUS_CODE_OK, 2 = STATUS_CODE_ERROR. */
function normalizeStatusCode(code: number | undefined): 'unset' | 'ok' | 'error' {
  if (code === 1) return 'ok';
  if (code === 2) return 'error';
  return 'unset';
}

/**
 * `resource.attributes` is where OTLP conventionally carries `service.name` (the standard
 * OpenTelemetry semantic-convention key for "which service emitted this"). It lives one level
 * above every span in the resource, not on the span itself, so we look it up once per
 * `resourceSpans` entry and stamp it onto every span flattened out of it below.
 */
function resourceServiceName(resource: OtlpResourceSpans['resource']): string {
  const attrs = normalizeAttributes(resource?.attributes);
  const serviceName = attrs['service.name'];
  return typeof serviceName === 'string' ? serviceName : 'unknown_service';
}

/**
 * Flattens an OTLP/JSON traces payload's `resourceSpans -> scopeSpans -> spans` nesting into a
 * flat `Span[]`, in encounter order (resource, then scope, then span, all in payload order) —
 * callers that care about "which resource/scope a span came from" already have that captured in
 * `serviceName`; nothing downstream needs the original nesting preserved.
 */
export function parseTracesJson(payload: OtlpTracesPayload): Span[] {
  const spans: Span[] = [];

  for (const resourceSpans of payload.resourceSpans ?? []) {
    const serviceName = resourceServiceName(resourceSpans.resource);

    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const otlpSpan of scopeSpans.spans ?? []) {
        if (!otlpSpan.traceId) throw new OtlpParseError('span is missing required field "traceId"');
        if (!otlpSpan.spanId) throw new OtlpParseError('span is missing required field "spanId"');

        const startTimeUnixNano = toNanos(otlpSpan.startTimeUnixNano);
        const endTimeUnixNano = toNanos(otlpSpan.endTimeUnixNano);

        spans.push({
          traceId: otlpSpan.traceId,
          spanId: otlpSpan.spanId,
          parentSpanId: otlpSpan.parentSpanId && otlpSpan.parentSpanId.length > 0 ? otlpSpan.parentSpanId : undefined,
          name: otlpSpan.name,
          serviceName,
          startTimeUnixNano,
          endTimeUnixNano,
          durationNanos: endTimeUnixNano - startTimeUnixNano,
          attributes: normalizeAttributes(otlpSpan.attributes),
          statusCode: normalizeStatusCode(otlpSpan.status?.code),
        });
      }
    }
  }

  return spans;
}
