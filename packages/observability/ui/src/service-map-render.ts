import type { ServiceMapLayout } from './service-map-layout.js';

/** Untested canvas-drawing glue for the service map — see `flamegraph-render.ts`'s doc comment for why this stays thin and unit-test-free; the layout math it draws is what's actually tested. */
export function drawServiceMap(canvas: HTMLCanvasElement, layout: ServiceMapLayout): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#5c6470';
  ctx.lineWidth = 1;
  for (const edge of layout.edgeLines) {
    ctx.beginPath();
    ctx.moveTo(edge.x1, edge.y1);
    ctx.lineTo(edge.x2, edge.y2);
    ctx.stroke();

    const midX = (edge.x1 + edge.x2) / 2;
    const midY = (edge.y1 + edge.y2) / 2;
    ctx.fillStyle = '#9aa4b2';
    ctx.font = '10px sans-serif';
    ctx.fillText(String(edge.callCount), midX, midY);
  }

  const nodeRadius = 24;
  for (const node of layout.nodePositions) {
    ctx.fillStyle = '#2e7d5b';
    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeRadius, 0, 2 * Math.PI);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.name, node.x, node.y);
  }
  ctx.textAlign = 'left';
}
