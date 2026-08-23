import { defineConfig } from 'vite';

/**
 * A plain Vite app (no framework) — the six packages under packages/ide/* are wired together
 * directly in src/main.ts. Nothing fancy needed here: Monaco ships its own web workers, which
 * Vite handles out of the box via `?worker` imports (see src/monacoEnvironment.ts).
 */
export default defineConfig({
  root: '.',
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
