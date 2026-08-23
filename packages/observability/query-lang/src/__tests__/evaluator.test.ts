import { describe, expect, it } from 'vitest';
import type { Span } from '@titanforge/otlp';
import { parseQuery } from '../parser.js';
import { evaluateQuery, filterSpans } from '../evaluator.js';

function makeSpan(overrides: Partial<Span> & { spanId: string }): Span {
  return {
    traceId: 't1',
    parentSpanId: undefined,
    name: 'GET /orders',
    serviceName: 'api',
    startTimeUnixNano: 0n,
    endTimeUnixNano: 150_000_000n,
    durationNanos: 150_000_000n,
    attributes: { 'http.method': 'GET' },
    statusCode: 'ok',
    ...overrides,
  };
}

function evalSource(source: string, span: Span): boolean {
  return evaluateQuery(parseQuery(source), span);
}

describe('evaluateQuery', () => {
  it('matches a simple string equality', () => {
    expect(evalSource('service = "api"', makeSpan({ spanId: 's1', serviceName: 'api' }))).toBe(true);
    expect(evalSource('service = "api"', makeSpan({ spanId: 's2', serviceName: 'auth' }))).toBe(false);
  });

  it('matches numeric comparisons against duration (nanoseconds)', () => {
    const span = makeSpan({ spanId: 's1', durationNanos: 150_000_000n });
    expect(evalSource('duration > 100', span)).toBe(true);
    expect(evalSource('duration > 200000000', span)).toBe(false);
    expect(evalSource('duration >= 150000000', span)).toBe(true);
    expect(evalSource('duration <= 150000000', span)).toBe(true);
    expect(evalSource('duration < 150000000', span)).toBe(false);
  });

  it('matches attr.<key> against arbitrary attribute values', () => {
    const span = makeSpan({ spanId: 's1', attributes: { 'http.method': 'POST', retries: 2 } });
    expect(evalSource('attr.http_method = "POST"', makeSpan({ spanId: 's2', attributes: { http_method: 'POST' } }))).toBe(true);
    expect(evalSource('attr.retries > 1', span)).toBe(true);
    expect(evalSource('attr.retries > 5', span)).toBe(false);
  });

  it('an attr reference the span does not have never matches', () => {
    const span = makeSpan({ spanId: 's1', attributes: {} });
    expect(evalSource('attr.missing = "x"', span)).toBe(false);
    expect(evalSource('attr.missing != "x"', span)).toBe(false);
  });

  it('evaluates AND/OR/NOT correctly', () => {
    const errSpan = makeSpan({ spanId: 's1', serviceName: 'api', durationNanos: 500n, statusCode: 'error' });
    expect(evalSource('service = "api" AND duration > 100 AND status = "error"', errSpan)).toBe(true);
    expect(evalSource('service = "api" AND duration > 100 AND status = "ok"', errSpan)).toBe(false);
    expect(evalSource('service = "auth" OR status = "error"', errSpan)).toBe(true);
    expect(evalSource('NOT status = "error"', errSpan)).toBe(false);
    expect(evalSource('NOT status = "ok"', errSpan)).toBe(true);
  });

  it('respects AND-over-OR precedence when evaluating', () => {
    // "service = a OR service = b AND status = error" == "service = a OR (service = b AND status = error)"
    const span = makeSpan({ spanId: 's1', serviceName: 'b', statusCode: 'ok' });
    expect(evalSource('service = "a" OR service = "b" AND status = "error"', span)).toBe(false);
    const span2 = makeSpan({ spanId: 's2', serviceName: 'b', statusCode: 'error' });
    expect(evalSource('service = "a" OR service = "b" AND status = "error"', span2)).toBe(true);
  });

  it('ordering operators never match on non-numeric types', () => {
    expect(evalSource('service > 5', makeSpan({ spanId: 's1' }))).toBe(false);
  });

  it('filterSpans returns only matching spans, preserving order', () => {
    const spans = [
      makeSpan({ spanId: 's1', serviceName: 'api', durationNanos: 50n }),
      makeSpan({ spanId: 's2', serviceName: 'auth', durationNanos: 500n }),
      makeSpan({ spanId: 's3', serviceName: 'api', durationNanos: 500n }),
    ];
    const result = filterSpans(parseQuery('service = "api" AND duration > 100'), spans);
    expect(result.map((s) => s.spanId)).toEqual(['s3']);
  });
});
