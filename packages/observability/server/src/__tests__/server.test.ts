import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { OtlpTracesPayload } from '@titanforge/otlp';
import { createApp } from '../server.js';

/**
 * A realistic multi-service trace fixture: gateway -> auth -> db, gateway -> orders. Used across
 * the ingestion, flamegraph, service-map, and query-lang round-trip tests below so a single
 * `POST /v1/traces` seeds everything each suite needs.
 */
function tracePayload(): OtlpTracesPayload {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'gateway' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'trace-abc',
                spanId: 'span-root',
                name: 'GET /checkout',
                startTimeUnixNano: '1000000000',
                endTimeUnixNano: '5000000000',
                status: { code: 1 },
              },
            ],
          },
        ],
      },
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'auth' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'trace-abc',
                spanId: 'span-auth',
                parentSpanId: 'span-root',
                name: 'authorize',
                startTimeUnixNano: '1100000000',
                endTimeUnixNano: '1400000000',
                status: { code: 1 },
              },
            ],
          },
        ],
      },
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'db' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'trace-abc',
                spanId: 'span-db',
                parentSpanId: 'span-auth',
                name: 'SELECT users',
                startTimeUnixNano: '1150000000',
                endTimeUnixNano: '1350000000',
                status: { code: 1 },
              },
            ],
          },
        ],
      },
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'orders' } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'trace-abc',
                spanId: 'span-orders',
                parentSpanId: 'span-root',
                name: 'create-order',
                startTimeUnixNano: '2000000000',
                endTimeUnixNano: '4800000000',
                status: { code: 2, message: 'insufficient stock' },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('@titanforge/server integration', () => {
  let baseUrl: string;
  const server = createApp();

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('accepts a real OTLP JSON POST to /v1/traces', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tracePayload()),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ accepted: 4 });
  });

  it('GET /api/traces/:traceId returns every span in the trace with flamegraph offsets/depths', async () => {
    const res = await fetch(`${baseUrl}/api/traces/trace-abc`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.traceId).toBe('trace-abc');
    expect(body.spans).toHaveLength(4);

    const byId = new Map<string, { depth: number; startOffsetNanos: string }>(
      body.spans.map((s: { spanId: string; depth: number; startOffsetNanos: string }) => [s.spanId, s]),
    );
    expect(byId.get('span-root')?.depth).toBe(0);
    expect(byId.get('span-root')?.startOffsetNanos).toBe('0');
    expect(byId.get('span-auth')?.depth).toBe(1);
    expect(byId.get('span-db')?.depth).toBe(2);
    expect(byId.get('span-orders')?.depth).toBe(1);
  });

  it('GET /api/traces/:traceId 404s for an unknown trace id', async () => {
    const res = await fetch(`${baseUrl}/api/traces/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('GET /api/service-map derives the gateway/auth/db/orders graph from the ingested trace', async () => {
    const res = await fetch(`${baseUrl}/api/service-map`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(new Set(body.nodes)).toEqual(new Set(['gateway', 'auth', 'db', 'orders']));
    expect(body.edges).toEqual(
      expect.arrayContaining([
        { from: 'gateway', to: 'auth', callCount: 1 },
        { from: 'auth', to: 'db', callCount: 1 },
        { from: 'gateway', to: 'orders', callCount: 1 },
      ]),
    );
  });

  it('GET /api/query runs a query-lang search against ingested spans', async () => {
    const res = await fetch(`${baseUrl}/api/query?${new URLSearchParams({ q: 'status = "error"' }).toString()}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spans).toHaveLength(1);
    expect(body.spans[0].spanId).toBe('span-orders');
  });

  it('GET /api/query returns spans matching a service + duration filter', async () => {
    const res = await fetch(`${baseUrl}/api/query?${new URLSearchParams({ q: 'service = "auth" AND duration > 100' }).toString()}`);
    const body = await res.json();
    expect(body.spans).toHaveLength(1);
    expect(body.spans[0].spanId).toBe('span-auth');
  });

  it('GET /api/query 400s on a malformed query', async () => {
    const res = await fetch(`${baseUrl}/api/query?${new URLSearchParams({ q: 'service ===' }).toString()}`);
    expect(res.status).toBe(400);
  });

  it('POST /v1/traces 400s on invalid JSON', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });

  it('unknown routes 404', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it('GET /api/anomalies flags a clear duration outlier among repeated same-operation spans', async () => {
    const normalSpans = Array.from({ length: 10 }, (_, i) => ({
      traceId: `t-normal-${i}`,
      spanId: `n${i}`,
      name: 'cache-lookup',
      startTimeUnixNano: String(10_000_000_000 + i * 1_000_000_000),
      endTimeUnixNano: String(10_000_000_000 + i * 1_000_000_000 + 5_000_000),
      status: { code: 1 },
    }));
    const outlier = {
      traceId: 't-outlier',
      spanId: 'noutlier',
      name: 'cache-lookup',
      startTimeUnixNano: '30000000000',
      endTimeUnixNano: '35000000000', // 5,000,000,000ns — three orders of magnitude past the ~5ms baseline
      status: { code: 1 },
    };

    const payload: OtlpTracesPayload = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'cache-svc' } }] },
          scopeSpans: [{ spans: [...normalSpans, outlier] }],
        },
      ],
    };

    await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const res = await fetch(`${baseUrl}/api/anomalies`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const flaggedIds = body.anomalies.map((s: { spanId: string }) => s.spanId);
    expect(flaggedIds).toContain('noutlier');
    expect(flaggedIds).not.toContain('n0');
  });
});
