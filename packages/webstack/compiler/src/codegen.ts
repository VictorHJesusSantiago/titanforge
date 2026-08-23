import { VariableDeclarationKind, type Project, type SourceFile } from 'ts-morph';
import type { RouteEntry, RouteManifest } from './manifest-types.js';

/**
 * Generates a typed router module from a `RouteManifest`, using `ts-morph`'s structural
 * source-file APIs (`addInterface`, `addTypeAlias`, `addVariableStatement`, `addFunction`) — not
 * string templating. The result is a real `SourceFile` in `project`; call `.getFullText()` or
 * `.saveSync()` on it to materialize the output.
 *
 * The generated module exports:
 *  - `RouteParams`, an interface mapping each literal route path to its param object type
 *    (inferred from the path's `[id]`/`[...slug]` syntax), so consumers get autocomplete and
 *    type errors for the wrong param shape.
 *  - `RoutePath`, `keyof RouteParams`.
 *  - `routes`, a `const` manifest object keyed by route path.
 *  - for every route with a `loader`, `use<RouteName>Data()`, a typed accessor whose return type
 *    is the loader's *actual* checker-derived return type text — reproduced verbatim from
 *    `LoaderDescriptor.returnTypeText`, never hand re-declared, so a change to the loader's
 *    return shape changes this generated type too.
 */
export function generateRouterSource(project: Project, manifest: RouteManifest, outputPath: string): SourceFile {
  const file = project.createSourceFile(outputPath, '', { overwrite: true });

  const routeParamsInterface = file.addInterface({ name: 'RouteParams', isExported: true });
  for (const route of manifest.routes) {
    routeParamsInterface.addProperty({
      name: quote(route.routePath),
      type: paramsTypeText(route),
    });
  }

  file.addTypeAlias({ name: 'RoutePath', isExported: true, type: 'keyof RouteParams' });

  file.addInterface({
    name: 'RouteEntryMeta',
    isExported: true,
    properties: [
      { name: 'path', type: 'string' },
      { name: 'file', type: 'string' },
      { name: 'layouts', type: 'readonly string[]' },
      { name: 'hasLoader', type: 'boolean' },
    ],
  });

  file.addVariableStatement({
    isExported: true,
    declarationKind: VariableDeclarationKind.Const,
    declarations: [
      {
        name: 'routes',
        initializer: routesObjectLiteral(manifest.routes),
      },
    ],
  });

  file.addStatements(`export type RouteTable = typeof routes;`);

  file.addFunction({
    name: 'getLoaderData',
    isExported: true,
    typeParameters: [{ name: 'T' }],
    parameters: [{ name: '_routePath', type: 'RoutePath' }],
    returnType: 'T',
    statements: [
      '// Bridged to the runtime\'s loader-data cache at render time; see @titanforge/runtime.',
      'throw new Error(\'getLoaderData() called outside of a rendered route\');',
    ],
  });

  for (const route of manifest.routes) {
    if (!route.loader) continue;
    const name = routeIdentifier(route.routePath);
    file.addFunction({
      name: `use${name}Data`,
      isExported: true,
      returnType: route.loader.returnTypeText,
      statements: [`return getLoaderData<${route.loader.returnTypeText}>(${quote(route.routePath)});`],
    });
  }

  return file;
}

function paramsTypeText(route: RouteEntry): string {
  if (route.params.length === 0) return 'Record<string, never>';
  const fields = route.params
    .map((param) => `${identifierOrQuoted(param.name)}: ${param.kind === 'catchall' ? 'string[]' : 'string'}`)
    .join('; ');
  return `{ ${fields} }`;
}

function routesObjectLiteral(routes: RouteEntry[]): string {
  const entries = routes.map((route) => {
    const layouts = route.layouts.map(quote).join(', ');
    return `  ${quote(route.routePath)}: { path: ${quote(route.routePath)}, file: ${quote(route.filePath)}, layouts: [${layouts}] as const, hasLoader: ${route.loader !== null} }`;
  });
  return `{\n${entries.join(',\n')}\n} as const`;
}

/** Turns a route path like `/users/[id]` into a PascalCase identifier fragment: `UsersId`. */
export function routeIdentifier(routePath: string): string {
  if (routePath === '/') return 'Root';
  const parts = routePath.split('/').filter((part) => part.length > 0);
  return parts
    .map((part) => {
      const cleaned = part.replace(/^\[\.\.\.(.+)\]$/, '$1').replace(/^\[(.+)\]$/, '$1');
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    })
    .join('');
}

function identifierOrQuoted(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
