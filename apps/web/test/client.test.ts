import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApi } from '../src/api/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local service API client', () => {
  it('normalizes health, unwraps sessions, and uses the service lifecycle routes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/health') {
        return json({ ok: true, watchdogRunning: true, dryRun: true, version: 'fixture' });
      }
      if (path === '/api/sessions') {
        return json({ sessions: [{ id: 'claude:10' }] });
      }
      if (path === '/api/uninstall' && init?.method === 'POST') {
        return json({ ok: true });
      }
      if (path === '/api/watchdog/start' && init?.method === 'POST') {
        return json({ ok: true, running: true });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = createApi();
    await expect(api.health()).resolves.toEqual({ ok: true, running: true, dryRun: true, version: 'fixture' });
    await expect(api.sessions()).resolves.toEqual([{ id: 'claude:10' }]);
    await api.start();
    await api.uninstall();

    expect(fetchMock).toHaveBeenCalledWith('/api/watchdog/start', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/uninstall', expect.objectContaining({ method: 'POST' }));
  });

  it('receives named audit events from the service event stream', () => {
    const source = new FakeEventSource();
    vi.stubGlobal('EventSource', class {
      public constructor(_url: string) { return source; }
    });
    const listener = vi.fn();
    const unsubscribe = createApi().subscribe(listener);

    source.emit('audit', { id: 'event-1', timestampMs: 1, type: 'skip' });
    expect(listener).toHaveBeenCalledWith({ id: 'event-1', timestampMs: 1, type: 'skip' });
    unsubscribe();
    expect(source.closed).toBe(true);
  });
});

class FakeEventSource {
  public closed = false;
  private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void);
  }

  public removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  public emit(type: string, value: unknown): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(value) }));
  }

  public close(): void {
    this.closed = true;
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
