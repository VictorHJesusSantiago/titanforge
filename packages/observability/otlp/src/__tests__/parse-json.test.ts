import { describe, expect, it } from 'vitest';
import { OtlpParseError, parseTracesJson } from '../parse-json.js';
import { buildTracesJson } from '../build-json.js';
import type { OtlpTracesPayload } from '../types.js';

/** A hand-constructed OTLP/JSON payload: two resources (services), one with two scopes, attribute-type variety, and a parent/child pair. */
function fixture(): OtlpTracesPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'gateway' } }],
        },
        scopeSpans: [
          {
            scope: { name: 'http-instrumentation', version: '1.0' },
            spans: [
              {
                traceId: 'trace-1',
                spanId: 'span-1',
                name: 'GET /orders',
                kind: 2,
                startTimeUnixNano: '1000000000',
                endTimeUnixNano: '1050000000',
                attributes: [
                  { key: 'http.method', value: { stringValue: 'GET' } },
                  { key: 'http.status_code', value: { intValue: '200' } },
                  { key: 'http.route.weight', value: { doubleValue: 1.5 } },
                  { key: 'http.cached', value: { boolValue: false } },
                ],
                status: { code: 1, message: 'OK' },
              },
            ],
          },
          {
            scope: { name: 'db-instrumentation' },
            spans: [
              {
                traceId: 'trace-1',
                spanId: 'span-2',
                parentSpanId: 'span-1',
                name: 'SELECT orders',
                startTimeUnixNano: 1010000000,
                endTimeUnixNano: 1040000000,
                status: { code: 0 },
              },
            ],
          },
        ],
      },
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'auth' } }],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'trace-1',
                spanId: 'span-3',
                parentSpanId: 'span-1',
                name: 'authorize',
                startTimeUnixNano: '1002000000',
                endTimeUnixNano: '1005000000',
                status: { code: 2, message: 'permission denied' },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('parseTracesJson', () => {
  it('flattens multiple resources and scopes into a flat Span[]', () => {
    const spans = parseTracesJson(fixture());
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => s.spanId)).toEqual(['span-1', 'span-2', 'span-3']);
  });

  it('stamps resource-level service.name onto each span', () => {
    const spans = parseTracesJson(fixture());
    expect(spans[0]?.serviceName).toBe('gateway');
    expect(spans[1]?.serviceName).toBe('gateway');
    expect(spans[2]?.serviceName).toBe('auth');
  });

  it('defaults missing service.name to "unknown_service"', () => {
    const spans = parseTracesJson({ resourceSpans: [{ scopeSpans: [{ spans: [
      { traceId: 't', spanId: 's', name: 'x', startTimeUnixNano: '0', endTimeUnixNano: '1' },
    ] }] }] });
    expect(spans[0]?.serviceName).toBe('unknown_service');
  });

  it('parses parent/child relationships and treats empty/missing parentSpanId as root', () => {
    const spans = parseTracesJson(fixture());
    expect(spans[0]?.parentSpanId).toBeUndefined();
    expect(spans[1]?.parentSpanId).toBe('span-1');
    expect(spans[2]?.parentSpanId).toBe('span-1');
  });

  it('computes durationNanos as end - start, accepting both string and number nano fields', () => {
    const spans = parseTracesJson(fixture());
    expect(spans[0]?.startTimeUnixNano).toBe(1_000_000_000n);
    expect(spans[0]?.endTimeUnixNano).toBe(1_050_000_000n);
    expect(spans[0]?.durationNanos).toBe(50_000_000n);
    // span-2 used numeric (not string) nano fields in the fixture.
    expect(spans[1]?.durationNanos).toBe(30_000_000n);
  });

  it('normalizes every attribute value variant to its plain JS type', () => {
    const spans = parseTracesJson(fixture());
    expect(spans[0]?.attributes).toEqual({
      'http.method': 'GET',
      'http.status_code': 200,
      'http.route.weight': 1.5,
      'http.cached': false,
    });
  });

  it('normalizes status codes: 1 -> ok, 2 -> error, 0/missing -> unset', () => {
    const spans = parseTracesJson(fixture());
    expect(spans[0]?.statusCode).toBe('ok');
    expect(spans[1]?.statusCode).toBe('unset');
    expect(spans[2]?.statusCode).toBe('error');
  });

  it('defaults to unset status when status is entirely absent', () => {
    const spans = parseTracesJson({ resourceSpans: [{ scopeSpans: [{ spans: [
      { traceId: 't', spanId: 's', name: 'x', startTimeUnixNano: '0', endTimeUnixNano: '1' },
    ] }] }] });
    expect(spans[0]?.statusCode).toBe('unset');
  });

  it('returns an empty array for an empty payload', () => {
    expect(parseTracesJson({})).toEqual([]);
    expect(parseTracesJson({ resourceSpans: [] })).toEqual([]);
  });

  it('throws OtlpParseError when a required field is missing', () => {
    expect(() =>
      parseTracesJson({
        resourceSpans: [{ scopeSpans: [{ spans: [{ spanId: 's', name: 'x', startTimeUnixNano: '0', endTimeUnixNano: '1' } as never] }] }],
      }),
    ).toThrow(OtlpParseError);
  });

  it('throws OtlpParseError on an attribute value with no recognized variant', () => {
    expect(() =>
      parseTracesJson({
        resourceSpans: [{ scopeSpans: [{ spans: [{
          traceId: 't', spanId: 's', name: 'x', startTimeUnixNano: '0', endTimeUnixNano: '1',
          attributes: [{ key: 'bad', value: {} }],
        }] }] }],
      }),
    ).toThrow(OtlpParseError);
  });
});

describe('buildTracesJson (inverse direction)', () => {
  it('round-trips spans -> buildTracesJson -> parseTracesJson losslessly (modulo numeric attribute subtype)', () => {
    const original = parseTracesJson(fixture());
    const rebuilt = parseTracesJson(buildTracesJson(original));

    // Order may differ (grouped by service) so compare as sets keyed by spanId.
    const byId = new Map(rebuilt.map((s) => [s.spanId, s]));
    for (const span of original) {
      const back = byId.get(span.spanId);
      expect(back).toBeDefined();
      expect(back?.traceId).toBe(span.traceId);
      expect(back?.parentSpanId).toBe(span.parentSpanId);
      expect(back?.name).toBe(span.name);
      expect(back?.serviceName).toBe(span.serviceName);
      expect(back?.startTimeUnixNano).toBe(span.startTimeUnixNano);
      expect(back?.endTimeUnixNano).toBe(span.endTimeUnixNano);
      expect(back?.statusCode).toBe(span.statusCode);
    }
  });

  it('groups spans by serviceName into separate resourceSpans entries', () => {
    const spans = parseTracesJson(fixture());
    const payload = buildTracesJson(spans);
    expect(payload.resourceSpans).toHaveLength(2);
    const names = payload.resourceSpans?.map((rs) => rs.resource?.attributes?.[0]?.value.stringValue).sort();
    expect(names).toEqual(['auth', 'gateway']);
  });
});
