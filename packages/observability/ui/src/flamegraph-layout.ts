/**
 * Pure geometry for the flamegraph view: given the flamegraph-shaped span data
 * `@titanforge/server`'s `GET /api/traces/:traceId` returns (`depth` + `startOffsetNanos` +
 * `durationNanos`, both nanosecond fields serialized as decimal strings since they started life as
 * `bigint`s — see `@titanforge/server`'s `serialize.ts`), compute each span's on-screen rectangle.
 * Kept entirely free of `HTMLCanvasElement`/DOM so it's unit-testable without a browser, mirroring
 * this repo's pure-computation-vs-untested-glue split elsewhere (e.g. the SQL planner's pure cost
 * model vs. its executor glue).
 */

export interface FlamegraphSpanInput {
  spanId: string;
  name: string;
  depth: number;
  startOffsetNanos: string;
  durationNanos: string;
  statusCode: 'unset' | 'ok' | 'error';
  attributes: Record<string, string | number | boolean>;
}

export interface FlamegraphRect {
  spanId: string;
  name: string;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
  statusCode: 'unset' | 'ok' | 'error';
  attributes: Record<string, string | number | boolean>;
}

export interface FlamegraphLayoutOptions {
  totalWidth: number;
  rowHeight: number;
}

/**
 * Width is proportional to duration relative to the whole trace's span (the classic flamegraph
 * property: a rectangle's width tells you how much of the trace's wall-clock time a span
 * consumed); x is the span's offset from trace start, on the same scale. Depth maps directly to a
 * row (`y = depth * rowHeight`) — the classic flamegraph's other defining property, a strict
 * call-stack-shaped nesting rather than a general graph layout.
 *
 * A single, zero-duration root trace (or a totally empty input) can't be scaled by a real ratio —
 * both are handled explicitly rather than dividing by zero.
 */
export function computeFlamegraphLayout(spans: FlamegraphSpanInput[], options: FlamegraphLayoutOptions): FlamegraphRect[] {
  if (spans.length === 0) return [];

  const { totalWidth, rowHeight } = options;
  const totalDurationNanos = spans.reduce((max, s) => {
    const end = Number(s.startOffsetNanos) + Number(s.durationNanos);
    return end > max ? end : max;
  }, 0);

  return spans.map((span) => {
    const offset = Number(span.startOffsetNanos);
    const duration = Number(span.durationNanos);
    const x = totalDurationNanos > 0 ? (offset / totalDurationNanos) * totalWidth : 0;
    const width = totalDurationNanos > 0 ? Math.max((duration / totalDurationNanos) * totalWidth, 1) : totalWidth;
    return {
      spanId: span.spanId,
      name: span.name,
      depth: span.depth,
      x,
      y: span.depth * rowHeight,
      width,
      height: rowHeight,
      statusCode: span.statusCode,
      attributes: span.attributes,
    };
  });
}
