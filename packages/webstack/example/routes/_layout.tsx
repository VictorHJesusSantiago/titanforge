import { h, type Renderable } from '@titanforge/runtime';

/** Root layout: wraps every route in the app in a shared `<html>` shell. */
export default function RootLayout(children: Renderable): Renderable {
  return h(
    'html',
    { lang: 'en' },
    h('head', null, h('title', null, 'Titanforge Example')),
    h('body', null, children),
  );
}
