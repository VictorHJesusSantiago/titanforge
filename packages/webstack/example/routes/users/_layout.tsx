import { h, type Renderable } from '@titanforge/runtime';

/** Layout applied to every `/users/*` route, nested inside the root layout. */
export default function UsersLayout(children: Renderable): Renderable {
  return h('section', { className: 'users-section' }, h('nav', null, h('a', { href: '/users' }, 'All users')), children);
}
