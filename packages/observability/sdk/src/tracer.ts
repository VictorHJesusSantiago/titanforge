import type { Span } from '@titanforge/otlp';
import { buildTracesJson } from '@titanforge/otlp';
import { generateSpanId, generateTraceId } from './ids.js';

export interface SdkConfig {
  /** URL of an OTLP/HTTP JSON collector (e.g. `@titanforge/server`'s `POST /v1/traces`). */
  collectorUrl: string;
  serviceName: string;
  /** Flush automatically once this many finished spans are buffered. Default 20. */
  batchSize?: number;
  /** `fetch` implementation to use for exporting batches — defaults to the current `globalThis.fetch`, captured once at construction time so instrumenting fetch afterward can't cause the exporter to recursively trace its own export calls. */
  exportFetch?: typeof fetch;
}

/** A live span returned by `startSpan` — mutate attributes/status while it's open, then call `end()` exactly once. */
export interface SpanHandle {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: 'ok' | 'error'): void;
  end(): void;
}

interface OpenSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  startTimeUnixNano: bigint;
  attributes: Record<string, string | number | boolean>;
  statusCode: 'unset' | 'ok' | 'error';
}

function nowNanos(): bigint {
  // Date.now() is millisecond precision; OTLP wants nanoseconds. We don't have real sub-millisecond
  // wall-clock precision available portably (performance.now() is monotonic but not wall-clock-anchored
  // the same way across Node/browser), so this is honestly millisecond-precision timing padded to
  // nanoseconds, not true nanosecond precision — sufficient for span duration math in this SDK's scope.
  return BigInt(Date.now()) * 1_000_000n;
}

/**
 * Tracks the "current" span via an explicit stack rather than Node's `AsyncLocalStorage`. ALS
 * would give correct parent attribution across concurrent overlapping async operations, but it's
 * Node-only — this SDK is required to run in a browser too, where there is no ALS equivalent. The
 * explicit stack is the simplest thing that works identically in both environments; its
 * documented limitation is that two *concurrently in-flight* async operations sharing one Tracer
 * will see each other's spans as their "current parent" if their start/end calls interleave
 * (e.g. `await` in between), since there's only one shared stack, not one per logical call chain.
 * Sequential/nested usage (the overwhelmingly common case — call a traced function, await it,
 * then call the next) attributes parents correctly.
 */
export class Tracer {
  private readonly stack: OpenSpan[] = [];
  private readonly buffer: Span[] = [];
  private readonly batchSize: number;
  private readonly exportFetch: typeof fetch;
  private originalFetch: typeof fetch | undefined;

  constructor(private readonly config: SdkConfig) {
    this.batchSize = config.batchSize ?? 20;
    this.exportFetch = config.exportFetch ?? globalThis.fetch.bind(globalThis);
  }

  get currentSpan(): SpanHandle | undefined {
    const top = this.stack.at(-1);
    return top ? this.toHandle(top) : undefined;
  }

  /** Starts a new span, nested under whatever span is currently on top of the stack (if any). */
  startSpan(name: string, attributes: Record<string, string | number | boolean> = {}): SpanHandle {
    const parent = this.stack.at(-1);
    const open: OpenSpan = {
      traceId: parent ? parent.traceId : generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId: parent?.spanId,
      name,
      startTimeUnixNano: nowNanos(),
      attributes: { ...attributes },
      statusCode: 'unset',
    };
    this.stack.push(open);
    return this.toHandle(open);
  }

  private toHandle(open: OpenSpan): SpanHandle {
    let ended = false;
    return {
      traceId: open.traceId,
      spanId: open.spanId,
      setAttribute: (key, value) => {
        open.attributes[key] = value;
      },
      setStatus: (status) => {
        open.statusCode = status;
      },
      end: () => {
        if (ended) return; // end() is documented as idempotent-safe to call at most meaningfully once, but double-calls (e.g. a finally block after an early return) shouldn't double-buffer the span.
        ended = true;
        this.finishSpan(open);
      },
    };
  }

  private finishSpan(open: OpenSpan): void {
    // Remove this span from the stack. It's normally the top, but end() is not required to be
    // called in strict LIFO order against startSpan, so search rather than assume `.pop()`.
    const stackIndex = this.stack.findIndex((s) => s.spanId === open.spanId);
    if (stackIndex !== -1) this.stack.splice(stackIndex, 1);

    const endTimeUnixNano = nowNanos();
    const finished: Span = {
      traceId: open.traceId,
      spanId: open.spanId,
      parentSpanId: open.parentSpanId,
      name: open.name,
      serviceName: this.config.serviceName,
      startTimeUnixNano: open.startTimeUnixNano,
      endTimeUnixNano,
      durationNanos: endTimeUnixNano - open.startTimeUnixNano,
      attributes: open.attributes,
      statusCode: open.statusCode,
    };
    this.buffer.push(finished);
    if (this.buffer.length >= this.batchSize) void this.flush();
  }

  /** Number of finished, not-yet-exported spans currently buffered. */
  get bufferedCount(): number {
    return this.buffer.length;
  }

  /** POSTs all buffered spans to `collectorUrl` as OTLP/JSON, clearing the buffer. Safe to call with an empty buffer (no-op). */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const spans = this.buffer.splice(0, this.buffer.length);
    const payload = buildTracesJson(spans);
    await this.exportFetch(this.config.collectorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /**
   * Wraps `globalThis.fetch` so every outgoing HTTP call automatically produces a span: name
   * `HTTP <method> <url>`, standard `http.method`/`http.url`/`http.status_code` attributes, and
   * status `error` for a non-2xx response or a thrown network error, `ok` otherwise. Calling this
   * twice is a no-op (idempotent) so app code doesn't need to guard against double-instrumenting.
   */
  instrumentFetch(): void {
    if (this.originalFetch) return;
    this.originalFetch = globalThis.fetch.bind(globalThis);
    const original = this.originalFetch;

    // An arrow function (not a `function` expression) so it closes over the enclosing method's
    // `this` lexically — no `const tracer = this` alias needed to reach `this.startSpan` from inside.
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const url = input instanceof Request ? input.url : String(input);
      const span = this.startSpan(`HTTP ${method}`, { 'http.method': method, 'http.url': url });
      try {
        const response = await original(input, init);
        span.setAttribute('http.status_code', response.status);
        span.setStatus(response.ok ? 'ok' : 'error');
        return response;
      } catch (err) {
        span.setStatus('error');
        span.setAttribute('error.message', err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        span.end();
      }
    };
  }

  /** Restores the original, un-instrumented `fetch` — mainly for test teardown. */
  uninstrumentFetch(): void {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = undefined;
    }
  }
}
