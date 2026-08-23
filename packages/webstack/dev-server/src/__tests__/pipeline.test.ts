import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { HmrServer, type HmrMessage } from '../hmr-server.js';
import { createDevPipeline } from '../pipeline.js';
import type { Watcher } from '../watcher.js';

let dir: string | undefined;
let server: HmrServer | undefined;
let pipeline: Watcher | undefined;
let client: WebSocket | undefined;

afterEach(async () => {
  pipeline?.close();
  pipeline = undefined;
  client?.close();
  client = undefined;
  await server?.close();
  server = undefined;
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function nextMessage(socket: WebSocket): Promise<HmrMessage> {
  return new Promise((resolve) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString()) as HmrMessage));
  });
}

describe('createDevPipeline (real temp dir, real fs write, real ws server)', () => {
  it('transforms a real changed file and pushes the result over a real WebSocket connection', async () => {
    dir = await mkdtemp(join(tmpdir(), 'titanforge-pipeline-'));
    const filePath = join(dir, 'route.tsx');
    await writeFile(filePath, 'export default 1;', 'utf8');

    server = new HmrServer({ port: 0 });
    await server.waitUntilReady();
    pipeline = createDevPipeline({ rootDir: dir, hmr: server });

    client = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((resolve, reject) => {
      client!.once('open', () => resolve());
      client!.once('error', reject);
    });

    const received = nextMessage(client);
    // Let the watch handle settle before writing the change that should trigger it.
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(filePath, 'const n: number = 2;\nexport default n;', 'utf8');

    const message = await Promise.race([
      received,
      new Promise<HmrMessage>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
    ]);

    expect(message.type).toBe('update');
    if (message.type === 'update') {
      expect(message.filePath).toBe('route.tsx');
      expect(message.code).not.toContain(': number');
      expect(message.code).toContain('2');
    }
  });

  it('ignores changes to files with non-matching extensions', async () => {
    dir = await mkdtemp(join(tmpdir(), 'titanforge-pipeline-'));
    await writeFile(join(dir, 'notes.txt'), 'hello', 'utf8');

    server = new HmrServer({ port: 0 });
    await server.waitUntilReady();
    pipeline = createDevPipeline({ rootDir: dir, hmr: server });

    client = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise<void>((resolve, reject) => {
      client!.once('open', () => resolve());
      client!.once('error', reject);
    });

    let gotMessage = false;
    client.on('message', () => {
      gotMessage = true;
    });

    await new Promise((r) => setTimeout(r, 200));
    await writeFile(join(dir, 'notes.txt'), 'hello again', 'utf8');
    await new Promise((r) => setTimeout(r, 500));

    expect(gotMessage).toBe(false);
  });
});
