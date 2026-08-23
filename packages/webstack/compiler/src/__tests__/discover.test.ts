import { describe, it, expect, beforeEach } from 'vitest';
import { Project } from 'ts-morph';
import { discoverRoutes } from '../discover.js';
import type { RouteManifest } from '../manifest-types.js';

let project: Project;

beforeEach(() => {
  project = new Project({ useInMemoryFileSystem: true });
});

function route(manifest: RouteManifest, routePath: string) {
  const found = manifest.routes.find((r) => r.routePath === routePath);
  if (!found) throw new Error(`no route ${routePath} in manifest: ${manifest.routes.map((r) => r.routePath).join(', ')}`);
  return found;
}

describe('discoverRoutes — static routes', () => {
  it('discovers a root index route', () => {
    project.createSourceFile('/routes/index.tsx', 'export default function Page() { return null; }');
    const manifest = discoverRoutes(project, '/routes');
    expect(manifest.routes).toHaveLength(1);
    expect(route(manifest, '/')).toMatchObject({ filePath: 'index.tsx', segments: [], params: [] });
  });

  it('discovers a nested static index route', () => {
    project.createSourceFile('/routes/users/index.tsx', 'export default function Page() { return null; }');
    const manifest = discoverRoutes(project, '/routes');
    expect(route(manifest, '/users')).toMatchObject({ filePath: 'users/index.tsx' });
  });

  it('discovers a flat static file route', () => {
    project.createSourceFile('/routes/about.tsx', 'export default function Page() { return null; }');
    const manifest = discoverRoutes(project, '/routes');
    expect(route(manifest, '/about')).toMatchObject({ filePath: 'about.tsx' });
  });

  it('discovers multiple sibling static routes', () => {
    project.createSourceFile('/routes/about.tsx', 'export default function Page() {}');
    project.createSourceFile('/routes/contact.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    expect(manifest.routes.map((r) => r.routePath).sort()).toEqual(['/about', '/contact']);
  });
});

describe('discoverRoutes — dynamic routes', () => {
  it('discovers a dynamic param route', () => {
    project.createSourceFile('/routes/users/[id].tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    const r = route(manifest, '/users/[id]');
    expect(r.params).toEqual([{ name: 'id', kind: 'dynamic' }]);
    expect(r.segments).toEqual([
      { kind: 'static', value: 'users' },
      { kind: 'dynamic', param: 'id' },
    ]);
  });

  it('discovers a dynamic index-less route alongside its static sibling', () => {
    project.createSourceFile('/routes/users/index.tsx', 'export default function Page() {}');
    project.createSourceFile('/routes/users/[id].tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    expect(manifest.routes.map((r) => r.routePath).sort()).toEqual(['/users', '/users/[id]']);
  });

  it('discovers multiple dynamic segments in one path', () => {
    project.createSourceFile('/routes/teams/[teamId]/members/[memberId].tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    const r = route(manifest, '/teams/[teamId]/members/[memberId]');
    expect(r.params).toEqual([
      { name: 'teamId', kind: 'dynamic' },
      { name: 'memberId', kind: 'dynamic' },
    ]);
  });
});

describe('discoverRoutes — catch-all routes', () => {
  it('discovers a catch-all route', () => {
    project.createSourceFile('/routes/blog/[...slug].tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    const r = route(manifest, '/blog/[...slug]');
    expect(r.params).toEqual([{ name: 'slug', kind: 'catchall' }]);
  });

  it('distinguishes a catch-all from a dynamic route at the same depth', () => {
    project.createSourceFile('/routes/docs/[...path].tsx', 'export default function Page() {}');
    project.createSourceFile('/routes/users/[id].tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    expect(route(manifest, '/docs/[...path]').params[0]!.kind).toBe('catchall');
    expect(route(manifest, '/users/[id]').params[0]!.kind).toBe('dynamic');
  });
});

describe('discoverRoutes — nested layouts', () => {
  it('applies a root layout to a root route', () => {
    project.createSourceFile('/routes/_layout.tsx', 'export default function Layout() {}');
    project.createSourceFile('/routes/index.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    expect(route(manifest, '/').layouts).toEqual(['_layout.tsx']);
  });

  it('applies a nested layout only to routes in its subtree', () => {
    project.createSourceFile('/routes/index.tsx', 'export default function Page() {}');
    project.createSourceFile('/routes/users/_layout.tsx', 'export default function Layout() {}');
    project.createSourceFile('/routes/users/index.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    expect(route(manifest, '/').layouts).toEqual([]);
    expect(route(manifest, '/users').layouts).toEqual(['users/_layout.tsx']);
  });

  it('stacks root and nested layouts, root-first', () => {
    project.createSourceFile('/routes/_layout.tsx', 'export default function Layout() {}');
    project.createSourceFile('/routes/users/_layout.tsx', 'export default function Layout() {}');
    project.createSourceFile('/routes/users/[id].tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    expect(route(manifest, '/users/[id]').layouts).toEqual(['_layout.tsx', 'users/_layout.tsx']);
  });

  it('stacks three levels of layouts in order', () => {
    project.createSourceFile('/routes/_layout.tsx', 'export default function Layout() {}');
    project.createSourceFile('/routes/teams/_layout.tsx', 'export default function Layout() {}');
    project.createSourceFile('/routes/teams/[id]/_layout.tsx', 'export default function Layout() {}');
    project.createSourceFile('/routes/teams/[id]/index.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    expect(route(manifest, '/teams/[id]').layouts).toEqual([
      '_layout.tsx',
      'teams/_layout.tsx',
      'teams/[id]/_layout.tsx',
    ]);
  });

  it('does not treat a layout file itself as a route', () => {
    project.createSourceFile('/routes/_layout.tsx', 'export default function Layout() {}');
    project.createSourceFile('/routes/index.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    expect(manifest.routes).toHaveLength(1);
  });

  it('ignores reserved underscore-prefixed non-layout files', () => {
    project.createSourceFile('/routes/_helpers.ts', 'export const x = 1;');
    project.createSourceFile('/routes/index.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    expect(manifest.routes).toHaveLength(1);
  });
});

describe('discoverRoutes — loader wiring', () => {
  it('attaches a loader descriptor for a route that exports one', () => {
    project.createSourceFile(
      '/routes/users/[id].tsx',
      'export async function loader(): Promise<{ id: string; name: string }> { return { id: "1", name: "a" }; }\nexport default function Page() {}',
    );
    const manifest = discoverRoutes(project, '/routes');
    const r = route(manifest, '/users/[id]');
    expect(r.loader).not.toBeNull();
    expect(r.loader!.shape).toEqual({
      kind: 'object',
      properties: { id: { kind: 'string' }, name: { kind: 'string' } },
    });
  });

  it('leaves loader null for a route without one', () => {
    project.createSourceFile('/routes/about.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    expect(route(manifest, '/about').loader).toBeNull();
  });

  it('two routes with differently-shaped loaders get differing manifest entries', () => {
    project.createSourceFile(
      '/routes/a.tsx',
      'export function loader(): { x: string } { return { x: "1" }; }\nexport default function Page() {}',
    );
    project.createSourceFile(
      '/routes/b.tsx',
      'export function loader(): { x: string; y: number } { return { x: "1", y: 2 }; }\nexport default function Page() {}',
    );
    const manifest = discoverRoutes(project, '/routes');
    expect(route(manifest, '/a').loader!.shape).not.toEqual(route(manifest, '/b').loader!.shape);
  });
});

describe('discoverRoutes — whole-tree assembly', () => {
  it('assembles a realistic mixed route tree matching the brief\'s example', () => {
    project.createSourceFile('/routes/index.tsx', 'export default function Page() {}');
    project.createSourceFile(
      '/routes/users/[id].tsx',
      'export async function loader(): Promise<{ id: string }> { return { id: "1" }; }\nexport default function Page() {}',
    );
    project.createSourceFile('/routes/users/index.tsx', 'export default function Page() {}');
    project.createSourceFile('/routes/blog/[...slug].tsx', 'export default function Page() {}');
    project.createSourceFile('/routes/_layout.tsx', 'export default function Layout() {}');

    const manifest = discoverRoutes(project, '/routes');
    const paths = manifest.routes.map((r) => r.routePath).sort();
    expect(paths).toEqual(['/', '/blog/[...slug]', '/users', '/users/[id]']);
    expect(manifest.routes.every((r) => r.layouts.includes('_layout.tsx'))).toBe(true);
    expect(route(manifest, '/users/[id]').loader).not.toBeNull();
  });

  it('returns routes sorted by path', () => {
    project.createSourceFile('/routes/zeta.tsx', 'export default function Page() {}');
    project.createSourceFile('/routes/alpha.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    expect(manifest.routes.map((r) => r.routePath)).toEqual(['/alpha', '/zeta']);
  });

  it('records the routes dir on the manifest', () => {
    project.createSourceFile('/routes/index.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    expect(manifest.routesDir).toBe('/routes');
  });

  it('tolerates a trailing slash on the routes dir argument', () => {
    project.createSourceFile('/routes/index.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes/');
    expect(route(manifest, '/')).toBeDefined();
  });
});
