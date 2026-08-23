import { describe, expect, it } from 'vitest';
import type { Span } from '@titanforge/otlp';
import { buildServiceMap } from '../service-map.js';

function makeSpan(overrides: Partial<Span> & { spanId: string; serviceName: string }): Span {
  return {
    traceId: 't1',
    parentSpanId: undefined,
    name: 'op',
    startTimeUnixNano: 0n,
    endTimeUnixNano: 1n,
    durationNanos: 1n,
    attributes: {},
    statusCode: 'ok',
    ...overrides,
  };
}

describe('buildServiceMap', () => {
  it('builds the exact graph for a realistic multi-service trace: gateway -> auth -> db, gateway -> orders', () => {
    const spans: Span[] = [
      makeSpan({ spanId: 'root', serviceName: 'gateway' }),
      makeSpan({ spanId: 'authSpan', serviceName: 'auth', parentSpanId: 'root' }),
      makeSpan({ spanId: 'dbSpan', serviceName: 'db', parentSpanId: 'authSpan' }),
      makeSpan({ spanId: 'ordersSpan', serviceName: 'orders', parentSpanId: 'root' }),
    ];

    const map = buildServiceMap(spans);

    expect(new Set(map.nodes)).toEqual(new Set(['gateway', 'auth', 'db', 'orders']));
    expect(map.edges).toHaveLength(3);
    expect(map.edges).toEqual(
      expect.arrayContaining([
        { from: 'gateway', to: 'auth', callCount: 1 },
        { from: 'auth', to: 'db', callCount: 1 },
        { from: 'gateway', to: 'orders', callCount: 1 },
      ]),
    );
  });

  it('does not create an edge for same-service parent/child spans (internal fan-out)', () => {
    const spans: Span[] = [
      makeSpan({ spanId: 'root', serviceName: 'gateway' }),
      makeSpan({ spanId: 'child', serviceName: 'gateway', parentSpanId: 'root' }),
    ];
    const map = buildServiceMap(spans);
    expect(map.edges).toEqual([]);
    expect(map.nodes).toEqual(['gateway']);
  });

  it('accumulates callCount across repeated calls between the same two services', () => {
    const spans: Span[] = [
      makeSpan({ spanId: 'root', serviceName: 'gateway' }),
      makeSpan({ spanId: 'a1', serviceName: 'auth', parentSpanId: 'root' }),
      makeSpan({ spanId: 'a2', serviceName: 'auth', parentSpanId: 'root' }),
      makeSpan({ spanId: 'a3', serviceName: 'auth', parentSpanId: 'root' }),
    ];
    const map = buildServiceMap(spans);
    expect(map.edges).toEqual([{ from: 'gateway', to: 'auth', callCount: 3 }]);
  });

  it('ignores a span whose parent is not present in the given span set', () => {
    const spans: Span[] = [makeSpan({ spanId: 'orphan', serviceName: 'auth', parentSpanId: 'missing-parent' })];
    const map = buildServiceMap(spans);
    expect(map.edges).toEqual([]);
    expect(map.nodes).toEqual(['auth']);
  });

  it('returns an empty map for no spans', () => {
    expect(buildServiceMap([])).toEqual({ nodes: [], edges: [] });
  });

  it('aggregates edges across multiple independent traces', () => {
    const traceA: Span[] = [
      makeSpan({ spanId: 'a-root', traceId: 'A', serviceName: 'gateway' }),
      makeSpan({ spanId: 'a-child', traceId: 'A', serviceName: 'auth', parentSpanId: 'a-root' }),
    ];
    const traceB: Span[] = [
      makeSpan({ spanId: 'b-root', traceId: 'B', serviceName: 'gateway' }),
      makeSpan({ spanId: 'b-child', traceId: 'B', serviceName: 'auth', parentSpanId: 'b-root' }),
    ];
    const map = buildServiceMap([...traceA, ...traceB]);
    expect(map.edges).toEqual([{ from: 'gateway', to: 'auth', callCount: 2 }]);
  });
});
