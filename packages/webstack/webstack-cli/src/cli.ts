import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from './build.js';
import { dev } from './dev.js';

/**
 * Thin CLI: `titanforge dev` and `titanforge build`, both defaulting to the example app at
 * `packages/webstack/example`. Run it with a TypeScript-capable runner, e.g.:
 *
 *   npx tsx packages/webstack/webstack-cli/src/cli.ts build
 *   npx tsx packages/webstack/webstack-cli/src/cli.ts dev
 *
 * See `packages/webstack/example/README.md` for the example app itself.
 */
const here = dirname(fileURLToPath(import.meta.url));
const exampleRoutesDir = join(here, '../../example/routes');
const generatedRouterFile = join(here, '../../example/.generated/router.ts');

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === 'build') {
    const result = await build({ routesDir: exampleRoutesDir, outFile: generatedRouterFile });
    console.log(`Discovered ${result.manifest.routes.length} route(s):`);
    for (const route of result.manifest.routes) {
      console.log(`  ${route.routePath}  ->  ${route.filePath}${route.loader ? ' (has loader)' : ''}`);
    }
    console.log(`Generated router written to ${generatedRouterFile}`);
    return;
  }

  if (command === 'dev') {
    const session = await dev({ routesDir: exampleRoutesDir });
    console.log(`Discovered ${session.manifest.routes.length} route(s) under ${exampleRoutesDir}`);
    console.log(`HMR WebSocket listening on ws://localhost:${session.hmr.port}`);
    console.log('Watching for changes. Press Ctrl+C to stop.');
    process.on('SIGINT', () => {
      void session.close().then(() => process.exit(0));
    });
    return;
  }

  console.error('Usage: titanforge <dev|build>');
  process.exitCode = 1;
}

void main();
