import type { RouteEntry, RouteManifest } from '@titanforge/compiler';
import type { Plugin, TransformContext } from './plugin.js';

/**
 * Runs a fixed, ordered list of plugins over the compiler/dev-server pipeline. Each pipeline
 * stage is a separate method so callers (the CLI's `build`/`dev` commands) invoke exactly the
 * stages relevant to what they're doing.
 */
export class PluginRunner {
  constructor(private readonly plugins: readonly Plugin[]) {}

  /**
   * Runs `onRouteDiscovered` (in plugin-registration order) over every route in `manifest`,
   * then `onManifestReady` once over the result, appending anything it returns. This is where a
   * plugin observably mutates the route set: replacing a route, dropping one, or injecting new
   * ones entirely.
   */
  async applyRouteDiscovery(manifest: RouteManifest): Promise<RouteManifest> {
    const routes: RouteEntry[] = [];

    for (const route of manifest.routes) {
      let current: RouteEntry | null = route;
      for (const plugin of this.plugins) {
        if (current === null || !plugin.onRouteDiscovered) continue;
        const result = await plugin.onRouteDiscovered(current);
        if (result === null) {
          current = null;
          break;
        }
        if (result !== undefined) current = result;
      }
      if (current !== null) routes.push(current);
    }

    let out: RouteManifest = { ...manifest, routes };
    for (const plugin of this.plugins) {
      if (!plugin.onManifestReady) continue;
      const extra = await plugin.onManifestReady(out);
      if (extra && extra.length > 0) {
        out = { ...out, routes: [...out.routes, ...extra] };
      }
    }

    return out;
  }

  /** Runs every plugin's `transformComponent` in order, threading the source through each. */
  async transformComponent(source: string, context: TransformContext): Promise<string> {
    let current = source;
    for (const plugin of this.plugins) {
      if (!plugin.transformComponent) continue;
      const result = await plugin.transformComponent(current, context);
      if (result !== undefined) current = result;
    }
    return current;
  }

  /** Runs every plugin's `onBuildComplete`, in order, awaiting each before starting the next. */
  async notifyBuildComplete(manifest: RouteManifest): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onBuildComplete) await plugin.onBuildComplete(manifest);
    }
  }
}

/** Convenience one-shot: build a `PluginRunner` and immediately run route discovery through it. */
export async function applyPlugins(plugins: readonly Plugin[], manifest: RouteManifest): Promise<RouteManifest> {
  return new PluginRunner(plugins).applyRouteDiscovery(manifest);
}
