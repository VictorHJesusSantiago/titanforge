import type { Span } from '@titanforge/otlp';

/** JSON's spec has no bigint type — `JSON.stringify` throws on one outright — so every span leaving this server over HTTP has its nanosecond `bigint` fields downgraded to decimal strings, the same lossless-for-display convention OTLP/JSON itself uses for 64-bit fields (see `@titanforge/otlp`'s `intValue`). */
export interface SerializedSpan extends Omit<Span, 'startTimeUnixNano' | 'endTimeUnixNano' | 'durationNanos'> {
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  durationNanos: string;
}

export function serializeSpan(span: Span): SerializedSpan {
  return {
    ...span,
    startTimeUnixNano: span.startTimeUnixNano.toString(),
    endTimeUnixNano: span.endTimeUnixNano.toString(),
    durationNanos: span.durationNanos.toString(),
  };
}
