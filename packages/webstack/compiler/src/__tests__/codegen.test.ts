import { describe, it, expect, beforeEach } from 'vitest';
import { Project } from 'ts-morph';
import { discoverRoutes } from '../discover.js';
import { generateRouterSource, routeIdentifier } from '../codegen.js';

let project: Project;

beforeEach(() => {
  project = new Project({ useInMemoryFileSystem: true });
});

describe('routeIdentifier', () => {
  it('maps root to Root', () => {
    expect(routeIdentifier('/')).toBe('Root');
  });

  it('maps a static path to PascalCase', () => {
    expect(routeIdentifier('/users')).toBe('Users');
  });

  it('strips brackets from dynamic segments', () => {
    expect(routeIdentifier('/users/[id]')).toBe('UsersId');
  });

  it('strips the ... prefix from catch-all segments', () => {
    expect(routeIdentifier('/blog/[...slug]')).toBe('BlogSlug');
  });
});

describe('generateRouterSource', () => {
  it('emits a RouteParams interface entry per route', () => {
    project.createSourceFile('/routes/index.tsx', 'export default function Page() {}');
    project.createSourceFile('/routes/users/[id].tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');

    const out = generateRouterSource(project, manifest, '/out/router.ts');
    const iface = out.getInterfaceOrThrow('RouteParams');
    expect(iface.getProperty("'/'")).toBeDefined();
    expect(iface.getProperty("'/users/[id]'")).toBeDefined();
  });

  it('gives a static route an empty params type', () => {
    project.createSourceFile('/routes/about.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    const out = generateRouterSource(project, manifest, '/out/router.ts');
    const prop = out.getInterfaceOrThrow('RouteParams').getPropertyOrThrow("'/about'");
    expect(prop.getTypeNode()?.getText()).toBe('Record<string, never>');
  });

  it('gives a dynamic route a params type with a string field named after the param', () => {
    project.createSourceFile('/routes/users/[id].tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    const out = generateRouterSource(project, manifest, '/out/router.ts');
    const prop = out.getInterfaceOrThrow('RouteParams').getPropertyOrThrow("'/users/[id]'");
    expect(prop.getTypeNode()?.getText()).toBe('{ id: string }');
  });

  it('gives a catch-all route a params type with a string[] field', () => {
    project.createSourceFile('/routes/blog/[...slug].tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    const out = generateRouterSource(project, manifest, '/out/router.ts');
    const prop = out.getInterfaceOrThrow('RouteParams').getPropertyOrThrow("'/blog/[...slug]'");
    expect(prop.getTypeNode()?.getText()).toBe('{ slug: string[] }');
  });

  it('emits a RoutePath alias equal to keyof RouteParams', () => {
    project.createSourceFile('/routes/index.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    const out = generateRouterSource(project, manifest, '/out/router.ts');
    expect(out.getTypeAliasOrThrow('RoutePath').getTypeNode()?.getText()).toBe('keyof RouteParams');
  });

  it('emits a routes const with an entry per route', () => {
    project.createSourceFile('/routes/index.tsx', 'export default function Page() {}');
    project.createSourceFile('/routes/about.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    const out = generateRouterSource(project, manifest, '/out/router.ts');
    const text = out.getVariableStatementOrThrow('routes').getText();
    expect(text).toContain("'/'");
    expect(text).toContain("'/about'");
    expect(text).toContain('as const');
  });

  it('marks hasLoader true only for routes with a loader', () => {
    project.createSourceFile(
      '/routes/a.tsx',
      'export function loader(): { x: string } { return { x: "1"}; }\nexport default function Page() {}',
    );
    project.createSourceFile('/routes/b.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    const out = generateRouterSource(project, manifest, '/out/router.ts');
    const text = out.getVariableStatementOrThrow('routes').getText();
    expect(text).toMatch(/'\/a':[^}]*hasLoader: true/s);
    expect(text).toMatch(/'\/b':[^}]*hasLoader: false/s);
  });

  it('generates a typed data accessor for a route with a loader', () => {
    project.createSourceFile(
      '/routes/users/[id].tsx',
      'export async function loader(): Promise<{ id: string; name: string }> { return { id: "1", name: "a" }; }\nexport default function Page() {}',
    );
    const manifest = discoverRoutes(project, '/routes');
    const out = generateRouterSource(project, manifest, '/out/router.ts');
    const fn = out.getFunctionOrThrow('useUsersIdData');
    expect(fn.isExported()).toBe(true);
    expect(fn.getReturnTypeNode()?.getText()).toBe('{ id: string; name: string; }');
  });

  it('does not generate a data accessor for a route without a loader', () => {
    project.createSourceFile('/routes/about.tsx', 'export default function Page() {}');
    const manifest = discoverRoutes(project, '/routes');
    const out = generateRouterSource(project, manifest, '/out/router.ts');
    expect(out.getFunction('useAboutData')).toBeUndefined();
  });

  it('changing the loader return shape changes the generated accessor return type', () => {
    project.createSourceFile(
      '/routes/a.tsx',
      'export function loader(): { title: string } { return { title: "x" }; }\nexport default function Page() {}',
    );
    const manifestBefore = discoverRoutes(project, '/routes');
    const outBefore = generateRouterSource(project, manifestBefore, '/out/before.ts');
    const before = outBefore.getFunctionOrThrow('useAData').getReturnTypeNode()?.getText();

    const project2 = new Project({ useInMemoryFileSystem: true });
    project2.createSourceFile(
      '/routes/a.tsx',
      'export function loader(): { title: string; views: number } { return { title: "x", views: 1 }; }\nexport default function Page() {}',
    );
    const manifestAfter = discoverRoutes(project2, '/routes');
    const outAfter = generateRouterSource(project2, manifestAfter, '/out/after.ts');
    const after = outAfter.getFunctionOrThrow('useAData').getReturnTypeNode()?.getText();

    expect(before).not.toBe(after);
    expect(after).toContain('views');
  });

  it('the generated source file type-checks with no diagnostics', () => {
    project.createSourceFile('/routes/index.tsx', 'export default function Page() {}');
    project.createSourceFile('/routes/users/[id].tsx', 'export default function Page() {}');
    project.createSourceFile('/routes/blog/[...slug].tsx', 'export default function Page() {}');
    project.createSourceFile(
      '/routes/users/index.tsx',
      'export function loader(): { total: number } { return { total: 3 }; }\nexport default function Page() {}',
    );
    const manifest = discoverRoutes(project, '/routes');
    const out = generateRouterSource(project, manifest, '/out/router.ts');
    const diagnostics = out.getPreEmitDiagnostics();
    expect(diagnostics.map((d) => d.getMessageText())).toEqual([]);
  });
});
