import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchDirectory, type Watcher } from '../watcher.js';

let dir: string | undefined;
let watcher: Watcher | undefined;

afterEach(async () => {
  watcher?.close();
  watcher = undefined;
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('watchDirectory (real fs.watch, real temp dir)', () => {
  it('reports a change when a file is written to the watched directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'titanforge-watch-'));
    const filePath = join(dir, 'route.tsx');
    await writeFile(filePath, 'export default 1;', 'utf8');

    let resolveChange!: (filePath: string) => void;
    const changed = new Promise<string>((resolve) => {
      resolveChange = resolve;
    });
    watcher = watchDirectory(dir, (p) => resolveChange(p));

    // Give the OS watch handle a moment to actually register before we write.
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(filePath, 'export default 2;', 'utf8');

    const reported = await Promise.race([
      changed,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);
    expect(reported).toContain('route.tsx');
  });

  it('reports changes to newly-created nested files (recursive watch)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'titanforge-watch-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'users'));

    const events: string[] = [];
    watcher = watchDirectory(dir, (p) => events.push(p));

    await new Promise((r) => setTimeout(r, 200));
    await writeFile(join(dir, 'users', '[id].tsx'), 'export default 1;', 'utf8');

    await new Promise((r) => setTimeout(r, 500));
    expect(events.some((e) => e.includes('[id].tsx'))).toBe(true);
  });

  it('close() stops further callbacks from firing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'titanforge-watch-'));
    let calls = 0;
    watcher = watchDirectory(dir, () => {
      calls += 1;
    });
    watcher.close();
    await writeFile(join(dir, 'after-close.tsx'), 'x', 'utf8');
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(0);
  });
});
