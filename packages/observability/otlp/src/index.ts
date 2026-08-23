export type {
  Span,
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpResource,
  OtlpInstrumentationScope,
  OtlpStatus,
  OtlpSpan,
  OtlpScopeSpans,
  OtlpResourceSpans,
  OtlpTracesPayload,
} from './types.js';
export { parseTracesJson, OtlpParseError } from './parse-json.js';
export { buildTracesJson } from './build-json.js';
