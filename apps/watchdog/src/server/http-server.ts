import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { chooseCodexPrompt } from '../domain/policy.js';
import type { AuditEvent, SessionSnapshot, WatchdogConfig } from '../domain/types.js';
import type { AuditStore } from '../store/audit-store.js';
import type { ConfigStore } from '../store/config-store.js';

type Awaitable<T> = T | Promise<T>;

export interface InjectionResult {
  readonly ok: boolean;
  readonly prompt?: string;
  readonly dryRun?: boolean;
  readonly error?: string;
}

export interface SessionController {
  list(): Awaitable<readonly SessionSnapshot[]>;
  configChanged?(config: WatchdogConfig): Awaitable<void>;
  pause(sessionId: string): Awaitable<boolean>;
  resume(sessionId: string): Awaitable<boolean>;
  inject(sessionId: string, prompt: string, dryRun: boolean): Awaitable<InjectionResult>;
}

export interface WatchdogLifecycle {
  start?(): Awaitable<void>;
  stop?(): Awaitable<void>;
  install?(): Awaitable<void>;
  uninstall?(): Awaitable<void>;
  startupStatus?(): Awaitable<StartupTaskStatus>;
  installStartup?(): Awaitable<void>;
  uninstallStartup?(): Awaitable<void>;
}

export interface StartupTaskStatus {
  readonly installed: boolean;
  readonly name?: string;
}

export interface WatchdogStatus {
  readonly lastPollAtMs: number | null;
}

export interface WatchdogHttpServerOptions {
  readonly configStore: ConfigStore;
  readonly auditStore: AuditStore;
  readonly sessions: SessionController;
  readonly status?: () => Awaitable<WatchdogStatus>;
  readonly host?: string;
  readonly port?: number;
  readonly portAttempts?: number;
  readonly maxJsonBytes?: number;
  readonly staticDirectory?: string;
  readonly now?: () => number;
}

interface SseClient {
  readonly id: number;
  readonly response: ServerResponse;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class WatchdogHttpServer {
  private readonly configStore: ConfigStore;
  private readonly auditStore: AuditStore;
  private readonly sessions: SessionController;
  private readonly status: () => Awaitable<WatchdogStatus>;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly portAttempts: number;
  private readonly maxJsonBytes: number;
  private readonly staticDirectory?: string;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly clients = new Map<number, SseClient>();
  private server: Server | null = null;
  private activePort: number | null = null;
  private nextClientId = 1;
  private lifecycle: WatchdogLifecycle = {};
  private watchdogRunning = true;

  public constructor(options: WatchdogHttpServerOptions) {
    this.configStore = options.configStore;
    this.auditStore = options.auditStore;
    this.sessions = options.sessions;
    this.status = options.status ?? (() => ({ lastPollAtMs: null }));
    this.host = options.host ?? '127.0.0.1';
    if (!LOOPBACK_HOSTS.has(this.host.toLocaleLowerCase())) {
      throw new TypeError('watchdog HTTP server must bind to a loopback host');
    }
    this.requestedPort = options.port ?? 48_920;
    if (!Number.isInteger(this.requestedPort) || this.requestedPort < 0 || this.requestedPort > 65_535) {
      throw new RangeError('port must be an integer between 0 and 65535');
    }
    this.portAttempts = options.portAttempts ?? 11;
    if (!Number.isInteger(this.portAttempts) || this.portAttempts <= 0) {
      throw new RangeError('portAttempts must be a positive integer');
    }
    this.maxJsonBytes = options.maxJsonBytes ?? 64 * 1_024;
    if (!Number.isInteger(this.maxJsonBytes) || this.maxJsonBytes <= 0) {
      throw new RangeError('maxJsonBytes must be a positive integer');
    }
    this.staticDirectory = options.staticDirectory === undefined ? undefined : resolve(options.staticDirectory);
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  public setLifecycle(lifecycle: WatchdogLifecycle): void {
    this.lifecycle = lifecycle;
  }

  public async start(): Promise<void> {
    if (this.server !== null) return;
    let lastError: unknown;
    const attempts = this.requestedPort === 0 ? 1 : this.portAttempts;
    for (let offset = 0; offset < attempts; offset += 1) {
      const port = this.requestedPort === 0 ? 0 : this.requestedPort + offset;
      if (port > 65_535) break;
      const server = createServer((request, response) => {
        void this.handle(request, response).catch((error: unknown) => this.handleError(response, error));
      });
      try {
        await listen(server, port, this.host);
        this.server = server;
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('HTTP server did not expose a TCP address');
        this.activePort = address.port;
        return;
      } catch (error) {
        lastError = error;
        await closeServer(server);
        if (!isAddressInUse(error)) throw error;
      }
    }
    throw lastError ?? new Error('no loopback port was available');
  }

  public async stop(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    this.activePort = null;
    for (const client of this.clients.values()) client.response.end();
    this.clients.clear();
    await closeServer(server);
  }

  public url(): string {
    if (this.activePort === null) throw new Error('HTTP server is not started');
    const host = this.host.includes(':') && !this.host.startsWith('[') ? `[${this.host}]` : this.host;
    return `http://${host}:${this.activePort}`;
  }

  /** Broadcast a redacted, already-persisted event to connected browsers. */
  public publish(event: string, data: unknown): boolean {
    if (!/^[a-z0-9-]+$/i.test(event)) throw new TypeError('invalid SSE event name');
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let delivered = false;
    for (const [id, client] of this.clients) {
      if (client.response.destroyed || client.response.writableEnded) {
        this.clients.delete(id);
        continue;
      }
      client.response.write(frame);
      delivered = true;
    }
    return delivered;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setSecurityHeaders(response);
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      throw new HttpError(403, 'loopback clients only');
    }
    const method = request.method ?? 'GET';
    if (MUTATING_METHODS.has(method) && !this.isAllowedOrigin(request.headers.origin)) {
      throw new HttpError(403, 'loopback origin required');
    }
    const base = this.url();
    const url = new URL(request.url ?? '/', base);

    if (method === 'GET' && url.pathname === '/api/health') {
      const config = await this.configStore.load();
      const status = await this.status();
      return this.json(response, 200, {
        ok: true,
        running: this.watchdogRunning,
        watchdogRunning: this.watchdogRunning,
        dryRun: config.dryRun,
        loopbackOnly: true,
        startedAtMs: this.startedAtMs,
        lastPollAtMs: status.lastPollAtMs,
        nowMs: this.now(),
        url: base,
      });
    }
    if (method === 'GET' && url.pathname === '/api/config') {
      return this.json(response, 200, await this.configStore.load());
    }
    if (method === 'PUT' && url.pathname === '/api/config') {
      const config = await this.configStore.save(await readJson(request, this.maxJsonBytes, false));
      await this.sessions.configChanged?.(config);
      await this.audit({ timestampMs: this.now(), type: 'config-change', details: { dryRun: config.dryRun } });
      this.publish('config', config);
      return this.json(response, 200, config);
    }
    if (method === 'GET' && url.pathname === '/api/sessions') {
      return this.json(response, 200, { sessions: await this.sessions.list() });
    }
    if (method === 'GET' && url.pathname === '/api/audit') {
      const limit = parseLimit(url.searchParams.get('limit'));
      return this.json(response, 200, { events: await this.auditStore.list(limit) });
    }
    if (method === 'GET' && url.pathname === '/api/events') {
      return this.openEventStream(request, response);
    }
    if (method === 'POST' && url.pathname === '/api/watchdog/start') {
      await this.lifecycle.start?.();
      this.watchdogRunning = true;
      await this.audit({ timestampMs: this.now(), type: 'user-override', details: { action: 'watchdog-start' } });
      this.publish('health', { running: true, watchdogRunning: true });
      return this.json(response, 200, { ok: true, running: true, watchdogRunning: true });
    }
    if (method === 'POST' && url.pathname === '/api/watchdog/stop') {
      await this.lifecycle.stop?.();
      this.watchdogRunning = false;
      await this.audit({ timestampMs: this.now(), type: 'user-override', details: { action: 'watchdog-stop' } });
      this.publish('health', { running: false, watchdogRunning: false });
      return this.json(response, 200, { ok: true, running: false, watchdogRunning: false });
    }
    if (method === 'POST' && url.pathname === '/api/install') {
      if (this.lifecycle.install === undefined) throw new HttpError(501, 'installer is not configured');
      await this.lifecycle.install();
      await this.audit({ timestampMs: this.now(), type: 'user-override', details: { action: 'install' } });
      return this.json(response, 200, { ok: true });
    }
    if (method === 'GET' && url.pathname === '/api/startup') {
      if (this.lifecycle.startupStatus === undefined) throw new HttpError(501, 'startup task manager is not configured');
      return this.json(response, 200, await this.lifecycle.startupStatus());
    }
    if (method === 'POST' && url.pathname === '/api/startup/install') {
      if (this.lifecycle.installStartup === undefined) throw new HttpError(501, 'startup task installer is not configured');
      await this.lifecycle.installStartup();
      await this.audit({ timestampMs: this.now(), type: 'user-override', details: { action: 'startup-install' } });
      this.publish('health', { startupInstalled: true });
      return this.json(response, 200, { ok: true, installed: true });
    }
    if (method === 'POST' && url.pathname === '/api/startup/uninstall') {
      if (this.lifecycle.uninstallStartup === undefined) throw new HttpError(501, 'startup task uninstaller is not configured');
      await this.lifecycle.uninstallStartup();
      await this.audit({ timestampMs: this.now(), type: 'user-override', details: { action: 'startup-uninstall' } });
      this.publish('health', { startupInstalled: false });
      return this.json(response, 200, { ok: true, installed: false });
    }
    if (method === 'POST' && url.pathname === '/api/uninstall') {
      if (this.lifecycle.uninstall === undefined) throw new HttpError(501, 'uninstaller is not configured');
      await this.lifecycle.uninstall();
      await this.audit({ timestampMs: this.now(), type: 'user-override', details: { action: 'uninstall' } });
      return this.json(response, 200, { ok: true });
    }

    const sessionRoute = /^\/api\/sessions\/([^/]+)\/(pause|resume|inject)$/.exec(url.pathname);
    if (method === 'POST' && sessionRoute !== null) {
      const sessionId = safeDecode(sessionRoute[1]);
      const action = sessionRoute[2];
      if (action === 'pause' || action === 'resume') {
        const ok = await this.sessions[action](sessionId);
        if (!ok) throw new HttpError(404, 'session not found');
        await this.audit({ timestampMs: this.now(), type: 'user-override', sessionId, details: { action } });
        this.publish('sessions', { action, sessionId });
        return this.json(response, 200, { ok: true, sessionId, paused: action === 'pause' });
      }

      const body = await readJson(request, this.maxJsonBytes, true);
      const config = await this.configStore.load();
      const session = (await this.sessions.list()).find((entry) => entry.id === sessionId);
      if (session === undefined) throw new HttpError(404, 'session not found');
      const prompt = parsePrompt((body as Record<string, unknown>).prompt, session, config);
      if (config.dryRun) {
        const event = await this.audit({
          timestampMs: this.now(),
          type: 'skip',
          sessionId,
          tool: session.tool,
          prompt,
          details: { reason: 'dry-run', action: 'manual-inject' },
        });
        return this.json(response, 200, { ok: true, dryRun: true, prompt, sessionId, eventId: event.id });
      }
      const result = await this.sessions.inject(sessionId, prompt, false);
      if (!result.ok) throw new HttpError(409, result.error ?? 'session cannot accept input');
      const event = await this.audit({
        timestampMs: this.now(),
        type: 'injection',
        sessionId,
        tool: session.tool,
        prompt,
        details: { action: 'manual-inject' },
      });
      this.publish('sessions', { action: 'inject', sessionId });
      return this.json(response, 200, { ...result, eventId: event.id, prompt, dryRun: false });
    }

    if (method === 'GET' && !url.pathname.startsWith('/api/') && this.staticDirectory !== undefined) {
      if (await this.serveStatic(url.pathname, response)) return;
    }
    throw new HttpError(404, 'not found');
  }

  private openEventStream(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();
    const id = this.nextClientId++;
    this.clients.set(id, { id, response });
    response.write(`event: ready\ndata: ${JSON.stringify({ nowMs: this.now() })}\n\n`);
    request.once('close', () => this.clients.delete(id));
  }

  private async audit(event: Omit<AuditEvent, 'id'>): Promise<AuditEvent> {
    const stored = await this.auditStore.append(event);
    this.publish('audit', stored);
    return stored;
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return false;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname.toLocaleLowerCase())) return false;
      return parsed.port === String(this.activePort);
    } catch {
      return false;
    }
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent || response.writableEnded) return;
    const encoded = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(encoded),
      'cache-control': 'no-store',
    });
    response.end(encoded);
  }

  private handleError(response: ServerResponse, error: unknown): void {
    if (response.writableEnded) return;
    const status = error instanceof HttpError ? error.status : isValidationError(error) ? 400 : 500;
    const message = status >= 500 ? 'internal server error' : error instanceof Error ? error.message : 'bad request';
    this.json(response, status, { ok: false, error: message });
  }

  private setSecurityHeaders(response: ServerResponse): void {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'");
  }

  private async serveStatic(requestPath: string, response: ServerResponse): Promise<boolean> {
    const relativePath = requestPath === '/' ? 'index.html' : decodeURIComponent(requestPath.slice(1));
    let filePath = resolve(this.staticDirectory!, relativePath);
    if (relative(this.staticDirectory!, filePath).startsWith('..')) throw new HttpError(403, 'invalid static path');
    try {
      if ((await stat(filePath)).isDirectory()) filePath = resolve(filePath, 'index.html');
      const body = await readFile(filePath);
      response.writeHead(200, { 'content-type': contentType(filePath), 'content-length': body.length });
      response.end(body);
      return true;
    } catch (error) {
      if (!isMissingFile(error) || extname(relativePath) !== '') return false;
      const indexPath = resolve(this.staticDirectory!, 'index.html');
      const body = await readFile(indexPath);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
      response.end(body);
      return true;
    }
  }
}

class HttpError extends Error {
  public readonly status: number;
  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(request: IncomingMessage, maxBytes: number, allowEmpty: boolean): Promise<unknown> {
  const contentType = request.headers['content-type'];
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (contentLength > maxBytes) {
    request.resume();
    throw new HttpError(413, 'JSON body is too large');
  }
  if (contentLength > 0 && (contentType === undefined || !contentType.toLocaleLowerCase().startsWith('application/json'))) {
    request.resume();
    throw new HttpError(415, 'content-type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) throw new HttpError(413, 'JSON body is too large');
  if (size === 0) {
    if (allowEmpty) return {};
    throw new HttpError(400, 'JSON body is required');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function parsePrompt(value: unknown, session: SessionSnapshot, config: WatchdogConfig): string {
  if (value !== undefined) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4_096 || /[\r\n\0]/.test(value)) {
      throw new HttpError(400, 'prompt must be a non-empty single line of at most 4096 characters');
    }
    return value;
  }
  return session.tool === 'codex'
    ? chooseCodexPrompt(session.goal, config.tools.codex)
    : config.tools.claude.normalPrompt;
}

function parseLimit(value: string | null): number {
  if (value === null) return 500;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 2_000) throw new HttpError(400, 'limit must be between 1 and 2000');
  return limit;
}

function safeDecode(value: string): string {
  try {
    const result = decodeURIComponent(value);
    if (result.trim().length === 0 || result.includes('/')) throw new Error('invalid');
    return result;
  } catch {
    throw new HttpError(400, 'invalid session id');
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.toLocaleLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1';
}

function isAddressInUse(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'EADDRINUSE');
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}

function isValidationError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError;
}

function contentType(path: string): string {
  switch (extname(path).toLocaleLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    default: return 'application/octet-stream';
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolvePromise();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
}
