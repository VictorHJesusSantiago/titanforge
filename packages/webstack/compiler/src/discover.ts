import type { Project } from 'ts-morph';
import type { RouteEntry, RouteManifest } from './manifest-types.js';
import { extractLoader } from './loader.js';
import {
  ancestorDirs,
  buildRoutePath,
  dirnamePosix,
  isIgnoredBasename,
  isLayoutBasename,
  paramsFromSegments,
  stripRouteExtension,
} from './segments.js';

/**
 * Walks every source file `ts-morph` knows about under `routesDir` (works identically whether
 * the project is backed by the real file system or `useInMemoryFileSystem: true`, since it only
 * relies on `Project`/`Directory` APIs) and builds a `RouteManifest`: one `RouteEntry` per route
 * file, with its URL path, dynamic/catch-all params, and the `_layout` files (root-first) that
 * wrap it.
 *
 * Route files whose base name starts with `_` are skipped as routes; `_layout` files instead
 * contribute to every route in their directory and below. Files whose base name starts with `_`
 * but is not `_layout` are reserved and ignored entirely.
 */
export function discoverRoutes(project: Project, routesDir: string): RouteManifest {
  const normalizedRoot = routesDir.replace(/\/+$/, '');
  const directory = project.getDirectoryOrThrow(normalizedRoot);
  const sourceFiles = directory.getDescendantSourceFiles();

  const layoutsByDir = new Map<string, string>();
  for (const sourceFile of sourceFiles) {
    const relativePath = toRelativePosix(sourceFile.getFilePath(), normalizedRoot);
    const basename = stripRouteExtension(baseName(relativePath));
    if (isLayoutBasename(basename)) {
      layoutsByDir.set(dirnamePosix(relativePath), relativePath);
    }
  }

  const routes: RouteEntry[] = [];
  for (const sourceFile of sourceFiles) {
    const relativePath = toRelativePosix(sourceFile.getFilePath(), normalizedRoot);
    const basename = stripRouteExtension(baseName(relativePath));
    if (isLayoutBasename(basename) || isIgnoredBasename(basename)) continue;

    const { routePath, segments } = buildRoutePath(relativePath);
    const dir = dirnamePosix(relativePath);
    const layouts = ancestorDirs(dir)
      .map((ancestor) => layoutsByDir.get(ancestor))
      .filter((path): path is string => path !== undefined);

    routes.push({
      routePath,
      filePath: relativePath,
      segments,
      params: paramsFromSegments(segments),
      layouts,
      loader: extractLoader(sourceFile),
    });
  }

  routes.sort((a, b) => a.routePath.localeCompare(b.routePath));

  return { routesDir: normalizedRoot, routes };
}

function baseName(relativePath: string): string {
  const idx = relativePath.lastIndexOf('/');
  return idx === -1 ? relativePath : relativePath.slice(idx + 1);
}

function toRelativePosix(absolutePath: string, root: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  const rootNormalized = root.replace(/\\/g, '/');
  const withoutRoot = normalized.startsWith(rootNormalized) ? normalized.slice(rootNormalized.length) : normalized;
  return withoutRoot.replace(/^\/+/, '');
}
