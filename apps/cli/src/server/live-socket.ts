import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ManagedAgentSessions } from '../agents/managed-sessions.js';

interface OutputSubscription {
  cursor: number;
  dirty: boolean;
  unsubscribe: () => void;
}

/** Multiplexes events and terminal output without occupying the browser's HTTP connection pool. */
export class LiveSocketServer {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  constructor(private readonly agents?: ManagedAgentSessions) {}

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(request, socket, head, (client) => this.connected(client));
  }

  publish(event: string, data: unknown): boolean {
    let delivered = false;
    const message = JSON.stringify({ event, data });
    for (const client of this.server.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > 4 * 1024 * 1024) { client.close(1013, 'Reconnect to catch up'); continue; }
      client.send(message);
      delivered = true;
    }
    return delivered;
  }

  stop(): void {
    for (const client of this.server.clients) client.terminate();
  }

  private connected(client: WebSocket): void {
    const subscriptions = new Map<string, OutputSubscription>();
    const send = (event: string, data: unknown) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ event, data }));
    };
    const flush = () => {
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 1024 * 1024) return;
      for (const [id, subscription] of subscriptions) {
        if (!subscription.dirty) continue;
        try {
          const output = this.agents!.output(id, subscription.cursor);
          subscription.cursor = output.offset;
          subscription.dirty = false;
          send('output', output);
        } catch (cause) {
          subscription.unsubscribe(); subscriptions.delete(id);
          send('agent-error', { id, error: cause instanceof Error ? cause.message : String(cause) });
        }
        if (client.bufferedAmount > 1024 * 1024) break;
      }
    };
    client.on('message', (data, binary) => {
      if (binary) { client.close(1003, 'JSON messages required'); return; }
      let requestedId: string | undefined;
      try {
        const message = JSON.parse(data.toString()) as { type?: unknown; id?: unknown; after?: unknown };
        if (typeof message.id !== 'string' || message.id.length > 128) throw new Error('Invalid session id');
        const id = message.id;
        requestedId = id;
        if (message.type === 'unsubscribe-output') {
          subscriptions.get(id)?.unsubscribe(); subscriptions.delete(id); return;
        }
        if (message.type !== 'subscribe-output' || this.agents === undefined) throw new Error('Unsupported subscription');
        const after = message.after ?? 0;
        if (!Number.isSafeInteger(after) || (after as number) < 0) throw new Error('Invalid output cursor');
        if (!subscriptions.has(id) && subscriptions.size >= 32) throw new Error('Too many terminal subscriptions');
        this.agents.output(id, after as number);
        subscriptions.get(id)?.unsubscribe();
        const subscription: OutputSubscription = { cursor: after as number, dirty: true, unsubscribe: () => undefined };
        subscription.unsubscribe = this.agents.subscribe(id, () => { subscription.dirty = true; flush(); });
        subscriptions.set(id, subscription);
        flush();
      } catch (cause) {
        send('agent-error', { id: requestedId, error: cause instanceof Error ? cause.message : String(cause) });
      }
    });
    // Dirty output survives backpressure, including a process's final output and exit status.
    const timer = setInterval(flush, 50);
    timer.unref();
    const heartbeat = setInterval(() => { if (client.readyState === WebSocket.OPEN) client.ping(); }, 15000);
    heartbeat.unref();
    client.on('error', () => client.terminate());
    client.once('close', () => {
      clearInterval(timer); clearInterval(heartbeat);
      for (const subscription of subscriptions.values()) subscription.unsubscribe();
      subscriptions.clear();
    });
    send('ready', { nowMs: Date.now() });
  }
}
