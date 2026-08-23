import { describe, it, expect } from 'vitest';
import { h, suspense, text } from '../tree.js';
import { renderToStream, collectChunks } from '../render.js';

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('renderToStream — shell', () => {
  it('pushes the synchronous shell as the very first chunk', async () => {
    const tree = h('div', null, 'static', suspense('loading', () => delay(5, text('async'))));
    const chunks = await collectChunks(renderToStream(tree));
    expect(chunks[0]).toContain('static');
    expect(chunks[0]).toContain('id="B:1"');
  });

  it('renders a tree with no suspense boundaries as a single chunk, closed immediately', async () => {
    const tree = h('div', null, 'just text');
    const chunks = await collectChunks(renderToStream(tree));
    expect(chunks).toEqual(['<div>just text</div>']);
  });

  it('embeds each boundary fallback in a placeholder div keyed by a unique id', async () => {
    const tree = h(
      'div',
      null,
      suspense('f1', () => delay(5, text('a'))),
      suspense('f2', () => delay(5, text('b'))),
    );
    const [shell] = await collectChunks(renderToStream(tree));
    expect(shell).toContain('<div id="B:1">f1</div>');
    expect(shell).toContain('<div id="B:2">f2</div>');
  });
});

describe('renderToStream — out-of-order flush', () => {
  it('flushes the faster boundary first even though it is second in tree order', async () => {
    const tree = h(
      'div',
      null,
      suspense('placeholder-one', () => delay(60, text('RESOLVED_SLOW'))), // B:1, tree-first, resolves last
      suspense('placeholder-two', () => delay(5, text('RESOLVED_FAST'))), // B:2, tree-second, resolves first
    );
    const chunks = await collectChunks(renderToStream(tree));
    const fastIdx = chunks.findIndex((c) => c.includes('B:2') && c.includes('RESOLVED_FAST'));
    const slowIdx = chunks.findIndex((c) => c.includes('B:1') && c.includes('RESOLVED_SLOW'));
    expect(fastIdx).toBeGreaterThan(0);
    expect(slowIdx).toBeGreaterThan(0);
    expect(fastIdx).toBeLessThan(slowIdx);
  });

  it('flushes three boundaries in actual resolution order, not declaration order', async () => {
    const tree = h(
      'div',
      null,
      suspense('a', () => delay(50, text('A'))),
      suspense('b', () => delay(10, text('B'))),
      suspense('c', () => delay(30, text('C'))),
    );
    const chunks = await collectChunks(renderToStream(tree));
    const order = ['B:1', 'B:2', 'B:3']
      .map((id) => chunks.findIndex((c) => c.includes(id) && c.includes('outerHTML')))
      .map((idx, i) => ({ id: ['B:1', 'B:2', 'B:3'][i], idx }))
      .sort((x, y) => x.idx - y.idx)
      .map((x) => x.id);
    // b (10ms) resolves first, then c (30ms), then a (50ms) — the reverse of declaration order.
    expect(order).toEqual(['B:2', 'B:3', 'B:1']);
  });

  it('each flush chunk replaces the correct placeholder id with the resolved HTML', async () => {
    const tree = suspense('loading', () => delay(5, h('span', null, 'resolved')));
    const chunks = await collectChunks(renderToStream(tree));
    const flush = chunks.find((c) => c.includes('outerHTML'));
    expect(flush).toContain("getElementById(\"B:1\")");
    expect(flush).toContain('<span>resolved</span>');
  });

  it('closes the stream only after every boundary has settled', async () => {
    const resolved: string[] = [];
    const tree = h(
      'div',
      null,
      suspense('a', async () => {
        await delay(20, null);
        resolved.push('a');
        return text('a');
      }),
      suspense('b', async () => {
        await delay(5, null);
        resolved.push('b');
        return text('b');
      }),
    );
    await collectChunks(renderToStream(tree));
    expect(resolved).toEqual(['b', 'a']);
  });

  it('supports a nested suspense boundary inside a resolved boundary', async () => {
    const tree = suspense('outer-loading', () =>
      delay(5, suspense('inner-loading', () => delay(5, text('deep')))),
    );
    const chunks = await collectChunks(renderToStream(tree));
    const full = chunks.join('');
    expect(full).toContain('B:1');
    expect(full).toContain('B:2');
    expect(full).toContain('deep');
  });

  it('flushes an HTML error comment and still closes the stream when a loader rejects', async () => {
    const tree = suspense('loading', () => Promise.reject(new Error('boom')));
    const chunks = await collectChunks(renderToStream(tree));
    expect(chunks.some((c) => c.includes('boom'))).toBe(true);
  });
});
