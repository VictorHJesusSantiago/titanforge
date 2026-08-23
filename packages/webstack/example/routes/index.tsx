import { h, type Renderable } from '@titanforge/runtime';

/** `/` — a static route with no loader. */
export default function HomePage(): Renderable {
  return h('main', null, h('h1', null, 'Welcome to Titanforge'), h('p', null, 'A file-based-routing example app.'));
}
