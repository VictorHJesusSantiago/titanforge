import { watch } from 'node:fs';
import { join } from 'node:path';

export interface Watcher {
  close(): void;
}

/**
 * Watches `dir` recursively using Node's real `fs.watch` (not a mocked/simulated watcher).
 * `onChange` is called with the changed file's absolute path for every filesystem event Node
 * reports; callers debounce/filter as needed (see `pipeline.ts`, which filters by extension).
 *
 * `recursive: true` is supported by `fs.watch` on Windows and macOS, which is sufficient for
 * this dev server's target platforms; Linux support would need a manual per-directory watch
 * fan-out, which is out of scope here.
 */
export function watchDirectory(dir: string, onChange: (filePath: string) => void): Watcher {
  const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    onChange(join(dir, filename.toString()));
  });
  return {
    close: () => watcher.close(),
  };
}
