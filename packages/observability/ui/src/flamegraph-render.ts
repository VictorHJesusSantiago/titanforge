import type { FlamegraphRect } from './flamegraph-layout.js';

/**
 * Untested canvas-drawing glue: takes rectangles already computed by `computeFlamegraphLayout`
 * (the tested pure module) and paints them, wiring up a click handler that reports which span was
 * clicked so the caller can render its attributes. Deliberately thin — there is no logic here
 * worth a unit test that Canvas's 2D context itself wouldn't just be mocking; correctness lives in
 * the layout math, not in `fillRect` calls.
 */
export function drawFlamegraph(
  canvas: HTMLCanvasElement,
  rects: FlamegraphRect[],
  onSpanClick?: (rect: FlamegraphRect) => void,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const colorFor = (status: FlamegraphRect['statusCode']): string =>
    status === 'error' ? '#c0392b' : status === 'ok' ? '#2e7d5b' : '#5c6470';

  for (const rect of rects) {
    ctx.fillStyle = colorFor(rect.statusCode);
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeStyle = '#0b0d10';
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

    if (rect.width > 40) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '11px sans-serif';
      ctx.textBaseline = 'middle';
      const label = rect.name.length > rect.width / 6 ? `${rect.name.slice(0, Math.floor(rect.width / 6))}…` : rect.name;
      ctx.fillText(label, rect.x + 4, rect.y + rect.height / 2, rect.width - 8);
    }
  }

  if (onSpanClick) {
    canvas.onclick = (event: MouseEvent) => {
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const hit = rects.find((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
      if (hit) onSpanClick(hit);
    };
  }
}
