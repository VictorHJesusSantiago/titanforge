import { describe, expect, it } from 'vitest';
import { computeFlamegraphLayout, type FlamegraphSpanInput } from '../flamegraph-layout.js';

function span(overrides: Partial<FlamegraphSpanInput> & { spanId: string }): FlamegraphSpanInput {
  return {
    name: 'op',
    depth: 0,
    startOffsetNanos: '0',
    durationNanos: '100',
    statusCode: 'ok',
    attributes: {},
    ...overrides,
  };
}

describe('computeFlamegraphLayout', () => {
  it('returns an empty array for no spans', () => {
    expect(computeFlamegraphLayout([], { totalWidth: 1000, rowHeight: 20 })).toEqual([]);
  });

  it('scales width proportionally to duration relative to total trace span', () => {
    // Root spans the full 1000ns trace; a child spans half of it, starting at 250ns.
    const spans = [
      span({ spanId: 'root', startOffsetNanos: '0', durationNanos: '1000', depth: 0 }),
      span({ spanId: 'child', startOffsetNanos: '250', durationNanos: '500', depth: 1 }),
    ];
    const rects = computeFlamegraphLayout(spans, { totalWidth: 1000, rowHeight: 20 });
    const root = rects.find((r) => r.spanId === 'root')!;
    const child = rects.find((r) => r.spanId === 'child')!;

    expect(root.x).toBe(0);
    expect(root.width).toBe(1000);
    expect(child.x).toBe(250); // (250/1000) * 1000
    expect(child.width).toBe(500); // (500/1000) * 1000
  });

  it('maps depth directly to y = depth * rowHeight', () => {
    const spans = [
      span({ spanId: 'a', depth: 0 }),
      span({ spanId: 'b', depth: 1 }),
      span({ spanId: 'c', depth: 3 }),
    ];
    const rects = computeFlamegraphLayout(spans, { totalWidth: 500, rowHeight: 24 });
    expect(rects.find((r) => r.spanId === 'a')!.y).toBe(0);
    expect(rects.find((r) => r.spanId === 'b')!.y).toBe(24);
    expect(rects.find((r) => r.spanId === 'c')!.y).toBe(72);
  });

  it('gives every rect the configured row height', () => {
    const rects = computeFlamegraphLayout([span({ spanId: 'a' })], { totalWidth: 500, rowHeight: 30 });
    expect(rects[0]?.height).toBe(30);
  });

  it('clamps a vanishingly short span to a minimum 1px width rather than rounding to 0', () => {
    const spans = [
      span({ spanId: 'root', startOffsetNanos: '0', durationNanos: '1000000000', depth: 0 }),
      span({ spanId: 'tiny', startOffsetNanos: '0', durationNanos: '1', depth: 1 }),
    ];
    const rects = computeFlamegraphLayout(spans, { totalWidth: 1000, rowHeight: 20 });
    expect(rects.find((r) => r.spanId === 'tiny')!.width).toBeGreaterThanOrEqual(1);
  });

  it('handles a single zero-duration span without dividing by zero', () => {
    const rects = computeFlamegraphLayout([span({ spanId: 'only', durationNanos: '0' })], { totalWidth: 800, rowHeight: 20 });
    expect(rects[0]?.x).toBe(0);
    expect(rects[0]?.width).toBe(800);
  });

  it('preserves name, statusCode, and attributes for the click-to-inspect feature', () => {
    const rects = computeFlamegraphLayout(
      [span({ spanId: 'a', name: 'SELECT users', statusCode: 'error', attributes: { 'db.statement': 'SELECT *' } })],
      { totalWidth: 500, rowHeight: 20 },
    );
    expect(rects[0]).toMatchObject({ name: 'SELECT users', statusCode: 'error', attributes: { 'db.statement': 'SELECT *' } });
  });
});
