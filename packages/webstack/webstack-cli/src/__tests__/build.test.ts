import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from '../build.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoutesDir = join(here, '../../../example/routes');

describe('build (integration: real example app on the real file system)', () => {
  it('discovers exactly the routes implied by the example app\'s file tree', async () => {
    const { manifest } = await build({
      routesDir: exampleRoutesDir,
      outFile: join(here, '../../../example/.generated/router.ts'),
      write: false,
    });

    const paths = manifest.routes.map((r) => r.routePath).sort();
    expect(paths).toEqual(['/', '/blog/[...slug]', '/users', '/users/[id]']);
  });

  it('attaches the users list loader to /users', async () => {
    const { manifest } = await build({
      routesDir: exampleRoutesDir,
      outFile: join(here, '../../../example/.generated/router.ts'),
      write: false,
    });
    const usersRoute = manifest.routes.find((r) => r.routePath === '/users');
    expect(usersRoute?.loader).not.toBeNull();
    expect(usersRoute?.loader?.shape).toMatchObject({ kind: 'object', properties: { users: { kind: 'array' } } });
  });

  it('attaches the user-detail loader with a params-derived id field to /users/[id]', async () => {
    const { manifest } = await build({
      routesDir: exampleRoutesDir,
      outFile: join(here, '../../../example/.generated/router.ts'),
      write: false,
    });
    const userRoute = manifest.routes.find((r) => r.routePath === '/users/[id]');
    expect(userRoute?.params).toEqual([{ name: 'id', kind: 'dynamic' }]);
    expect(userRoute?.loader).not.toBeNull();
  });

  it('stacks the root and users layouts on nested user routes', async () => {
    const { manifest } = await build({
      routesDir: exampleRoutesDir,
      outFile: join(here, '../../../example/.generated/router.ts'),
      write: false,
    });
    const userRoute = manifest.routes.find((r) => r.routePath === '/users/[id]');
    expect(userRoute?.layouts).toEqual(['_layout.tsx', 'users/_layout.tsx']);
  });

  it('gives the catch-all blog route a string[] slug param', async () => {
    const { manifest } = await build({
      routesDir: exampleRoutesDir,
      outFile: join(here, '../../../example/.generated/router.ts'),
      write: false,
    });
    const blogRoute = manifest.routes.find((r) => r.routePath === '/blog/[...slug]');
    expect(blogRoute?.params).toEqual([{ name: 'slug', kind: 'catchall' }]);
  });

  it('generates a router module containing every discovered route path', async () => {
    const { generatedSource } = await build({
      routesDir: exampleRoutesDir,
      outFile: join(here, '../../../example/.generated/router.ts'),
      write: false,
    });
    expect(generatedSource).toContain("'/'");
    expect(generatedSource).toContain("'/users'");
    expect(generatedSource).toContain("'/users/[id]'");
    expect(generatedSource).toContain("'/blog/[...slug]'");
  });

  it('runs registered plugins over the real discovered manifest', async () => {
    const seenRoutePaths: string[] = [];
    const { manifest } = await build({
      routesDir: exampleRoutesDir,
      outFile: join(here, '../../../example/.generated/router.ts'),
      write: false,
      plugins: [
        {
          name: 'observer',
          onRouteDiscovered(route) {
            seenRoutePaths.push(route.routePath);
            return undefined;
          },
        },
      ],
    });
    expect(seenRoutePaths.sort()).toEqual(manifest.routes.map((r) => r.routePath).sort());
  });
});
