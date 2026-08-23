import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { HmrServer } from './hmr-server.js';
import { transformSource } from './transform.js';
import { watchDirectory, type Watcher } from './watcher.js';

export interface DevPipelineOptions {
  rootDir: string;
  hmr: HmrServer;
  /** File extensions that trigger a transform + HMR push. Default: `.ts`, `.tsx`. */
  extensions?: readonly string[];
}

/**
 * Wires the three real pieces together: watch `rootDir` for changes, and for every changed file
 * matching `extensions`, re-transform *just that file* with esbuild and broadcast the result
 * over the HMR WebSocket channel.
 *
 * Documented scope: this re-renders/re-runs the affected route's module on the client (see
 * `client.ts`) — it does not preserve component-local state across the swap. That's a real,
 * honest limit: full Fast-Refresh-style state preservation requires patching a live fiber tree,
 * which this framework's component model (plain functions returning a tree, no persistent
 * component instances) doesn't have anywhere to hang state onto in the first place.
 */
export function createDevPipeline(options: DevPipelineOptions): Watcher {
  const extensions = options.extensions ?? ['.ts', '.tsx'];

  return watchDirectory(options.rootDir, (filePath) => {
    if (!extensions.some((ext) => filePath.endsWith(ext))) return;
    void handleChange(filePath);
  });

  async function handleChange(filePath: string): Promise<void> {
    try {
      const source = await readFile(filePath, 'utf8');
      const { code } = await transformSource(filePath, source);
      const relativePath = relative(options.rootDir, filePath).replace(/\\/g, '/');
      options.hmr.broadcast({ type: 'update', filePath: relativePath, code });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      options.hmr.broadcast({ type: 'full-reload', reason });
    }
  }
}
