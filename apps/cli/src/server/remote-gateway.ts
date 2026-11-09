import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';

const API_PREFIX = '/remote/v1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

interface StoredDevice {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

interface DeviceStoreDocument {
  readonly version: 1;
  readonly devices: readonly StoredDevice[];
}

export interface RemotePairingView {
  readonly code: string;
  readonly expiresAtMs: number;
}

export interface RemoteGatewayOptions {
  readonly localBaseUrl: string;
  readonly statePath: string;
  readonly host?: string;
  readonly port?: number;
  readonly name?: string;
  readonly maxJsonBytes?: number;
  readonly maxDevices?: number;
  readonly pairingTtlMs?: number;
  readonly tokenTtlMs?: number;
  readonly pairingAttemptLimit?: number;
  readonly pairingAttemptWindowMs?: number;
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
  readonly generatePairingCode?: () => string;
  readonly generateToken?: () => string;
  readonly generateDeviceId?: () => string;
}

interface PairingAttemptWindow {
  count: number;
  resetAtMs: number;
}

/**
 * Authenticated, deliberately narrow network facade for the loopback service.
 *
 * The local API remains loopback-only. This gateway maps only the session and
 * managed-agent actions needed by the mobile app, adds bearer authentication,
 * and supplies the local service origin when forwarding mutating requests.
 */
export class RemoteGateway {
  private readonly localBaseUrl: URL;
  private readonly statePath: string;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly name: string;
  private readonly maxJsonBytes: number;
  private readonly maxDevices: number;
  private readonly pairingTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly pairingAttemptLimit: number;
  private readonly pairingAttemptWindowMs: number;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly generatePairingCode: () => string;
  private readonly generateToken: () => string;
  private readonly generateDeviceId: () => string;
  private readonly attempts = new Map<string, PairingAttemptWindow>();
  private devices: StoredDevice[] = [];
  private pairing: RemotePairingView;
  private server: Server | null = null;
  private activePort: number | null = null;
  private persistQueue: Promise<void> = Promise.resolve();

  public constructor(options: RemoteGatewayOptions) {
    const local = new URL(options.localBaseUrl);
    if (local.protocol !== 'http:' || !LOOPBACK_HOSTS.has(local.hostname.toLocaleLowerCase()) || local.pathname !== '/') {
      throw new TypeError('remote gateway requires a loopback HTTP service URL');
    }
    this.localBaseUrl = local;
    this.statePath = options.statePath;
    this.host = options.host ?? '127.0.0.1';
    this.requestedPort = options.port ?? 48_921;
    if (!Number.isInteger(this.requestedPort) || this.requestedPort < 0 || this.requestedPort > 65_535) {
      throw new RangeError('remote port must be an integer between 0 and 65535');
    }
    this.name = options.name?.trim() || 'Selbstlauf';
    this.maxJsonBytes = options.maxJsonBytes ?? 64 * 1_024;
    this.maxDevices = options.maxDevices ?? 16;
    this.pairingTtlMs = options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.pairingAttemptLimit = options.pairingAttemptLimit ?? 6;
    this.pairingAttemptWindowMs = options.pairingAttemptWindowMs ?? 60_000;
    for (const [value, label] of [
      [this.maxJsonBytes, 'maxJsonBytes'],
      [this.maxDevices, 'maxDevices'],
      [this.pairingTtlMs, 'pairingTtlMs'],
      [this.tokenTtlMs, 'tokenTtlMs'],
      [this.pairingAttemptLimit, 'pairingAttemptLimit'],
      [this.pairingAttemptWindowMs, 'pairingAttemptWindowMs'],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
    }
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetch;
    this.generatePairingCode = options.generatePairingCode ?? (() => String(randomInt(100_000, 1_000_000)));
    this.generateToken = options.generateToken ?? (() => randomBytes(32).toString('base64url'));
    this.generateDeviceId = options.generateDeviceId ?? randomUUID;
    this.pairing = this.newPairing();
  }

  public async start(): Promise<void> {
    if (this.server !== null) return;
    this.devices = await loadDevices(this.statePath, this.now());
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => this.handleError(response, error));
    });
    try {
      await listen(server, this.requestedPort, this.host);
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('remote gateway did not expose a TCP address');
      this.server = server;
      this.activePort = address.port;
    } catch (error) {
      await closeServer(server);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    this.activePort = null;
    await closeServer(server);
    await this.persistQueue;
  }

  public url(): string {
    if (this.activePort === null) throw new Error('remote gateway is not started');
    const host = this.host.includes(':') && !this.host.startsWith('[') ? `[${this.host}]` : this.host;
    return `http://${host}:${this.activePort}`;
  }

  public pairingCode(): RemotePairingView {
    return { ...this.pairing };
  }

  public rotatePairingCode(): RemotePairingView {
    this.pairing = this.newPairing();
    this.attempts.clear();
    return this.pairingCode();
  }

  public pairedDevices(): readonly Omit<StoredDevice, 'tokenHash'>[] {
    return this.devices.map(({ tokenHash: _tokenHash, ...device }) => ({ ...device }));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setHeaders(response);
    const method = request.method ?? 'GET';
    if (method === 'OPTIONS') {
      request.resume();
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://remote.invalid');
    if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) {
      throw new RemoteHttpError(404, 'not found');
    }
    const path = url.pathname.slice(API_PREFIX.length) || '/';
    if (path === '/pair' && method === 'POST') return this.pair(request, response);

    const device = await this.authenticate(request);
    if (path === '/info' && method === 'GET') {
      const health = await this.forward('/api/health', 'GET', Buffer.alloc(0));
      let service: unknown = null;
      try { service = health.body.length === 0 ? null : JSON.parse(health.body.toString('utf8')); } catch { /* local service is trusted but may be restarting */ }
      return this.json(response, 200, {
        name: this.name,
        device_id: device.id,
        token_expires_at: device.expiresAtMs,
        service,
      });
    }
    if (path === '/device' && method === 'DELETE') {
      this.devices = this.devices.filter((entry) => entry.id !== device.id);
      await this.persist();
      return this.json(response, 200, { ok: true });
    }

    const body = await readBody(request, this.maxJsonBytes);
    if (path === '/agents' && method === 'POST') validateAgentLaunch(body);
    const target = allowedTarget(method, path, url.search);
    if (target === null) throw new RemoteHttpError(404, 'not found');
    const upstream = await this.forward(target, method, body);
    response.writeHead(upstream.status, {
      'content-type': upstream.contentType,
      'content-length': upstream.body.length,
      'cache-control': 'no-store',
    });
    response.end(upstream.body);
  }

  private async pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = request.socket.remoteAddress ?? 'unknown';
    this.takePairAttempt(address);
    const body = parseJson(await readBody(request, this.maxJsonBytes), true) as Record<string, unknown>;
    const code = body.code;
    const name = body.device_name;
    if (typeof code !== 'string' || !/^\d{6}$/u.test(code) ||
        typeof name !== 'string' || name.trim().length === 0 || name.length > 80 || /[\0\r\n]/u.test(name)) {
      throw new RemoteHttpError(400, 'code and device_name are required');
    }
    if (this.now() > this.pairing.expiresAtMs || !safeTextEqual(code, this.pairing.code)) {
      throw new RemoteHttpError(401, 'pairing code is invalid or expired');
    }
    this.pruneExpired();
    if (this.devices.length >= this.maxDevices) throw new RemoteHttpError(429, 'paired device limit reached');
    const token = this.generateToken();
    if (token.length < 32 || token.length > 512 || /\s/u.test(token)) throw new Error('token generator returned an invalid token');
    const createdAtMs = this.now();
    const device: StoredDevice = {
      id: this.generateDeviceId(),
      name: name.trim(),
      tokenHash: tokenHash(token),
      createdAtMs,
      expiresAtMs: createdAtMs + this.tokenTtlMs,
    };
    // A code authorizes exactly one device. A fresh code is available only to
    // the trusted local process through pairingCode(). Rotate before the first
    // await so two concurrent requests cannot both consume the same code.
    this.devices = [...this.devices, device];
    this.rotatePairingCode();
    this.attempts.delete(address);
    await this.persist();
    return this.json(response, 200, {
      token,
      device_id: device.id,
      expires_at: device.expiresAtMs,
    });
  }

  private async authenticate(request: IncomingMessage): Promise<StoredDevice> {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new RemoteHttpError(401, 'bearer token required');
    }
    const token = authorization.slice('Bearer '.length);
    if (token.length < 32 || token.length > 512 || /\s/u.test(token)) throw new RemoteHttpError(401, 'invalid bearer token');
    const removed = this.pruneExpired();
    if (removed) await this.persist();
    const digest = Buffer.from(tokenHash(token), 'hex');
    const device = this.devices.find((entry) => {
      const stored = Buffer.from(entry.tokenHash, 'hex');
      return stored.length === digest.length && timingSafeEqual(stored, digest);
    });
    if (device === undefined) throw new RemoteHttpError(401, 'invalid bearer token');
    return device;
  }

  private async forward(path: string, method: string, body: Buffer): Promise<{
    status: number;
    contentType: string;
    body: Buffer;
  }> {
    const url = new URL(path, this.localBaseUrl);
    const upstream = await this.fetcher(url, {
      method,
      headers: {
        accept: 'application/json',
        origin: this.localBaseUrl.origin,
        ...(body.length === 0 ? {} : { 'content-type': 'application/json' }),
      },
      ...(body.length === 0 || method === 'GET' ? {} : { body }),
      redirect: 'error',
    });
    const result = Buffer.from(await upstream.arrayBuffer());
    if (result.length > 4 * 1_024 * 1_024) throw new RemoteHttpError(502, 'local response is too large');
    return {
      status: upstream.status,
      contentType: upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      body: result,
    };
  }

  private takePairAttempt(address: string): void {
    const now = this.now();
    const current = this.attempts.get(address);
    const window = current === undefined || current.resetAtMs <= now
      ? { count: 0, resetAtMs: now + this.pairingAttemptWindowMs }
      : current;
    if (window.count >= this.pairingAttemptLimit) throw new RemoteHttpError(429, 'too many pairing attempts');
    window.count += 1;
    this.attempts.set(address, window);
  }

  private pruneExpired(): boolean {
    const current = this.devices;
    this.devices = current.filter((device) => device.expiresAtMs > this.now());
    return current.length !== this.devices.length;
  }

  private persist(): Promise<void> {
    const document: DeviceStoreDocument = { version: 1, devices: this.devices };
    const operation = this.persistQueue.then(() => saveDevices(this.statePath, document));
    this.persistQueue = operation.catch(() => undefined);
    return operation;
  }

  private newPairing(): RemotePairingView {
    const code = this.generatePairingCode();
    if (!/^\d{6}$/u.test(code)) throw new Error('pairing code generator must return six digits');
    return { code, expiresAtMs: this.now() + this.pairingTtlMs };
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    const encoded = Buffer.from(JSON.stringify(body));
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': encoded.length,
      'cache-control': 'no-store',
    });
    response.end(encoded);
  }

  private handleError(response: ServerResponse, error: unknown): void {
    if (response.writableEnded) return;
    const status = error instanceof RemoteHttpError ? error.status : 500;
    const message = error instanceof RemoteHttpError ? error.message : 'internal server error';
    this.json(response, status, { ok: false, error: message });
  }

  private setHeaders(response: ServerResponse): void {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    response.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
    response.setHeader('access-control-max-age', '600');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');
  }
}

function allowedTarget(method: string, path: string, search: string): string | null {
  if (method === 'GET' && path === '/health') return '/api/health';
  if (method === 'GET' && path === '/sessions') return '/api/sessions';
  if (method === 'GET' && path === '/agents/catalog') return '/api/agents/catalog';
  if ((method === 'GET' || method === 'POST') && path === '/agents') return '/api/agents';
  if (method === 'POST' && (path === '/watchdog/start' || path === '/watchdog/stop')) return `/api${path}`;
  const session = /^\/sessions\/([^/]+)\/(output|pause|resume|inject|focus)$/u.exec(path);
  if (session !== null && ((method === 'GET' && session[2] === 'output') ||
      (method === 'POST' && session[2] !== 'output'))) return `/api${path}`;
  const agent = /^\/agents\/([^/]+)(?:\/(output|input|interrupt|terminate))?$/u.exec(path);
  if (agent === null) return null;
  const action = agent[2];
  if (method === 'GET' && action === 'output') return `/api${path}${search}`;
  if (method === 'POST' && action !== undefined && action !== 'output') return `/api${path}`;
  if (method === 'DELETE' && action === undefined) return `/api${path}`;
  return null;
}

function validateAgentLaunch(body: Buffer): void {
  const value = parseJson(body, true);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RemoteHttpError(400, 'agent launch must be an object');
  const launch = value as Record<string, unknown>;
  if (launch.tool === 'custom' || typeof launch.command === 'string') {
    throw new RemoteHttpError(403, 'custom agent commands are not available remotely');
  }
}

function parseJson(body: Buffer, required: boolean): unknown {
  if (body.length === 0) {
    if (required) throw new RemoteHttpError(400, 'JSON body is required');
    return {};
  }
  try { return JSON.parse(body.toString('utf8')) as unknown; } catch { throw new RemoteHttpError(400, 'invalid JSON body'); }
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > maxBytes) {
    request.resume();
    throw new RemoteHttpError(413, 'JSON body is too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new RemoteHttpError(413, 'JSON body is too large');
    chunks.push(buffer);
  }
  if (size > 0) {
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string' || !contentType.toLocaleLowerCase().startsWith('application/json')) {
      throw new RemoteHttpError(415, 'content-type must be application/json');
    }
  }
  return Buffer.concat(chunks);
}

async function loadDevices(path: string, now: number): Promise<StoredDevice[]> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new Error('remote device store is invalid JSON'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('remote device store is invalid');
  const document = value as { version?: unknown; devices?: unknown };
  if (document.version !== 1 || !Array.isArray(document.devices)) throw new Error('remote device store is invalid');
  return document.devices.map((entry) => validateStoredDevice(entry)).filter((device) => device.expiresAtMs > now);
}

function validateStoredDevice(value: unknown): StoredDevice {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('remote device store contains an invalid device');
  const device = value as Record<string, unknown>;
  if (typeof device.id !== 'string' || device.id.length === 0 || device.id.length > 128 ||
      typeof device.name !== 'string' || device.name.length === 0 || device.name.length > 80 ||
      typeof device.tokenHash !== 'string' || !/^[0-9a-f]{64}$/u.test(device.tokenHash) ||
      !Number.isSafeInteger(device.createdAtMs) || !Number.isSafeInteger(device.expiresAtMs)) {
    throw new Error('remote device store contains an invalid device');
  }
  return device as unknown as StoredDevice;
}

async function saveDevices(path: string, document: DeviceStoreDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await replaceAtomically(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function replaceAtomically(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  const backup = `${destination}.${randomBytes(6).toString('hex')}.bak`;
  const staged = await rename(destination, backup).then(() => true).catch((error: unknown) => {
    if (isMissingFile(error)) return false;
    throw error;
  });
  try {
    await rename(source, destination);
  } catch (error) {
    if (staged) await rename(backup, destination).catch(() => undefined);
    throw error;
  }
  if (staged) await rm(backup, { force: true });
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error &&
      ['EEXIST', 'EPERM', 'ENOTEMPTY'].includes((error as { code?: string }).code ?? ''),
  );
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeTextEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

class RemoteHttpError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
