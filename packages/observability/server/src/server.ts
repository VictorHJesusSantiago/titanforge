import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { OtlpParseError, parseTracesJson, type OtlpTracesPayload } from '@titanforge/otlp';
import { ColumnarSpanStore } from '@titanforge/columnar-store';
import { parseQuery, filterSpans, QueryParseError, type QueryAst } from '@titanforge/query-lang';
import { buildServiceMap } from '@titanforge/analysis';
import { buildFlamegraphNodes } from './flamegraph.js';
import { findAnomalousSpans } from './anomalies.js';
import { serializeSpan } from './serialize.js';

/**
 * Built on Node's built-in `http` module rather than Express. The task brief asked for Express,
 * but this monorepo's install step is explicitly off-limits for this work (concurrent agents are
 * touching shared workspace state, and `express`/`@types/express` are not present in
 * `node_modules`) — adding an `express` dependency to `package.json` without being able to
 * install it would leave every test and `tsc -b` run broken. A hand-rolled router over `http` is
 * a small, honest substitute that keeps the same route table and the same request/response
 * semantics the brief asked for, and fits this repo's broader "written from scratch" ethos better
 * than a framework dependency would have anyway.
 */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createApp(store: ColumnarSpanStore = new ColumnarSpanStore()): Server {
  return createHttpServer((req, res) => {
    void handleRequest(store, req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handleRequest(store: ColumnarSpanStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';

  if (method === 'POST' && url.pathname === '/v1/traces') {
    return handleIngestTraces(store, req, res);
  }

  const traceMatch = /^\/api\/traces\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && traceMatch) {
    return handleGetTrace(store, traceMatch[1]!, res);
  }

  if (method === 'GET' && url.pathname === '/api/query') {
    return handleQuery(store, url, res);
  }

  if (method === 'GET' && url.pathname === '/api/service-map') {
    return handleServiceMap(store, res);
  }

  if (method === 'GET' && url.pathname === '/api/anomalies') {
    return handleAnomalies(store, res);
  }

  sendJson(res, 404, { error: `no route for ${method} ${url.pathname}` });
  return undefined;
}

async function handleIngestTraces(store: ColumnarSpanStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let payload: OtlpTracesPayload;
  try {
    payload = JSON.parse(raw) as OtlpTracesPayload;
  } catch {
    return sendJson(res, 400, { error: 'request body is not valid JSON' });
  }

  try {
    const spans = parseTracesJson(payload);
    for (const span of spans) store.append(span);
    sendJson(res, 200, { accepted: spans.length });
  } catch (err) {
    if (err instanceof OtlpParseError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    throw err;
  }
}

function handleGetTrace(store: ColumnarSpanStore, traceId: string, res: ServerResponse): void {
  const indices = store.filterByTraceId(traceId);
  if (indices.length === 0) {
    sendJson(res, 404, { error: `no trace found for id "${traceId}"` });
    return;
  }
  const spans = indices.map((i) => store.getSpan(i));
  sendJson(res, 200, { traceId, spans: buildFlamegraphNodes(spans) });
}

function handleQuery(store: ColumnarSpanStore, url: URL, res: ServerResponse): void {
  const q = url.searchParams.get('q');
  if (q === null) {
    sendJson(res, 400, { error: 'missing required query parameter "q"' });
    return;
  }

  let ast: QueryAst;
  try {
    ast = parseQuery(q);
  } catch (err) {
    if (err instanceof QueryParseError) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    throw err;
  }

  const allSpans = Array.from({ length: store.size }, (_, i) => store.getSpan(i));
  const matched = filterSpans(ast, allSpans);
  sendJson(res, 200, { spans: matched.map(serializeSpan) });
}

function handleServiceMap(store: ColumnarSpanStore, res: ServerResponse): void {
  const allSpans = Array.from({ length: store.size }, (_, i) => store.getSpan(i));
  sendJson(res, 200, buildServiceMap(allSpans));
}

function handleAnomalies(store: ColumnarSpanStore, res: ServerResponse): void {
  const allSpans = Array.from({ length: store.size }, (_, i) => store.getSpan(i));
  sendJson(res, 200, { anomalies: findAnomalousSpans(allSpans) });
}
