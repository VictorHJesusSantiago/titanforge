import { transform, type Loader } from 'esbuild';

export interface TransformResult {
  code: string;
}

/**
 * On-the-fly, single-file transform of a route/component source, via esbuild's `transform`
 * (not `build` — no bundling, no module resolution: just "take this file's TS/TSX source, strip
 * types, lower syntax"). This is what the dev server re-runs for exactly the one file that
 * changed on each watch event, rather than re-bundling the whole app.
 */
export async function transformSource(filePath: string, source: string): Promise<TransformResult> {
  const result = await transform(source, {
    loader: loaderForPath(filePath),
    sourcemap: 'inline',
    target: 'es2022',
    format: 'esm',
  });
  return { code: result.code };
}

export function loaderForPath(filePath: string): Loader {
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.ts')) return 'ts';
  if (filePath.endsWith('.jsx')) return 'jsx';
  return 'js';
}
