/**
 * The runtime's component model, deliberately scoped smaller than React Server Components: a
 * "component" here is just a plain (possibly async) function `(props) => Renderable`. There is
 * no virtual-DOM component node, no reconciliation, and no fiber tree — a component is called
 * directly by whoever is building the tree, and its result (or its `Promise`, wrapped in
 * `suspense()`) becomes part of the tree. This is an honest, smaller scope than RSC: no
 * server/client component boundary, no serialization protocol for component references, just
 * "run a function, get a tree, stream the async parts."
 */

export type Renderable = ElementNode | TextNode | SuspenseNode | Renderable[] | null | undefined | false;

export type Child = Renderable | string | number;

export interface ElementNode {
  kind: 'element';
  tag: string;
  props: Record<string, unknown>;
  children: Renderable[];
}

export interface TextNode {
  kind: 'text';
  text: string;
}

/**
 * Marks a subtree whose content is not yet available. `fallback` renders immediately (in the
 * synchronous shell); `content()` is invoked once, and its resolution — whenever it happens,
 * relative to sibling/other boundaries — drives an out-of-order stream flush. See `render.ts`.
 */
export interface SuspenseNode {
  kind: 'suspense';
  fallback: Renderable;
  content: () => Promise<Renderable>;
}

/** Hyperscript tree builder: `h('div', { id: 'a' }, 'hello', h('span', null, 'world'))`. */
export function h(tag: string, props?: Record<string, unknown> | null, ...children: Child[]): ElementNode {
  return { kind: 'element', tag, props: props ?? {}, children: children.map(normalizeChild) };
}

/** Wraps deferred async content behind a fallback, forming a streaming suspense boundary. */
export function suspense(fallback: Child, content: () => Promise<Renderable>): SuspenseNode {
  return { kind: 'suspense', fallback: normalizeChild(fallback), content };
}

export function text(value: string): TextNode {
  return { kind: 'text', text: value };
}

function normalizeChild(child: Child): Renderable {
  if (typeof child === 'string' || typeof child === 'number') return { kind: 'text', text: String(child) };
  return child;
}
