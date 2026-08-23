import { Readable } from 'node:stream';
import type { Renderable } from './tree.js';
import { closeTag, escapeHtml, openTag } from './html.js';

/**
 * Fully-awaited SSR: recursively resolves every suspense boundary's `content()` in place and
 * returns the complete HTML string. No placeholders, no streaming — useful for tests and for
 * any caller that doesn't need a streamed response.
 */
export async function renderToString(tree: Renderable): Promise<string> {
  if (tree === null || tree === undefined || tree === false) return '';
  if (Array.isArray(tree)) return (await Promise.all(tree.map(renderToString))).join('');
  if (tree.kind === 'text') return escapeHtml(tree.text);
  if (tree.kind === 'element') {
    const childrenHtml = (await Promise.all(tree.children.map(renderToString))).join('');
    return `${openTag(tree)}${childrenHtml}${closeTag(tree)}`;
  }
  // suspense
  const resolved = await tree.content();
  return renderToString(resolved);
}

/**
 * Streaming SSR with real out-of-order suspense flushing.
 *
 * The synchronous "shell" — everything not behind a `suspense()` boundary, plus each boundary's
 * fallback wrapped in `<div id="B:n">...</div>` — is rendered and pushed to the returned
 * `Readable` immediately. Each boundary's `content()` promise is kicked off at that same moment;
 * whichever one settles first is flushed first, as a `<script>` chunk that replaces its
 * placeholder div with the resolved HTML (`document.getElementById('B:n').outerHTML = "..."`) —
 * the same out-of-order-streaming technique used by production SSR frameworks, implemented here
 * directly over Node's `Readable` rather than a browser fetch/ReadableStream. The stream ends
 * (`push(null)`) once the shell has been sent and every boundary has settled.
 *
 * Nested boundaries (a resolved boundary's content containing its own `suspense()` nodes) are
 * supported: they're assigned their own ids and streamed the same way, recursively.
 */
export function renderToStream(tree: Renderable): Readable {
  const stream = new Readable({ read() {} });

  let boundaryCounter = 0;
  let pendingBoundaries = 0;
  let shellSent = false;

  function nextBoundaryId(): string {
    boundaryCounter += 1;
    return `B:${boundaryCounter}`;
  }

  function maybeClose(): void {
    if (shellSent && pendingBoundaries === 0) stream.push(null);
  }

  function flushBoundary(id: string, html: string): void {
    const script = `<script>document.getElementById(${JSON.stringify(id)}).outerHTML=${JSON.stringify(html)};</script>`;
    stream.push(script);
  }

  function renderSync(node: Renderable): string {
    if (node === null || node === undefined || node === false) return '';
    if (Array.isArray(node)) return node.map(renderSync).join('');
    if (node.kind === 'text') return escapeHtml(node.text);
    if (node.kind === 'element') {
      const childrenHtml = node.children.map(renderSync).join('');
      return `${openTag(node)}${childrenHtml}${closeTag(node)}`;
    }

    // suspense: render the fallback synchronously into the shell, and kick off the real content.
    const id = nextBoundaryId();
    const fallbackHtml = renderSync(node.fallback);
    pendingBoundaries += 1;
    node.content().then(
      (resolved) => {
        const html = renderSync(resolved);
        flushBoundary(id, html);
        pendingBoundaries -= 1;
        maybeClose();
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        flushBoundary(id, `<!-- error: ${escapeHtml(message)} -->`);
        pendingBoundaries -= 1;
        maybeClose();
      },
    );
    return `<div id="${id}">${fallbackHtml}</div>`;
  }

  const shellHtml = renderSync(tree);
  stream.push(shellHtml);
  shellSent = true;
  maybeClose();

  return stream;
}

/** Test/consumer convenience: collects every chunk pushed to a Readable, in arrival order. */
export async function collectChunks(stream: Readable): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
  }
  return chunks;
}
