/**
 * Our own flat, internal span shape. Every downstream package (columnar-store, query-lang,
 * analysis, sdk, server) speaks this type, never OTLP's nested wire shape directly — OTLP's
 * `resourceSpans -> scopeSpans -> spans` nesting exists to let a single HTTP request batch spans
 * from many services/instrumentation scopes efficiently on the wire, but nothing downstream of
 * ingestion benefits from re-walking that nesting on every read. `parseTracesJson` below is the
 * one place the nesting is ever dealt with; everywhere else in this repo just sees `Span[]`.
 */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  serviceName: string;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  durationNanos: bigint;
  attributes: Record<string, string | number | boolean>;
  statusCode: 'unset' | 'ok' | 'error';
}

/**
 * OTLP's JSON encoding represents every scalar as a "one of" object (`{ stringValue }`,
 * `{ intValue }`, ...) rather than a bare JSON scalar, because the same `AnyValue` message also
 * has to be able to hold arrays/maps in the protobuf encoding this mirrors. We only normalize the
 * scalar variants a span attribute realistically holds (string/int/double/bool) — array and
 * key-value-list attribute values are out of scope, see the package README-equivalent doc comment
 * on `normalizeAttributeValue` in parse-json.ts.
 */
export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpResource {
  attributes?: OtlpKeyValue[];
}

export interface OtlpInstrumentationScope {
  name?: string;
  version?: string;
}

export interface OtlpStatus {
  code?: number; // 0 = UNSET, 1 = OK, 2 = ERROR
  message?: string;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string | number;
  endTimeUnixNano: string | number;
  attributes?: OtlpKeyValue[];
  status?: OtlpStatus;
}

export interface OtlpScopeSpans {
  scope?: OtlpInstrumentationScope;
  spans?: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource?: OtlpResource;
  scopeSpans?: OtlpScopeSpans[];
}

/** The top-level body of a `POST /v1/traces` OTLP/JSON request. */
export interface OtlpTracesPayload {
  resourceSpans?: OtlpResourceSpans[];
}
