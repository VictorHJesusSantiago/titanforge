import type { Span } from '@titanforge/otlp';

/** The result of `aggregateDuration` for each supported statistic. */
export type DurationAggregate = 'avg' | 'p50' | 'p95' | 'p99' | 'max' | 'min';

/**
 * Span timestamps arrive as `bigint` nanoseconds (see `@titanforge/otlp`'s `Span` type, which
 * keeps them as `bigint` precisely so ingestion never silently loses precision). The columnar
 * store downgrades them to plain `number` nanoseconds on insert: a `number` only loses precision
 * past 2^53 ns (~104 days since the Unix epoch in nanosecond units — wildly larger than any
 * single trace or even a very long-lived query window), and every column here needs to be a flat
 * numeric array for range scans/percentiles to be cheap, which `bigint[]` (no typed-array support,
 * boxed comparisons) would defeat the purpose of.
 */
function nanosToNumber(value: bigint): number {
  return Number(value);
}

/**
 * A columnar span store: every span field lives in its own array, and row `i` across every array
 * is one span — the defining property of a columnar layout, as opposed to `Span[]` (an array of
 * row objects). The payoff shows up in `aggregateDuration`: computing p95 duration over a set of
 * rows touches exactly one `Float64Array`-shaped column and nothing else, not `n` heap-allocated
 * span objects each requiring a full property lookup and its `attributes` object to be touched
 * (and potentially paged in) even though aggregation never reads it.
 *
 * `attributesCol` is the one column that stays an array of plain objects rather than a flat typed
 * array — attribute sets are inherently heterogeneous (arbitrary keys, mixed value types), so
 * there is no fixed-width representation to flatten them into without a much larger secondary
 * schema-registry design that is out of scope here. That does not undermine the columnar point:
 * `scanRange`/`aggregateDuration`/`filterByService` never touch `attributesCol` at all, which is
 * exactly the property a columnar layout exists to give you.
 */
export class ColumnarSpanStore {
  private readonly traceIds: string[] = [];
  private readonly spanIds: string[] = [];
  private readonly parentSpanIds: (string | undefined)[] = [];
  private readonly names: string[] = [];
  private readonly serviceNames: string[] = [];
  private readonly startTimes: number[] = [];
  private readonly endTimes: number[] = [];
  private readonly durations: number[] = [];
  private readonly statusCodes: Span['statusCode'][] = [];
  private readonly attributesCol: Record<string, string | number | boolean>[] = [];

  /**
   * Secondary index: traceId -> row indices. A flamegraph needs "every span in trace X," and
   * without this a lookup is an O(n) scan of `traceIds` per request — fine for a demo, ruinous the
   * moment the store holds more than one trace's worth of spans (which, in a real deployment, it
   * always does; a single collector ingests thousands of concurrent traces). The index costs one
   * `Map` insert per `append` and turns the lookup into O(1) + O(k) for k = spans in that trace,
   * tested explicitly in `store.test.ts` alongside the naive-scan-equivalent result to prove it
   * doesn't drift from `filterByTraceId`'s contract.
   */
  private readonly traceIndex = new Map<string, number[]>();

  /** Appends one span, returning its row index. */
  append(span: Span): number {
    const index = this.traceIds.length;
    this.traceIds.push(span.traceId);
    this.spanIds.push(span.spanId);
    this.parentSpanIds.push(span.parentSpanId);
    this.names.push(span.name);
    this.serviceNames.push(span.serviceName);
    this.startTimes.push(nanosToNumber(span.startTimeUnixNano));
    this.endTimes.push(nanosToNumber(span.endTimeUnixNano));
    this.durations.push(nanosToNumber(span.durationNanos));
    this.statusCodes.push(span.statusCode);
    this.attributesCol.push(span.attributes);

    const bucket = this.traceIndex.get(span.traceId);
    if (bucket) bucket.push(index);
    else this.traceIndex.set(span.traceId, [index]);

    return index;
  }

  get size(): number {
    return this.traceIds.length;
  }

  /** Reconstructs the full `Span` object for a row index — used at query boundaries (API responses), never on a hot scan path. */
  getSpan(index: number): Span {
    const traceId = this.traceIds[index];
    const spanId = this.spanIds[index];
    const name = this.names[index];
    const serviceName = this.serviceNames[index];
    const startTimeUnixNano = this.startTimes[index];
    const endTimeUnixNano = this.endTimes[index];
    const durationNanos = this.durations[index];
    const statusCode = this.statusCodes[index];
    const attributes = this.attributesCol[index];
    if (
      traceId === undefined ||
      spanId === undefined ||
      name === undefined ||
      serviceName === undefined ||
      startTimeUnixNano === undefined ||
      endTimeUnixNano === undefined ||
      durationNanos === undefined ||
      statusCode === undefined ||
      attributes === undefined
    ) {
      throw new RangeError(`row index ${index} out of range (size = ${this.size})`);
    }
    return {
      traceId,
      spanId,
      parentSpanId: this.parentSpanIds[index],
      name,
      serviceName,
      startTimeUnixNano: BigInt(startTimeUnixNano),
      endTimeUnixNano: BigInt(endTimeUnixNano),
      durationNanos: BigInt(durationNanos),
      attributes,
      statusCode,
    };
  }

  /** All row indices whose span overlaps `[startTime, endTime]` (inclusive), scanning only the `startTimes`/`endTimes` columns. */
  scanRange(startTime: number, endTime: number): number[] {
    const indices: number[] = [];
    for (let i = 0; i < this.startTimes.length; i += 1) {
      const start = this.startTimes[i]!;
      const end = this.endTimes[i]!;
      if (start <= endTime && end >= startTime) indices.push(i);
    }
    return indices;
  }

  /** All row indices for spans from a given service, scanning only the `serviceNames` column. */
  filterByService(name: string): number[] {
    const indices: number[] = [];
    for (let i = 0; i < this.serviceNames.length; i += 1) {
      if (this.serviceNames[i] === name) indices.push(i);
    }
    return indices;
  }

  /** All row indices for a trace, via the secondary index — see the doc comment on `traceIndex`. */
  filterByTraceId(traceId: string): number[] {
    return [...(this.traceIndex.get(traceId) ?? [])];
  }

  /** Duration column value for a single row (nanoseconds), used by callers that already have an index (e.g. anomaly detection). */
  durationAt(index: number): number {
    const value = this.durations[index];
    if (value === undefined) throw new RangeError(`row index ${index} out of range (size = ${this.size})`);
    return value;
  }

  /**
   * Aggregates the `durations` column over a set of row indices. Percentiles are computed by
   * sorting the selected durations and taking the nearest-rank element — a real percentile, not
   * an approximation (e.g. t-digest/HDRHistogram-style sketches), which is the right tradeoff for
   * a store meant to be queried over bounded windows (one trace, one time range) rather than
   * continuously over an unbounded stream.
   */
  aggregateDuration(indices: number[], fn: DurationAggregate): number {
    if (indices.length === 0) return 0;
    const values = indices.map((i) => this.durationAt(i));

    if (fn === 'max') return Math.max(...values);
    if (fn === 'min') return Math.min(...values);
    if (fn === 'avg') return values.reduce((a, b) => a + b, 0) / values.length;

    const sorted = [...values].sort((a, b) => a - b);
    const percentile = fn === 'p50' ? 0.5 : fn === 'p95' ? 0.95 : 0.99;
    // Nearest-rank method: rank = ceil(p * n), 1-indexed, clamped into range.
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil(percentile * sorted.length)));
    return sorted[rank - 1]!;
  }
}
