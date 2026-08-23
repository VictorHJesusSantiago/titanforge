import { describe, it, expect } from 'vitest';
import { h, text } from '../tree.js';
import { renderToString } from '../render.js';
import { renderRouteWithLoader } from '../loader.js';

interface UserParams {
  id: string;
}

interface UserData {
  id: string;
  name: string;
}

describe('renderRouteWithLoader', () => {
  it('runs the loader with params and passes its resolved data to the component', async () => {
    const loader = async (params: UserParams): Promise<UserData> => ({ id: params.id, name: `User ${params.id}` });
    const seenData: UserData[] = [];
    const component = (data: UserData) => {
      seenData.push(data);
      return h('div', null, data.name);
    };

    const tree = await renderRouteWithLoader(loader, { id: '42' }, component);

    expect(seenData).toEqual([{ id: '42', name: 'User 42' }]);
    expect(await renderToString(tree)).toBe('<div>User 42</div>');
  });

  it('supports a synchronous (non-async) loader', async () => {
    const loader = (params: UserParams): UserData => ({ id: params.id, name: 'sync' });
    const tree = await renderRouteWithLoader(loader, { id: '1' }, (d) => text(d.name));
    expect(await renderToString(tree)).toBe('sync');
  });

  it('supports an async page component that itself awaits further data', async () => {
    const loader = async () => ({ id: '1', name: 'x' }) satisfies UserData;
    const component = async (data: UserData) => {
      await Promise.resolve();
      return h('span', null, data.id);
    };
    const tree = await renderRouteWithLoader(loader, {}, component);
    expect(await renderToString(tree)).toBe('<span>1</span>');
  });

  it('propagates a loader rejection to the caller', async () => {
    const loader = async (): Promise<UserData> => {
      throw new Error('not found');
    };
    await expect(renderRouteWithLoader(loader, {}, (d) => text(d.name))).rejects.toThrow('not found');
  });
});
