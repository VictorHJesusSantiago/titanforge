import { describe, it, expect } from 'vitest';
import { h, suspense, text } from '../tree.js';

describe('h', () => {
  it('builds an element with no props and no children', () => {
    expect(h('div')).toEqual({ kind: 'element', tag: 'div', props: {}, children: [] });
  });

  it('builds an element with props', () => {
    expect(h('a', { href: '/x' })).toEqual({ kind: 'element', tag: 'a', props: { href: '/x' }, children: [] });
  });

  it('normalizes string children into text nodes', () => {
    expect(h('p', null, 'hello')).toEqual({
      kind: 'element',
      tag: 'p',
      props: {},
      children: [{ kind: 'text', text: 'hello' }],
    });
  });

  it('normalizes number children into text nodes', () => {
    expect(h('span', null, 42)).toEqual({
      kind: 'element',
      tag: 'span',
      props: {},
      children: [{ kind: 'text', text: '42' }],
    });
  });

  it('nests elements', () => {
    const tree = h('div', null, h('span', null, 'inner'));
    expect(tree.children[0]).toMatchObject({ kind: 'element', tag: 'span' });
  });

  it('accepts an array of children as one child slot', () => {
    const items = [h('li', null, 'a'), h('li', null, 'b')];
    const tree = h('ul', null, items);
    expect(tree.children).toEqual([items]);
  });

  it('treats null props as empty props', () => {
    expect(h('div', null).props).toEqual({});
  });
});

describe('text', () => {
  it('builds a text node', () => {
    expect(text('hi')).toEqual({ kind: 'text', text: 'hi' });
  });
});

describe('suspense', () => {
  it('normalizes a string fallback into a text node', () => {
    const node = suspense('loading...', async () => text('done'));
    expect(node.fallback).toEqual({ kind: 'text', text: 'loading...' });
    expect(node.kind).toBe('suspense');
  });

  it('accepts an element fallback unchanged', () => {
    const fallback = h('span', null, 'loading');
    const node = suspense(fallback, async () => text('done'));
    expect(node.fallback).toBe(fallback);
  });
});
