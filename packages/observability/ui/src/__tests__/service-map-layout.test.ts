import { describe, expect, it } from 'vitest';
import { computeServiceMapLayout } from '../service-map-layout.js';

describe('computeServiceMapLayout', () => {
  it('places a single node at the center', () => {
    const layout = computeServiceMapLayout(['solo'], [], { width: 400, height: 300 });
    expect(layout.nodePositions).toEqual([{ name: 'solo', x: 200, y: 150 }]);
  });

  it('places nodes evenly around a circle, starting at 12 oclock, going clockwise', () => {
    // 4 nodes at 0/90/180/270 degrees (measuring from -PI/2, clockwise).
    const layout = computeServiceMapLayout(['a', 'b', 'c', 'd'], [], { width: 400, height: 400, radius: 100 });
    const cx = 200;
    const cy = 200;
    const [a, b, c, d] = layout.nodePositions;

    expect(a!.x).toBeCloseTo(cx, 5);
    expect(a!.y).toBeCloseTo(cy - 100, 5); // top

    expect(b!.x).toBeCloseTo(cx + 100, 5); // right
    expect(b!.y).toBeCloseTo(cy, 5);

    expect(c!.x).toBeCloseTo(cx, 5); // bottom
    expect(c!.y).toBeCloseTo(cy + 100, 5);

    expect(d!.x).toBeCloseTo(cx - 100, 5); // left
    expect(d!.y).toBeCloseTo(cy, 5);
  });

  it('defaults radius to 40% of the smaller viewport dimension', () => {
    const layout = computeServiceMapLayout(['a', 'b'], [], { width: 1000, height: 500 });
    // radius = min(1000,500) * 0.4 = 200; two nodes at angle -PI/2 and PI/2.
    const [a, b] = layout.nodePositions;
    expect(a!.y).toBeCloseTo(250 - 200, 5);
    expect(b!.y).toBeCloseTo(250 + 200, 5);
  });

  it('resolves edge lines to the endpoints of their from/to node positions', () => {
    const layout = computeServiceMapLayout(['gateway', 'auth'], [{ from: 'gateway', to: 'auth', callCount: 5 }], {
      width: 400,
      height: 400,
      radius: 100,
    });
    const gateway = layout.nodePositions.find((n) => n.name === 'gateway')!;
    const auth = layout.nodePositions.find((n) => n.name === 'auth')!;
    expect(layout.edgeLines).toEqual([
      { from: 'gateway', to: 'auth', callCount: 5, x1: gateway.x, y1: gateway.y, x2: auth.x, y2: auth.y },
    ]);
  });

  it('silently skips an edge referencing a node outside the given node list', () => {
    const layout = computeServiceMapLayout(['a'], [{ from: 'a', to: 'ghost', callCount: 1 }], { width: 200, height: 200 });
    expect(layout.edgeLines).toEqual([]);
  });

  it('returns empty positions/edges for no nodes', () => {
    const layout = computeServiceMapLayout([], [], { width: 200, height: 200 });
    expect(layout).toEqual({ nodePositions: [], edgeLines: [] });
  });
});
