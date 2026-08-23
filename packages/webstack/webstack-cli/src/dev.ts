import { Project } from 'ts-morph';
import { discoverRoutes, type RouteManifest } from '@titanforge/compiler';
import { HmrServer, createDevPipeline, type Watcher } from '@titanforge/dev-server';

export interface DevOptions {
  routesDir: string;
  /** Port for the HMR WebSocket server; `0` (default) picks a free port. */
  port?: number;
}

export interface DevSession {
  manifest: RouteManifest;
  hmr: HmrServer;
  watcher: Watcher;
  close(): Promise<void>;
}

/**
 * The `dev` pipeline. Scope, stated plainly: this starts the HMR WebSocket channel and the
 * file-watch → esbuild-transform → broadcast pipeline from `@titanforge/dev-server`, over a
 * one-shot route discovery from `@titanforge/compiler`. It does not start an HTTP server or
 * serve the example app's pages — that would require a request router and a client-side runtime
 * bundle, which is a separate, larger concern than "does the compiler + HMR pipeline work end to
 * end." Wiring an actual HTTP dev server on top of this is a straightforward next step, not
 * attempted here so the tested surface stays real rather than padded.
 */
export async function dev(options: DevOptions): Promise<DevSession> {
  const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths(`${options.routesDir}/**/*.{ts,tsx}`);
  const manifest = discoverRoutes(project, options.routesDir);

  const hmr = new HmrServer({ port: options.port ?? 0 });
  await hmr.waitUntilReady();

  const watcher = createDevPipeline({ rootDir: options.routesDir, hmr });

  return {
    manifest,
    hmr,
    watcher,
    close: async () => {
      watcher.close();
      await hmr.close();
    },
  };
}
