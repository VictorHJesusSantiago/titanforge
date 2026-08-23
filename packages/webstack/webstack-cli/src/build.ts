import { Project } from 'ts-morph';
import { discoverRoutes, generateRouterSource, type RouteManifest } from '@titanforge/compiler';
import { PluginRunner, type Plugin } from '@titanforge/plugin-system';

export interface BuildOptions {
  /** Directory of route files, e.g. `packages/webstack/example/routes`. */
  routesDir: string;
  /** Where to write the generated typed router module. */
  outFile: string;
  plugins?: readonly Plugin[];
  /** When true, writes `outFile` to disk; when false (tests), only returns the generated text. */
  write?: boolean;
}

export interface BuildResult {
  manifest: RouteManifest;
  generatedSource: string;
}

/**
 * The `build` pipeline: discover routes with the compiler, run plugins over the discovered
 * manifest, generate the typed router module, and (optionally) write it to disk.
 */
export async function build(options: BuildOptions): Promise<BuildResult> {
  const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true });
  project.addSourceFilesAtPaths(`${options.routesDir}/**/*.{ts,tsx}`);

  let manifest = discoverRoutes(project, options.routesDir);

  const runner = new PluginRunner(options.plugins ?? []);
  manifest = await runner.applyRouteDiscovery(manifest);

  const generated = generateRouterSource(project, manifest, options.outFile);
  if (options.write ?? true) {
    generated.saveSync();
  }

  await runner.notifyBuildComplete(manifest);

  return { manifest, generatedSource: generated.getFullText() };
}
