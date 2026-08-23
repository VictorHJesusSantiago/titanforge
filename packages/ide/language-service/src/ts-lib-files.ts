import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

/**
 * TypeScript's own `ts.LanguageService` needs the standard library declaration files
 * (lib.es2022.d.ts, lib.dom.d.ts, ...) to type-check anything meaningfully — without them
 * `Array`, `Promise`, `console`, etc. would all be `any`. These ship inside the `typescript`
 * npm package itself (`node_modules/typescript/lib/lib.*.d.ts`), the same files VS Code and the
 * TS Playground load. We resolve that directory once, on module load, via `require.resolve`
 * against the `typescript` package's own `main` entry (`lib/typescript.js`), so this works
 * regardless of how deeply `typescript` ends up hoisted in node_modules.
 */
const require = createRequire(import.meta.url);
export const TS_LIB_DIR: string = dirname(require.resolve('typescript'));

/** Read a TypeScript lib file (e.g. "lib.es2022.d.ts") by name from the real installed package. */
export function readTsLibFile(fileName: string): string | undefined {
  const full = join(TS_LIB_DIR, fileName.startsWith('lib.') ? fileName : `lib.${fileName}`);
  if (!existsSync(full)) return undefined;
  return readFileSync(full, 'utf8');
}

export function tsLibFilePath(fileName: string): string {
  return join(TS_LIB_DIR, fileName);
}

export function isTsLibPath(path: string): boolean {
  return path.startsWith(TS_LIB_DIR);
}
