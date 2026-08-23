import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Every `packages/<group>/<name>` folder aliases to `@titanforge/<name>` — discovered, not
 * hand-listed, the same convention `fluxforge`'s vitest config used and for the same reason:
 * adding a package should never also mean remembering to edit a second config file.
 */
const alias: Record<string, string> = {};
const groups = ['sql', 'observability', 'webstack', 'ide'];
for (const group of groups) {
  const groupDir = `${root}packages/${group}`;
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = `${groupDir}/${entry.name}/src/index.ts`;
    if (existsSync(indexPath)) {
      alias[`@titanforge/${entry.name}`] = indexPath;
    }
  }
}

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/**/src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
