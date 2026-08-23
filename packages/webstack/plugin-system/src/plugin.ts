import type { RouteEntry, RouteManifest } from '@titanforge/compiler';

/**
 * A real, small plugin API over the webstack pipeline. Every hook is optional; a plugin
 * implements only the ones it cares about. Hooks are synchronous-or-async (the runner always
 * awaits them), and mutate-in-place semantics are explicit per hook — see each hook's doc.
 */
export interface Plugin {
  name: string;

  /**
   * Called once per route discovered by `@titanforge/compiler`'s `discoverRoutes`, in manifest
   * order. Return a `RouteEntry` to replace the route being visited (e.g. to inject an extra
   * layout), or `undefined`/the same entry to leave it unchanged. Returning `null` removes the
   * route from the manifest entirely.
   */
  onRouteDiscovered?(route: RouteEntry): RouteEntry | null | undefined | Promise<RouteEntry | null | undefined>;

  /**
   * Called once after route discovery with the full manifest, to let a plugin inject routes
   * that don't correspond to a file on disk (e.g. a generated sitemap route). Return additional
   * `RouteEntry` values to append; return `undefined`/`[]` to add nothing.
   */
  onManifestReady?(manifest: RouteManifest): RouteEntry[] | undefined | Promise<RouteEntry[] | undefined>;

  /**
   * Called once per component/route source file with its text content, to transform it before
   * the dev-server/build pipeline compiles it (e.g. inject a banner, rewrite an import). Return
   * the new source text, or `undefined` to leave it unchanged.
   */
  transformComponent?(
    source: string,
    context: TransformContext,
  ): string | undefined | Promise<string | undefined>;

  /** Called once after a build (or dev-server compile pass) completes, with the final manifest. */
  onBuildComplete?(manifest: RouteManifest): void | Promise<void>;
}

export interface TransformContext {
  /** Path of the file being transformed, relative to the routes root. */
  filePath: string;
}
