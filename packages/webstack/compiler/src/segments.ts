import type { RouteParam, RouteSegment } from './manifest-types.js';

export const LAYOUT_BASENAME = '_layout';
export const ROUTE_FILE_EXTENSIONS = ['.tsx', '.ts'];

/** Strips a recognized route-file extension from a file name, if present. */
export function stripRouteExtension(name: string): string {
  for (const ext of ROUTE_FILE_EXTENSIONS) {
    if (name.endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

/** True for file base names (no extension) that name a layout file, e.g. `_layout`. */
export function isLayoutBasename(basename: string): boolean {
  return basename === LAYOUT_BASENAME;
}

/**
 * True for file base names that should not be treated as routes or layouts at all — files
 * prefixed with `_` other than `_layout` are reserved for future framework use (co-located
 * helpers, etc.) and are silently skipped by route discovery.
 */
export function isIgnoredBasename(basename: string): boolean {
  return basename.startsWith('_') && !isLayoutBasename(basename);
}

/** Parses one path fragment (a directory name or a route file's base name) into a RouteSegment. */
export function parseSegment(fragment: string): RouteSegment {
  if (fragment.startsWith('[...') && fragment.endsWith(']')) {
    return { kind: 'catchall', param: fragment.slice(4, -1) };
  }
  if (fragment.startsWith('[') && fragment.endsWith(']')) {
    return { kind: 'dynamic', param: fragment.slice(1, -1) };
  }
  return { kind: 'static', value: fragment };
}

/**
 * Builds the URL-shaped route path and its ordered param list from a route file's path,
 * relative to the routes root, using posix separators (e.g. `users/[id].tsx`).
 *
 * `index` file names collapse: `index.tsx` at the root becomes `/`, `users/index.tsx` becomes
 * `/users`.
 */
export function buildRoutePath(relativeFilePath: string): { routePath: string; segments: RouteSegment[] } {
  const withoutExt = stripRouteExtension(relativeFilePath);
  const parts = withoutExt.split('/').filter((part) => part.length > 0);

  const last = parts[parts.length - 1];
  if (last === 'index') parts.pop();

  const segments = parts.map(parseSegment);
  const routePath = '/' + segments.map(segmentToUrlFragment).join('/');
  // Collapse the trailing '/' produced when `segments` is empty (the root `index` route).
  return { routePath: segments.length === 0 ? '/' : routePath, segments };
}

function segmentToUrlFragment(segment: RouteSegment): string {
  switch (segment.kind) {
    case 'static':
      return segment.value;
    case 'dynamic':
      return `[${segment.param}]`;
    case 'catchall':
      return `[...${segment.param}]`;
  }
}

/** Extracts the ordered list of route params from a segment list. */
export function paramsFromSegments(segments: RouteSegment[]): RouteParam[] {
  const params: RouteParam[] = [];
  for (const segment of segments) {
    if (segment.kind === 'dynamic') params.push({ name: segment.param, kind: 'dynamic' });
    else if (segment.kind === 'catchall') params.push({ name: segment.param, kind: 'catchall' });
  }
  return params;
}

/** Returns the directory portion (posix, no trailing slash, '' for root) of a relative path. */
export function dirnamePosix(relativePath: string): string {
  const idx = relativePath.lastIndexOf('/');
  return idx === -1 ? '' : relativePath.slice(0, idx);
}

/** Yields the ancestor directories of `dir` from the root ('') down to `dir` itself, inclusive. */
export function ancestorDirs(dir: string): string[] {
  if (dir === '') return [''];
  const parts = dir.split('/');
  const result: string[] = [''];
  let acc = '';
  for (const part of parts) {
    acc = acc === '' ? part : `${acc}/${part}`;
    result.push(acc);
  }
  return result;
}
