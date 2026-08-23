import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { AddressInfo } from 'node:net';

export type HmrMessage =
  | { type: 'update'; filePath: string; code: string }
  | { type: 'full-reload'; reason: string };

export interface HmrServerOptions {
  /** Port to listen on; `0` (the default) picks any free port — read it back via `.port`. */
  port?: number;
}

/**
 * The HMR transport: a real `ws` WebSocket server. Watched-file changes are pushed to every
 * connected client as an `HmrMessage`; the client-side runtime (`client.ts`) decides what to do
 * with it.
 */
export class HmrServer {
  private readonly wss: WebSocketServer;
  private readonly ready: Promise<void>;

  constructor(options: HmrServerOptions = {}) {
    this.wss = new WebSocketServer({ port: options.port ?? 0 });
    this.ready = new Promise((resolve) => this.wss.once('listening', () => resolve()));
  }

  /** Resolves once the server is actually listening (so `.port` is valid). */
  async waitUntilReady(): Promise<void> {
    await this.ready;
  }

  get port(): number {
    return (this.wss.address() as AddressInfo).port;
  }

  onConnection(listener: (socket: WebSocket) => void): void {
    this.wss.on('connection', listener);
  }

  onMessage(listener: (socket: WebSocket, data: RawData) => void): void {
    this.wss.on('connection', (socket) => {
      socket.on('message', (data) => listener(socket, data));
    });
  }

  /** Sends `message` to every currently-open client connection. */
  broadcast(message: HmrMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
      for (const client of this.wss.clients) client.terminate();
    });
  }
}
