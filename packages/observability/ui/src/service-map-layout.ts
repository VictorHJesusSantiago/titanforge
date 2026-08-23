/**
 * Pure geometry for the service map view. This builds a **circular layout** (nodes evenly spaced
 * around a circle), not a force-directed one — a real force-directed layout (iterative
 * spring/repulsion simulation converging to a stable arrangement) is a meaningfully sized
 * algorithm on its own, and a circular layout is an honest, deterministic, dependency-free
 * fallback that is trivially unit-testable (exact expected coordinates, not "eventually settles
 * near roughly here") and reads perfectly clearly for the node counts a demo/small deployment's
 * service map actually has.
 */

export interface ServiceMapNodePosition {
  name: string;
  x: number;
  y: number;
}

export interface ServiceMapEdgeLine {
  from: string;
  to: string;
  callCount: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ServiceMapLayout {
  nodePositions: ServiceMapNodePosition[];
  edgeLines: ServiceMapEdgeLine[];
}

export interface ServiceMapLayoutOptions {
  width: number;
  height: number;
  /** Defaults to 80% of half the smaller dimension, leaving margin for node labels. */
  radius?: number;
}

/**
 * Places `nodes` evenly around a circle centered in the given viewport, starting at 12 o'clock
 * (angle `-PI/2`) and proceeding clockwise — an arbitrary but fixed convention, chosen so layout
 * output is deterministic and exactly reproducible in tests (no simulation, no random seed).
 * `edgeLines` are resolved straight-line segments between each edge's two node positions, so the
 * canvas-drawing glue never has to look node positions up itself.
 */
export function computeServiceMapLayout(
  nodes: string[],
  edges: { from: string; to: string; callCount: number }[],
  options: ServiceMapLayoutOptions,
): ServiceMapLayout {
  const cx = options.width / 2;
  const cy = options.height / 2;
  const radius = options.radius ?? Math.min(options.width, options.height) * 0.4;

  const positions = new Map<string, ServiceMapNodePosition>();
  const n = nodes.length;
  nodes.forEach((name, i) => {
    // n === 1 avoids a meaningless angle computation; a single node just sits at the center.
    const angle = n <= 1 ? -Math.PI / 2 : (2 * Math.PI * i) / n - Math.PI / 2;
    const x = n <= 1 ? cx : cx + radius * Math.cos(angle);
    const y = n <= 1 ? cy : cy + radius * Math.sin(angle);
    positions.set(name, { name, x, y });
  });

  const edgeLines: ServiceMapEdgeLine[] = [];
  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue; // an edge referencing a node outside `nodes` is a malformed input we silently skip rather than crash the view on.
    edgeLines.push({ from: edge.from, to: edge.to, callCount: edge.callCount, x1: from.x, y1: from.y, x2: to.x, y2: to.y });
  }

  return { nodePositions: [...positions.values()], edgeLines };
}
