import { computeFlamegraphLayout, type FlamegraphSpanInput } from './flamegraph-layout.js';
import { drawFlamegraph } from './flamegraph-render.js';
import { computeServiceMapLayout } from './service-map-layout.js';
import { drawServiceMap } from './service-map-render.js';
import { validateSearchQuery, buildQueryUrl } from './search.js';

/**
 * App wiring: DOM lookups, fetch calls, and event handlers only — no logic worth unit-testing
 * lives here (see the pure `flamegraph-layout.ts`/`service-map-layout.ts` modules for that). This
 * file was not exercised by a live browser check (no `playwright` dependency is present anywhere
 * in this monorepo's `node_modules`, and installing one was out of scope per this task's own
 * constraints), so treat it as reviewed-but-unverified glue, not tested software.
 */

// A real deployment would source this from a Vite env var (`import.meta.env.VITE_SERVER_URL`);
// hardcoded here to avoid pulling in `vite/client`'s ambient types for one constant in glue code
// that has no automated coverage anyway (see this file's top doc comment).
const SERVER_BASE_URL = 'http://localhost:4318';

function qs<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing required element: ${selector}`);
  return el;
}

async function loadTrace(traceId: string): Promise<void> {
  const res = await fetch(new URL(`/api/traces/${traceId}`, SERVER_BASE_URL));
  if (!res.ok) return;
  const body = (await res.json()) as { spans: FlamegraphSpanInput[] };

  const canvas = qs<HTMLCanvasElement>('#flamegraph-canvas');
  const attrsPanel = qs<HTMLElement>('#span-attributes');
  const rects = computeFlamegraphLayout(body.spans, { totalWidth: canvas.width, rowHeight: 24 });
  drawFlamegraph(canvas, rects, (rect) => {
    attrsPanel.textContent = JSON.stringify({ name: rect.name, status: rect.statusCode, attributes: rect.attributes }, null, 2);
  });
}

async function loadServiceMap(): Promise<void> {
  const res = await fetch(new URL('/api/service-map', SERVER_BASE_URL));
  if (!res.ok) return;
  const body = (await res.json()) as { nodes: string[]; edges: { from: string; to: string; callCount: number }[] };

  const canvas = qs<HTMLCanvasElement>('#service-map-canvas');
  const layout = computeServiceMapLayout(body.nodes, body.edges, { width: canvas.width, height: canvas.height });
  drawServiceMap(canvas, layout);
}

function wireSearch(): void {
  const input = qs<HTMLInputElement>('#search-input');
  const status = qs<HTMLElement>('#search-status');
  const results = qs<HTMLElement>('#search-results');

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const source = input.value;
    const validation = validateSearchQuery(source);
    if (!validation.valid) {
      status.textContent = `parse error at ${validation.pos}: ${validation.message}`;
      return;
    }
    status.textContent = '';
    fetch(buildQueryUrl(SERVER_BASE_URL, source))
      .then((res) => res.json())
      .then((body: { spans: { spanId: string; name: string; serviceName: string }[] }) => {
        results.textContent = JSON.stringify(body.spans, null, 2);
      })
      .catch((err: unknown) => {
        status.textContent = err instanceof Error ? err.message : String(err);
      });
  });
}

function init(): void {
  wireSearch();
  void loadServiceMap();
  const params = new URLSearchParams(window.location.search);
  const traceId = params.get('trace');
  if (traceId) void loadTrace(traceId);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}
