import { describe, it, expect } from 'vitest';
import { h, suspense, text } from '../tree.js';
import { renderToString } from '../render.js';

describe('renderToString', () => {
  it('renders a plain element', async () => {
    expect(await renderToString(h('div', null, 'hello'))).toBe('<div>hello</div>');
  });

  it('renders nested elements', async () => {
    expect(await renderToString(h('div', null, h('span', null, 'x')))).toBe('<div><span>x</span></div>');
  });

  it('renders attributes', async () => {
    expect(await renderToString(h('a', { href: '/x', 'data-id': 1 }))).toBe('<a href="/x" data-id="1"></a>');
  });

  it('maps className to class', async () => {
    expect(await renderToString(h('div', { className: 'card' }))).toBe('<div class="card"></div>');
  });

  it('renders boolean-true attributes without a value', async () => {
    expect(await renderToString(h('input', { disabled: true }))).toBe('<input disabled/>');
  });

  it('omits false/null/undefined attributes', async () => {
    expect(await renderToString(h('div', { hidden: false, title: null, id: undefined }))).toBe('<div></div>');
  });

  it('escapes text content', async () => {
    expect(await renderToString(text('<script>alert(1)</script>'))).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('escapes attribute values', async () => {
    expect(await renderToString(h('div', { title: '"quoted"' }))).toBe('<div title="&quot;quoted&quot;"></div>');
  });

  it('renders void tags self-closed with no children', async () => {
    expect(await renderToString(h('br'))).toBe('<br/>');
  });

  it('renders null/false/undefined as empty string', async () => {
    expect(await renderToString(null)).toBe('');
    expect(await renderToString(false)).toBe('');
    expect(await renderToString(undefined)).toBe('');
  });

  it('renders an array of nodes concatenated', async () => {
    expect(await renderToString([text('a'), text('b')])).toBe('ab');
  });

  it('fully resolves a suspense boundary in place, with no placeholder markup', async () => {
    const tree = h('div', null, suspense('loading', async () => text('loaded')));
    expect(await renderToString(tree)).toBe('<div>loaded</div>');
  });

  it('resolves nested suspense boundaries', async () => {
    const tree = suspense('l1', async () => suspense('l2', async () => text('deep')));
    expect(await renderToString(tree)).toBe('deep');
  });

  it('renders a realistic component tree', async () => {
    const Header = () => h('header', null, h('h1', null, 'Title'));
    const tree = h('div', { className: 'page' }, Header(), h('main', null, 'body'));
    expect(await renderToString(tree)).toBe(
      '<div class="page"><header><h1>Title</h1></header><main>body</main></div>',
    );
  });
});
