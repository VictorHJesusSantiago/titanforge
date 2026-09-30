import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(process.cwd());

/**
 * Every `packages/<group>/<name>` folder aliases to `@titanforge/<name>` — discovered, not
 * hand-listed, the same convention `fluxforge`'s vitest config used and for the same reason:
 * adding a package should never also mean remembering to edit a second config file.
 */
const pkg = (group: string, name: string): string => resolve(root, 'packages', group, name, 'src', 'index.ts');

const alias: Record<string, string> = {
  '@titanforge/parser': pkg('sql', 'parser'),
  '@titanforge/catalog': pkg('sql', 'catalog'),
  '@titanforge/storage-api': pkg('sql', 'storage-api'),
  '@titanforge/storage-memory': pkg('sql', 'storage-memory'),
  '@titanforge/planner': pkg('sql', 'planner'),
  '@titanforge/storage-lsm': pkg('sql', 'storage-lsm'),
  '@titanforge/executor': pkg('sql', 'executor'),
  '@titanforge/engine': pkg('sql', 'engine'),
  '@titanforge/cli': pkg('sql', 'cli'),
  '@titanforge/vfs': pkg('ide', 'vfs'),
  '@titanforge/language-service': pkg('ide', 'language-service'),
  '@titanforge/monaco-bridge': pkg('ide', 'monaco-bridge'),
  '@titanforge/shell': pkg('ide', 'shell'),
  '@titanforge/dap': pkg('ide', 'dap'),
  '@titanforge/app': pkg('ide', 'app'),
  '@titanforge/otlp': pkg('observability', 'otlp'),
  '@titanforge/columnar-store': pkg('observability', 'columnar-store'),
  '@titanforge/query-lang': pkg('observability', 'query-lang'),
  '@titanforge/analysis': pkg('observability', 'analysis'),
  '@titanforge/sdk': pkg('observability', 'sdk'),
  '@titanforge/server': pkg('observability', 'server'),
  '@titanforge/ui': pkg('observability', 'ui'),
  '@titanforge/compiler': pkg('webstack', 'compiler'),
  '@titanforge/runtime': pkg('webstack', 'runtime'),
  '@titanforge/dev-server': pkg('webstack', 'dev-server'),
  '@titanforge/plugin-system': pkg('webstack', 'plugin-system'),
  '@titanforge/webstack-cli': pkg('webstack', 'webstack-cli'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/**/src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
