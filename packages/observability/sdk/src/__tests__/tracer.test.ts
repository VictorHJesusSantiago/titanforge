import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTracesJson } from '@titanforge/otlp';
import { Tracer } from '../tracer.js';

describe('Tracer', () => {
  let tracer: Tracer;

  afterEach(() => {
    tracer.uninstrumentFetch();
    vi.unstubAllGlobals();
  });

  describe('manual startSpan/end', () => {
    beforeEach(() => {
      tracer = new Tracer({ collectorUrl: 'http://collector.example/v1/traces', serviceName: 'test-service', batchSize: 1000 });
    });

    it('produces a span with correct name/attributes/status on end()', async () => {
      const span = tracer.startSpan('do-work', { attempt: 1 });
      span.setAttribute('extra', 'value');
      span.setStatus('ok');
      span.end();
      expect(tracer.bufferedCount).toBe(1);
    });

    it('nests a child span under the current parent via the explicit stack', () => {
      const parent = tracer.startSpan('parent');
      const child = tracer.startSpan('child');
      expect(child.traceId).toBe(parent.traceId);
      child.end();
      parent.end();
    });

    it('exposes currentSpan as the top of the stack', () => {
      expect(tracer.currentSpan).toBeUndefined();
      const parent = tracer.startSpan('parent');
      expect(tracer.currentSpan?.spanId).toBe(parent.spanId);
      const child = tracer.startSpan('child');
      expect(tracer.currentSpan?.spanId).toBe(child.spanId);
      child.end();
      expect(tracer.currentSpan?.spanId).toBe(parent.spanId);
      parent.end();
      expect(tracer.currentSpan).toBeUndefined();
    });

    it('gives sibling spans (not nested) independent trace ids when there is no open parent', () => {
      const a = tracer.startSpan('a');
      a.end();
      const b = tracer.startSpan('b');
      b.end();
      expect(a.traceId).not.toBe(b.traceId);
    });

    it('end() is idempotent — calling it twice does not double-buffer the span', () => {
      const span = tracer.startSpan('x');
      span.end();
      span.end();
      expect(tracer.bufferedCount).toBe(1);
    });
  });

  describe('flush / export', () => {
    it('POSTs buffered spans to the collector URL as valid OTLP JSON', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      tracer = new Tracer({ collectorUrl: 'http://collector.example/v1/traces', serviceName: 'checkout', batchSize: 1000, exportFetch: fetchMock });

      const span = tracer.startSpan('process-order', { orderId: 42 });
      span.end();
      await tracer.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://collector.example/v1/traces');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });

      const body = JSON.parse(init?.body as string);
      expect(body.resourceSpans).toBeDefined();
      const parsed = parseTracesJson(body);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.name).toBe('process-order');
      expect(parsed[0]?.serviceName).toBe('checkout');
      expect(parsed[0]?.attributes).toEqual({ orderId: 42 });
    });

    it('auto-flushes once the buffer reaches batchSize', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      tracer = new Tracer({ collectorUrl: 'http://collector.example/v1/traces', serviceName: 'svc', batchSize: 2, exportFetch: fetchMock });

      tracer.startSpan('a').end();
      expect(tracer.bufferedCount).toBe(1);
      tracer.startSpan('b').end();
      // The auto-flush fires (fire-and-forget) as soon as the buffer hits batchSize.
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('flush() with an empty buffer is a no-op that does not call fetch', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      tracer = new Tracer({ collectorUrl: 'http://collector.example/v1/traces', serviceName: 'svc', exportFetch: fetchMock });
      await tracer.flush();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('instrumentFetch', () => {
    beforeEach(() => {
      tracer = new Tracer({ collectorUrl: 'http://collector.example/v1/traces', serviceName: 'web-app', batchSize: 1000 });
    });

    it('wraps global fetch and produces a span with correct name/duration/status for a successful call', async () => {
      const stub = vi.fn(async () => new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', stub);

      tracer.instrumentFetch();
      const response = await fetch('http://api.example/orders', { method: 'GET' });
      expect(response.status).toBe(200);

      expect(tracer.bufferedCount).toBe(1);
    });

    it('POSTs an OTLP span reflecting the wrapped fetch call, including status "error" for a non-2xx response', async () => {
      const stub = vi.fn(async () => new Response('nope', { status: 500 }));
      vi.stubGlobal('fetch', stub);
      const exportFetch = vi.fn(async () => new Response(null, { status: 200 }));
      tracer = new Tracer({ collectorUrl: 'http://collector.example/v1/traces', serviceName: 'web-app', batchSize: 1000, exportFetch });

      tracer.instrumentFetch();
      await fetch('http://api.example/fail');
      await tracer.flush();

      const body = JSON.parse(exportFetch.mock.calls[0]![1]?.body as string);
      const parsed = parseTracesJson(body);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.name).toBe('HTTP GET');
      expect(parsed[0]?.statusCode).toBe('error');
      expect(parsed[0]?.attributes['http.status_code']).toBe(500);
      expect(parsed[0]?.attributes['http.url']).toBe('http://api.example/fail');
      expect(typeof parsed[0]?.durationNanos).toBe('bigint');
    });

    it('marks a thrown network error as an error-status span and still rethrows', async () => {
      const stub = vi.fn(async () => {
        throw new Error('network down');
      });
      vi.stubGlobal('fetch', stub);
      tracer.instrumentFetch();

      await expect(fetch('http://api.example/boom')).rejects.toThrow('network down');
      expect(tracer.bufferedCount).toBe(1);
    });

    it('nests an auto-instrumented fetch span under a manually started parent span', async () => {
      const stub = vi.fn(async () => new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', stub);
      tracer.instrumentFetch();

      const parent = tracer.startSpan('checkout-flow');
      await fetch('http://api.example/pay');
      parent.end();

      expect(tracer.bufferedCount).toBe(2);
    });

    it('instrumentFetch() is idempotent', async () => {
      const stub = vi.fn(async () => new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', stub);
      tracer.instrumentFetch();
      tracer.instrumentFetch();
      await fetch('http://api.example/x');
      expect(stub).toHaveBeenCalledTimes(1);
    });
  });
});
