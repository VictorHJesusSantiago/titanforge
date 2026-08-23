import { describe, it, expect } from 'vitest';
import type { RouteEntry, RouteManifest } from '@titanforge/compiler';
import type { Plugin } from '../plugin.js';
import { PluginRunner, applyPlugins } from '../runner.js';

function makeRoute(routePath: string, overrides: Partial<RouteEntry> = {}): RouteEntry {
  return {
    routePath,
    filePath: `${routePath.replace(/^\//, '') || 'index'}.tsx`,
    segments: [],
    params: [],
    layouts: [],
    loader: null,
    ...overrides,
  };
}

function makeManifest(routes: RouteEntry[]): RouteManifest {
  return { routesDir: '/routes', routes };
}

describe('PluginRunner.applyRouteDiscovery', () => {
  it('leaves the manifest unchanged with no plugins', async () => {
    const manifest = makeManifest([makeRoute('/'), makeRoute('/about')]);
    const out = await new PluginRunner([]).applyRouteDiscovery(manifest);
    expect(out).toEqual(manifest);
  });

  it('a plugin can observably mutate a route (inject an extra layout)', async () => {
    const plugin: Plugin = {
      name: 'add-layout',
      onRouteDiscovered(route) {
        return { ...route, layouts: [...route.layouts, 'injected/_layout.tsx'] };
      },
    };
    const manifest = makeManifest([makeRoute('/')]);
    const out = await new PluginRunner([plugin]).applyRouteDiscovery(manifest);
    expect(out.routes[0]!.layouts).toEqual(['injected/_layout.tsx']);
  });

  it('a plugin can drop a route by returning null', async () => {
    const plugin: Plugin = {
      name: 'hide-admin',
      onRouteDiscovered(route) {
        return route.routePath === '/admin' ? null : undefined;
      },
    };
    const manifest = makeManifest([makeRoute('/'), makeRoute('/admin')]);
    const out = await new PluginRunner([plugin]).applyRouteDiscovery(manifest);
    expect(out.routes.map((r) => r.routePath)).toEqual(['/']);
  });

  it('a plugin can inject a new route entirely via onManifestReady', async () => {
    const plugin: Plugin = {
      name: 'sitemap',
      onManifestReady(_manifest) {
        return [makeRoute('/sitemap.xml', { filePath: '__generated__/sitemap.xml.tsx' })];
      },
    };
    const manifest = makeManifest([makeRoute('/')]);
    const out = await applyPlugins([plugin], manifest);
    expect(out.routes.map((r) => r.routePath).sort()).toEqual(['/', '/sitemap.xml']);
  });

  it('runs multiple plugins in registration order, each seeing the previous one\'s mutation', async () => {
    const seen: string[][] = [];
    const pluginA: Plugin = {
      name: 'a',
      onRouteDiscovered(route) {
        seen.push([...route.layouts]);
        return { ...route, layouts: [...route.layouts, 'a'] };
      },
    };
    const pluginB: Plugin = {
      name: 'b',
      onRouteDiscovered(route) {
        seen.push([...route.layouts]);
        return { ...route, layouts: [...route.layouts, 'b'] };
      },
    };
    const manifest = makeManifest([makeRoute('/')]);
    const out = await new PluginRunner([pluginA, pluginB]).applyRouteDiscovery(manifest);
    expect(seen).toEqual([[], ['a']]);
    expect(out.routes[0]!.layouts).toEqual(['a', 'b']);
  });

  it('a plugin returning undefined leaves the route unchanged', async () => {
    const plugin: Plugin = { name: 'noop', onRouteDiscovered: () => undefined };
    const route = makeRoute('/');
    const manifest = makeManifest([route]);
    const out = await new PluginRunner([plugin]).applyRouteDiscovery(manifest);
    expect(out.routes[0]).toEqual(route);
  });

  it('supports async hooks', async () => {
    const plugin: Plugin = {
      name: 'async',
      async onRouteDiscovered(route) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { ...route, layouts: ['async-layout'] };
      },
    };
    const manifest = makeManifest([makeRoute('/')]);
    const out = await new PluginRunner([plugin]).applyRouteDiscovery(manifest);
    expect(out.routes[0]!.layouts).toEqual(['async-layout']);
  });
});

describe('PluginRunner.transformComponent', () => {
  it('returns the source unchanged with no transforming plugins', async () => {
    const runner = new PluginRunner([{ name: 'noop' }]);
    expect(await runner.transformComponent('const x = 1;', { filePath: 'a.tsx' })).toBe('const x = 1;');
  });

  it('a plugin can observably transform a component\'s source', async () => {
    const plugin: Plugin = {
      name: 'banner',
      transformComponent(source) {
        return `// generated\n${source}`;
      },
    };
    const runner = new PluginRunner([plugin]);
    const out = await runner.transformComponent('const x = 1;', { filePath: 'a.tsx' });
    expect(out).toBe('// generated\nconst x = 1;');
  });

  it('chains multiple transformComponent hooks in order', async () => {
    const plugins: Plugin[] = [
      { name: 'p1', transformComponent: (s) => `${s}-p1` },
      { name: 'p2', transformComponent: (s) => `${s}-p2` },
    ];
    const out = await new PluginRunner(plugins).transformComponent('src', { filePath: 'a.tsx' });
    expect(out).toBe('src-p1-p2');
  });

  it('passes the file path through the transform context', async () => {
    const seenPaths: string[] = [];
    const plugin: Plugin = {
      name: 'observer',
      transformComponent(source, context) {
        seenPaths.push(context.filePath);
        return undefined;
      },
    };
    await new PluginRunner([plugin]).transformComponent('src', { filePath: 'users/[id].tsx' });
    expect(seenPaths).toEqual(['users/[id].tsx']);
  });
});

describe('PluginRunner.notifyBuildComplete', () => {
  it('calls onBuildComplete with the final manifest', async () => {
    const received: RouteManifest[] = [];
    const plugin: Plugin = { name: 'observer', onBuildComplete: (m) => void received.push(m) };
    const manifest = makeManifest([makeRoute('/')]);
    await new PluginRunner([plugin]).notifyBuildComplete(manifest);
    expect(received).toEqual([manifest]);
  });

  it('calls onBuildComplete on multiple plugins in order', async () => {
    const order: string[] = [];
    const plugins: Plugin[] = [
      { name: 'a', onBuildComplete: () => void order.push('a') },
      { name: 'b', onBuildComplete: () => void order.push('b') },
    ];
    await new PluginRunner(plugins).notifyBuildComplete(makeManifest([]));
    expect(order).toEqual(['a', 'b']);
  });

  it('does nothing for plugins without onBuildComplete', async () => {
    await expect(new PluginRunner([{ name: 'noop' }]).notifyBuildComplete(makeManifest([]))).resolves.toBeUndefined();
  });
});
