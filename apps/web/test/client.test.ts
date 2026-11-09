import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApi } from '../src/api/client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local service API client', () => {
  it('uses only loopback management routes for pairing codes and device revocation', async () => {
    const fetchMock = vi.fn(async () => json({ enabled: false }));
    vi.stubGlobal('fetch', fetchMock);
    const api = createApi();
    await api.remote!();
    await api.refreshRemotePairing!();
    await api.revokeRemoteDevice!('phone:1');
    await api.enableRemote!({ host: '127.0.0.1', port: 48921, name: 'Desktop' });
    await api.disableRemote!();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/remote', expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/remote/pairing', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/remote/devices/phone%3A1', expect.objectContaining({ method: 'DELETE' }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/remote/enable', expect.objectContaining({ method: 'POST', body: JSON.stringify({ host: '127.0.0.1', port: 48921, name: 'Desktop' }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, '/api/remote/disable', expect.objectContaining({ method: 'POST' }));
  });
  it('reads persisted audit entries from the service with the requested retention limit', async () => {
    const history = [{ id: 'persisted', timestampMs: 42, type: 'activity' }];
    const fetchMock = vi.fn(async () => json({ events: history }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createApi().audit!(300)).resolves.toEqual(history);
    expect(fetchMock).toHaveBeenCalledWith('/api/audit?limit=300', expect.anything());
  });
  it('preserves the service validation error when a save is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'pollIntervalMs must be positive' }), { status: 400 })));
    await expect(createApi().updateConfig({} as Parameters<ReturnType<typeof createApi>['updateConfig']>[0])).rejects.toThrow('pollIntervalMs must be positive');
  });

  it('retains the HTTP status when a proxy response contains no structured error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })));
    await expect(createApi().config()).rejects.toThrow('API 502');
  });

  it('normalizes health, unwraps sessions, and uses the service lifecycle routes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/health') {
        return json({ ok: true, watchdogRunning: true, dryRun: true, lastPollAtMs: 12_345, version: 'fixture' });
      }
      if (path === '/api/sessions') {
        return json({ sessions: [{ id: 'claude:10' }] });
      }
      if (path === '/api/uninstall' && init?.method === 'POST') {
        return json({ ok: true });
      }
      if (path === '/api/install' && init?.method === 'POST') {
        return json({ ok: true });
      }
      if (path === '/api/startup') {
        return json({ installed: false });
      }
      if (path === '/api/startup/install' && init?.method === 'POST') {
        return json({ ok: true });
      }
      if (path === '/api/startup/uninstall' && init?.method === 'POST') {
        return json({ ok: true });
      }
      if (path === '/api/codex/profiles' && init?.method === 'PUT') {
        return json({ ok: true, changes: [{ key: 'base_url', action: 'uncommented', value: 'https://second.example/v1' }] });
      }
      if (path === '/api/codex/profiles') {
        return json({ path: 'C:/demo/config.toml', exists: true, active: { base_url: 'https://first.example/v1' }, alternatives: {}, current: null });
      }
      if (path === '/api/claude-hook') {
        return json({
          installed: false,
          enabled: false,
          restartRequired: false,
          manualReviewRequired: false,
        });
      }
      if (path === '/api/claude-hook/install' && init?.method === 'POST') {
        return json({ installed: true, enabled: false, restartRequired: true, manualReviewRequired: false });
      }
      if (path === '/api/claude-hook/uninstall' && init?.method === 'POST') {
        return json({ installed: false, enabled: false, restartRequired: false, manualReviewRequired: false });
      }
      if (path === '/api/claude-hook/disable' && init?.method === 'POST') {
        return json({ installed: true, enabled: false, restartRequired: true, manualReviewRequired: false });
      }
      if (path === '/api/watchdog/start' && init?.method === 'POST') {
        return json({ ok: true, running: true });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = createApi();
    await expect(api.health()).resolves.toEqual({
      ok: true,
      running: true,
      dryRun: true,
      lastPollAtMs: 12_345,
      version: 'fixture',
    });
    await expect(api.sessions()).resolves.toEqual([{ id: 'claude:10' }]);
    await api.install();
    await expect(api.startup()).resolves.toEqual({ installed: false });
    await api.installStartup();
    await api.uninstallStartup();
    await expect(api.claudeHook()).resolves.toEqual({
      installed: false,
      enabled: false,
      restartRequired: false,
      manualReviewRequired: false,
    });
    await api.installClaudeHook();
    await api.uninstallClaudeHook();
    await api.disableClaudeHook();
    await expect(api.codexProfiles()).resolves.toEqual({ path: 'C:/demo/config.toml', exists: true, active: { base_url: 'https://first.example/v1' }, alternatives: {}, current: null });
    await expect(api.applyCodexProfile([{ key: 'base_url', value: 'https://second.example/v1' }])).resolves.toEqual({ ok: true, changes: [{ key: 'base_url', action: 'uncommented', value: 'https://second.example/v1' }] });
    await api.start();
    await api.uninstall();

    expect(fetchMock).toHaveBeenCalledWith('/api/install', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/startup', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenCalledWith('/api/startup/install', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/startup/uninstall', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/claude-hook', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenCalledWith('/api/claude-hook/install', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/claude-hook/uninstall', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/claude-hook/disable', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/codex/profiles', expect.objectContaining({ headers: expect.any(Object) }));
    expect(fetchMock).toHaveBeenCalledWith('/api/codex/profiles', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ fields: [{ key: 'base_url', value: 'https://second.example/v1' }] }) }));
    expect(fetchMock).toHaveBeenCalledWith('/api/watchdog/start', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/uninstall', expect.objectContaining({ method: 'POST' }));
  });

  it('sends an explicit null field removal and returns its removal outcome', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, changes: [{ key: 'experimental_bearer_token', action: 'removed', value: null }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const outcome = await createApi().applyCodexProfile([{ key: 'experimental_bearer_token', value: null }]);
    expect(fetchMock).toHaveBeenCalledWith('/api/codex/profiles', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ fields: [{ key: 'experimental_bearer_token', value: null }] }) }));
    expect(outcome.changes).toEqual([{ key: 'experimental_bearer_token', action: 'removed', value: null }]);
  });

  it('receives named audit events from the service event stream', () => {
    vi.stubGlobal('WebSocket', undefined);
    const source = new FakeEventSource();
    vi.stubGlobal('EventSource', class {
      public constructor(_url: string) { return source; }
    });
    const listener = vi.fn();
    const unsubscribe = createApi().subscribe(listener);

    source.emit('audit', { id: 'event-1', timestampMs: 1, type: 'skip' });
    source.emit('sessions', { action: 'refresh', sessionId: 'claude:10' });
    source.emit('claude-hook', { installed: true, enabled: false });
    expect(listener).toHaveBeenCalledWith({ kind: 'audit', event: { id: 'event-1', timestampMs: 1, type: 'skip' } });
    expect(listener).toHaveBeenCalledWith({ kind: 'sessions', data: { action: 'refresh', sessionId: 'claude:10' } });
    expect(listener).toHaveBeenCalledWith({ kind: 'claude-hook', data: { installed: true, enabled: false } });
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
