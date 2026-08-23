import { describe, expect, it } from 'vitest';
import type { Span } from '@titanforge/otlp';
import { ColumnarSpanStore } from '../store.js';

function makeSpan(overrides: Partial<Span> & { spanId: string }): Span {
  return {
    traceId: 'trace-1',
    parentSpanId: undefined,
    name: 'op',
    serviceName: 'svc',
    startTimeUnixNano: 1_000n,
    endTimeUnixNano: 2_000n,
    durationNanos: 1_000n,
    attributes: {},
    statusCode: 'ok',
    ...overrides,
  };
}

describe('ColumnarSpanStore', () => {
  it('append/getSpan round-trips a span exactly', () => {
    const store = new ColumnarSpanStore();
    const span = makeSpan({ spanId: 's1', attributes: { 'http.method': 'GET', code: 200, ok: true } });
    const index = store.append(span);
    expect(store.getSpan(index)).toEqual(span);
    expect(store.size).toBe(1);
  });

  it('scanRange returns rows whose [start,end] overlaps the query window', () => {
    const store = new ColumnarSpanStore();
    store.append(makeSpan({ spanId: 'a', startTimeUnixNano: 0n, endTimeUnixNano: 100n }));
    store.append(makeSpan({ spanId: 'b', startTimeUnixNano: 200n, endTimeUnixNano: 300n }));
    store.append(makeSpan({ spanId: 'c', startTimeUnixNano: 250n, endTimeUnixNano: 400n }));
    store.append(makeSpan({ spanId: 'd', startTimeUnixNano: 500n, endTimeUnixNano: 600n }));

    const indices = store.scanRange(150, 350);
    const ids = indices.map((i) => store.getSpan(i).spanId).sort();
    expect(ids).toEqual(['b', 'c']);
  });

  it('scanRange excludes ranges entirely outside the window', () => {
    const store = new ColumnarSpanStore();
    store.append(makeSpan({ spanId: 'a', startTimeUnixNano: 0n, endTimeUnixNano: 10n }));
    expect(store.scanRange(100, 200)).toEqual([]);
  });

  it('filterByService returns only matching rows, scanning the service column', () => {
    const store = new ColumnarSpanStore();
    store.append(makeSpan({ spanId: 'a', serviceName: 'gateway' }));
    store.append(makeSpan({ spanId: 'b', serviceName: 'auth' }));
    store.append(makeSpan({ spanId: 'c', serviceName: 'gateway' }));

    const indices = store.filterByService('gateway');
    expect(indices.map((i) => store.getSpan(i).spanId).sort()).toEqual(['a', 'c']);
    expect(store.filterByService('nonexistent')).toEqual([]);
  });

  it('filterByTraceId uses the secondary index and matches a naive linear scan', () => {
    const store = new ColumnarSpanStore();
    store.append(makeSpan({ spanId: 'a', traceId: 't1' }));
    store.append(makeSpan({ spanId: 'b', traceId: 't2' }));
    store.append(makeSpan({ spanId: 'c', traceId: 't1' }));
    store.append(makeSpan({ spanId: 'd', traceId: 't1' }));

    const indexed = store.filterByTraceId('t1');
    // Equivalent naive linear scan, to prove the secondary index doesn't drift from ground truth.
    const naive: number[] = [];
    for (let i = 0; i < store.size; i += 1) if (store.getSpan(i).traceId === 't1') naive.push(i);

    expect(indexed).toEqual(naive);
    expect(indexed.map((i) => store.getSpan(i).spanId)).toEqual(['a', 'c', 'd']);
    expect(store.filterByTraceId('nonexistent')).toEqual([]);
  });

  it('filterByTraceId returns a fresh array each call (no aliasing of internal state)', () => {
    const store = new ColumnarSpanStore();
    store.append(makeSpan({ spanId: 'a', traceId: 't1' }));
    const first = store.filterByTraceId('t1');
    first.push(999);
    const second = store.filterByTraceId('t1');
    expect(second).toEqual([0]);
  });

  describe('aggregateDuration', () => {
    // Durations (ns): 10, 20, 30, ..., 100 -- ten values, hand-computable percentiles.
    function tenValueStore(): { store: ColumnarSpanStore; indices: number[] } {
      const store = new ColumnarSpanStore();
      const indices: number[] = [];
      for (let i = 1; i <= 10; i += 1) {
        indices.push(store.append(makeSpan({ spanId: `s${i}`, durationNanos: BigInt(i * 10) })));
      }
      return { store, indices };
    }

    it('avg', () => {
      const { store, indices } = tenValueStore();
      expect(store.aggregateDuration(indices, 'avg')).toBe(55); // (10+...+100)/10
    });

    it('max and min', () => {
      const { store, indices } = tenValueStore();
      expect(store.aggregateDuration(indices, 'max')).toBe(100);
      expect(store.aggregateDuration(indices, 'min')).toBe(10);
    });

    it('p50 (nearest-rank over 10 sorted values)', () => {
      const { store, indices } = tenValueStore();
      // rank = ceil(0.5 * 10) = 5 -> sorted[4] = 50
      expect(store.aggregateDuration(indices, 'p50')).toBe(50);
    });

    it('p95 and p99 (nearest-rank over 10 sorted values)', () => {
      const { store, indices } = tenValueStore();
      // p95: rank = ceil(0.95*10) = 10 -> sorted[9] = 100
      expect(store.aggregateDuration(indices, 'p95')).toBe(100);
      // p99: rank = ceil(0.99*10) = 10 -> sorted[9] = 100
      expect(store.aggregateDuration(indices, 'p99')).toBe(100);
    });

    it('percentiles over an unsorted subset of indices are computed correctly', () => {
      const { store } = tenValueStore();
      // Subset: durations 100,10,50,20 (indices 9,0,4,1) -> sorted [10,20,50,100]
      const subset = [9, 0, 4, 1];
      // p50: rank = ceil(0.5*4) = 2 -> sorted[1] = 20
      expect(store.aggregateDuration(subset, 'p50')).toBe(20);
    });

    it('returns 0 for an empty index set', () => {
      const store = new ColumnarSpanStore();
      expect(store.aggregateDuration([], 'avg')).toBe(0);
      expect(store.aggregateDuration([], 'p99')).toBe(0);
    });
  });

  it('getSpan throws RangeError for an out-of-bounds index', () => {
    const store = new ColumnarSpanStore();
    expect(() => store.getSpan(0)).toThrow(RangeError);
  });
});
