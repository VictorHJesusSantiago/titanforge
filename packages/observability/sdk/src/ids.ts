/**
 * OTLP trace/span ids are hex strings (16 bytes / 32 hex chars for a trace id, 8 bytes / 16 hex
 * chars for a span id). We generate them with `Math.random` rather than `crypto.randomUUID` /
 * `node:crypto` deliberately: this SDK has to run unmodified in both Node and the browser, and
 * `Math.random`-based hex generation is the one id-generation strategy available in both without
 * an environment branch. It is not cryptographically secure, which is a non-issue here — trace
 * ids only need to be unique enough to not collide within one process's lifetime, not
 * unguessable.
 */
function randomHex(byteLength: number): string {
  let hex = '';
  for (let i = 0; i < byteLength; i += 1) {
    hex += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return hex;
}

export function generateTraceId(): string {
  return randomHex(16);
}

export function generateSpanId(): string {
  return randomHex(8);
}
