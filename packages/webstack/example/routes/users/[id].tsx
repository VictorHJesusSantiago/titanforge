import { h, suspense, text, type Renderable } from '@titanforge/runtime';

export interface UserParams {
  id: string;
}

export interface UserDetail {
  id: string;
  name: string;
  bio: string;
}

/** `/users/[id]` — a dynamic route; the compiler generates a `{ id: string }` param type for it. */
export async function loader(params: UserParams): Promise<UserDetail> {
  return { id: params.id, name: `User ${params.id}`, bio: 'Loaded server-side before render.' };
}

/**
 * Demonstrates a streaming suspense boundary: the user's core profile renders in the shell
 * immediately, while a slower "comments" subtree streams in afterward, out of order relative to
 * any other boundaries on the page, once its own data resolves.
 */
export default function UserDetailPage(data: UserDetail): Renderable {
  return h(
    'article',
    null,
    h('h2', null, data.name),
    h('p', null, data.bio),
    suspense(h('p', { className: 'loading' }, 'Loading comments…'), async () => {
      const comments = await fetchComments(data.id);
      return h(
        'ul',
        { className: 'comments' },
        comments.map((comment) => h('li', null, text(comment))),
      );
    }),
  );
}

async function fetchComments(userId: string): Promise<string[]> {
  return [`First comment on user ${userId}`, `Second comment on user ${userId}`];
}
