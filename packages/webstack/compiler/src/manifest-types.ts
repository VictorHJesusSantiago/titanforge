import type { TypeShape } from './type-shape.js';

/** One segment of a route path, as parsed from a file-system path fragment. */
export type RouteSegment =
  | { kind: 'static'; value: string }
  | { kind: 'dynamic'; param: string }
  | { kind: 'catchall'; param: string };

/** A route parameter derived from a `[name]` or `[...name]` path segment. */
export interface RouteParam {
  name: string;
  kind: 'dynamic' | 'catchall';
}

/** Structural description of a route file's exported `loader` function, if any. */
export interface LoaderDescriptor {
  /** The loader's return type, unwrapped from `Promise<T>` if async, as printed source text. */
  returnTypeText: string;
  /** JSON-serializable structural summary of the (unwrapped) return type. */
  shape: TypeShape;
}

/** A single discovered route: one route file plus everything derived from it and its ancestry. */
export interface RouteEntry {
  /** URL-shaped route path, e.g. `/users/[id]` or `/blog/[...slug]`. */
  routePath: string;
  /** Path of the route file, relative to the routes root, posix-separated (e.g. `users/[id].tsx`). */
  filePath: string;
  segments: RouteSegment[];
  params: RouteParam[];
  /** `_layout` files applying to this route, root-first, as paths relative to the routes root. */
  layouts: string[];
  loader: LoaderDescriptor | null;
}

/** The full set of routes discovered under a routes directory. */
export interface RouteManifest {
  routesDir: string;
  routes: RouteEntry[];
}
