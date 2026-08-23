import { describe, expect, it } from 'vitest';
import type { Span } from '@titanforge/otlp';
import { buildFlamegraphNodes } from '../flamegraph.js';

function makeSpan(overrides: Partial<Span> & { spanId: string }): Span {
  return {
    traceId: 't1',
    parentSpanId: undefined,
    name: 'op',
    serviceName: 'svc',
    startTimeUnixNano: 0n,
    endTimeUnixNano: 10n,
    durationNanos: 10n,
    attributes: {},
    statusCode: 'ok',
    ...overrides,
  };
}

describe('buildFlamegraphNodes', () => {
  it('computes startOffsetNanos relative to the earliest span and depth from the parent chain', () => {
    const spans: Span[] = [
      makeSpan({ spanId: 'root', startTimeUnixNano: 1000n, endTimeUnixNano: 5000n }),
      makeSpan({ spanId: 'child', parentSpanId: 'root', startTimeUnixNano: 1500n, endTimeUnixNano: 3000n }),
      makeSpan({ spanId: 'grandchild', parentSpanId: 'child', startTimeUnixNano: 2000n, endTimeUnixNano: 2500n }),
    ];
    const nodes = buildFlamegraphNodes(spans);
    const byId = new Map(nodes.map((n) => [n.spanId, n]));

    expect(byId.get('root')?.startOffsetNanos).toBe('0');
    expect(byId.get('root')?.depth).toBe(0);
    expect(byId.get('child')?.startOffsetNanos).toBe('500');
    expect(byId.get('child')?.depth).toBe(1);
    expect(byId.get('grandchild')?.startOffsetNanos).toBe('1000');
    expect(byId.get('grandchild')?.depth).toBe(2);
  });

  it('treats a span whose parent is outside the given set as a root (depth 0)', () => {
    const spans: Span[] = [makeSpan({ spanId: 'orphan', parentSpanId: 'not-included', startTimeUnixNano: 100n })];
    const nodes = buildFlamegraphNodes(spans);
    expect(nodes[0]?.depth).toBe(0);
  });

  it('serializes bigint fields as strings', () => {
    const nodes = buildFlamegraphNodes([makeSpan({ spanId: 's', durationNanos: 12345n })]);
    expect(nodes[0]?.durationNanos).toBe('12345');
    expect(typeof nodes[0]?.durationNanos).toBe('string');
  });

  it('returns an empty array for no spans', () => {
    expect(buildFlamegraphNodes([])).toEqual([]);
  });
});
