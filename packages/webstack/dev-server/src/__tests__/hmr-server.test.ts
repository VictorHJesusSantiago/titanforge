import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { HmrServer, type HmrMessage } from '../hmr-server.js';

let server: HmrServer | undefined;
let clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients) client.close();
  clients = [];
  await server?.close();
  server = undefined;
});

async function connect(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

function nextMessage(socket: WebSocket): Promise<HmrMessage> {
  return new Promise((resolve) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString()) as HmrMessage));
  });
}

describe('HmrServer (real ws server + real ws client)', () => {
  it('picks a real port to listen on', async () => {
    server = new HmrServer({ port: 0 });
    await server.waitUntilReady();
    expect(server.port).toBeGreaterThan(0);
  });

  it('delivers a broadcast message to a connected client', async () => {
    server = new HmrServer({ port: 0 });
    await server.waitUntilReady();
    const client = await connect(server.port);

    const received = nextMessage(client);
    server.broadcast({ type: 'update', filePath: 'a.tsx', code: 'export default 1;' });

    await expect(received).resolves.toEqual({ type: 'update', filePath: 'a.tsx', code: 'export default 1;' });
  });

  it('delivers a broadcast to multiple connected clients', async () => {
    server = new HmrServer({ port: 0 });
    await server.waitUntilReady();
    const [a, b] = await Promise.all([connect(server.port), connect(server.port)]);

    const receivedA = nextMessage(a!);
    const receivedB = nextMessage(b!);
    server.broadcast({ type: 'full-reload', reason: 'config changed' });

    const [msgA, msgB] = await Promise.all([receivedA, receivedB]);
    expect(msgA).toEqual({ type: 'full-reload', reason: 'config changed' });
    expect(msgB).toEqual({ type: 'full-reload', reason: 'config changed' });
  });

  it('tracks connected client count', async () => {
    server = new HmrServer({ port: 0 });
    await server.waitUntilReady();
    expect(server.clientCount).toBe(0);
    await connect(server.port);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.clientCount).toBe(1);
  });

  it('onConnection fires for a real incoming connection', async () => {
    server = new HmrServer({ port: 0 });
    await server.waitUntilReady();
    const connected = new Promise<void>((resolve) => server!.onConnection(() => resolve()));
    await connect(server.port);
    await expect(connected).resolves.toBeUndefined();
  });
});
