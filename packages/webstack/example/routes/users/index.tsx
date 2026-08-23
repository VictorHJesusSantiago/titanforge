import { h, type Renderable } from '@titanforge/runtime';

export interface UserSummary {
  id: string;
  name: string;
}

export interface UsersListData {
  users: UserSummary[];
}

/**
 * `/users` — a static route with a `loader`. The compiler extracts this return type (via
 * `@titanforge/compiler`'s type checker analysis) and generates a typed `useUsersData()` client
 * accessor whose return type matches this exactly.
 */
export async function loader(): Promise<UsersListData> {
  return {
    users: [
      { id: '1', name: 'Ada Lovelace' },
      { id: '2', name: 'Grace Hopper' },
    ],
  };
}

export default function UsersIndexPage(data: UsersListData): Renderable {
  return h(
    'ul',
    null,
    data.users.map((user) => h('li', null, h('a', { href: `/users/${user.id}` }, user.name))),
  );
}
