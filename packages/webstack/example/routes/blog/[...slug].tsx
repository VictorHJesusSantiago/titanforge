import { h, type Renderable } from '@titanforge/runtime';

export interface BlogParams {
  slug: string[];
}

/** `/blog/[...slug]` — a catch-all route; the compiler generates a `{ slug: string[] }` param type. */
export default function BlogCatchAllPage(): Renderable {
  return h('article', null, h('p', null, 'Blog post.'));
}
