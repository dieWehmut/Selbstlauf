import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface AppServerWritable {
  write(chunk: string): boolean;
  end?(): void;
}

export interface AppServerReadable {
  on(event: 'data' | 'error' | 'end', listener: (...args: any[]) => void): this;
}

export interface AppServerChild {
  readonly stdin: AppServerWritable;
  readonly stdout: AppServerReadable;
  readonly stderr?: AppServerReadable;
  on(event: 'close' | 'error', listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface AppServerSpawnOptions {
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
  readonly windowsHide: boolean;
}

export type AppServerSpawn = (
  command: string,
  args: readonly string[],
  options: AppServerSpawnOptions,
) => AppServerChild;

export interface AppServerClientOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly spawn?: AppServerSpawn;
  readonly requestTimeoutMs?: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly onNotification?: (notification: AppServerNotification) => void;
}

export interface AppServerNotification {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface JsonRpcResponse {
  readonly [key: string]: unknown;
}

export interface TurnStartResult extends JsonRpcResponse {
  readonly turn?: Readonly<Record<string, unknown>>;
}

export class AppServerProtocolError extends Error {
  public readonly code = 'app-server-protocol-error';

  public constructor(message: string) {
    super(message);
    this.name = 'AppServerProtocolError';
  }
}

interface PendingRequest {
  readonly resolve: (value: JsonRpcResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Small JSON-RPC client for the local Codex App Server stdio transport.
 * The child is created only when the first request is made.
 */
export class AppServerClient {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly spawn: AppServerSpawn;
  private readonly requestTimeoutMs: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly onNotification?: (notification: AppServerNotification) => void;
  private child: AppServerChild | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private inputBuffer = '';
  private initialized = false;
  private initializePromise: Promise<JsonRpcResponse> | null = null;
  private activeTurn = false;
  private closed = false;

  public constructor(options: AppServerClientOptions = {}) {
    this.command = options.command ?? 'codex';
    this.args = Object.freeze([...(options.args ?? ['app-server', '--listen', 'stdio://'])]);
    this.spawn = options.spawn ?? defaultSpawn;
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS, 'requestTimeoutMs');
    this.clientName = options.clientName ?? 'ai-cli-bypass-watchdog';
    this.clientVersion = options.clientVersion ?? '0.1.0';
    this.onNotification = options.onNotification;
  }

  /** Start and handshake with `codex app-server --listen stdio://` on demand. */
  public initialize(): Promise<JsonRpcResponse> {
    if (this.closed) return Promise.reject(new Error('Codex App Server client is closed'));
    if (this.initialized) return Promise.resolve(Object.freeze({}));
    if (this.initializePromise !== null) return this.initializePromise;

    this.ensureChild();
    this.initializePromise = this.sendRequest('initialize', {
      clientInfo: { name: this.clientName, version: this.clientVersion },
      capabilities: {},
    }).then((result) => {
      // The server expects the notification after the initialize response.
      this.sendNotification('initialized', {});
      this.initialized = true;
      return result;
    }).finally(() => {
      this.initializePromise = null;
    });
    return this.initializePromise;
  }

  public listThreads(params: Readonly<Record<string, unknown>> = {}): Promise<JsonRpcResponse> {
    return this.afterInitialize(() => this.sendRequest('thread/list', params));
  }

  public resumeThread(threadId: string): Promise<JsonRpcResponse> {
    assertNonEmpty(threadId, 'threadId');
    return this.afterInitialize(() => this.sendRequest('thread/resume', { threadId }));
  }

  /**
   * Start one turn. The in-flight guard is synchronous so callers cannot race
   * two turns before the initialization promise settles.
   */
  public startTurn(threadId: string, prompt: string): Promise<TurnStartResult> {
    assertNonEmpty(threadId, 'threadId');
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new TypeError('prompt must be a non-empty string');
    }
    if (this.activeTurn) {
      throw new Error('Codex App Server has an active turn; concurrent turns are rejected');
    }
    this.activeTurn = true;
    return this.afterInitialize(() =>
      this.sendRequest('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
      }),
    ).then((result) => {
      return result as TurnStartResult;
    }).catch((error: unknown) => {
      this.activeTurn = false;
      throw error;
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('Codex App Server client closed');
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(id);
    }
    this.activeTurn = false;
    this.child?.stdin.end?.();
    this.child?.kill();
    this.child = null;
  }

  private afterInitialize<T>(operation: () => Promise<T>): Promise<T> {
    return this.initialize().then(operation);
  }

  private ensureChild(): AppServerChild {
    if (this.child !== null) return this.child;
    if (this.closed) throw new Error('Codex App Server client is closed');
    const child = this.spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on('data', (chunk: unknown) => this.consumeOutput(String(chunk)));
    child.stdout.on('error', (error: unknown) => this.failPending(toError(error)));
    child.stdout.on('end', () => this.failPending(new Error('Codex App Server stdout ended')));
    child.stderr?.on('data', () => {
      // stderr is intentionally ignored; credentials and rollout content must
      // never be copied into watchdog state or audit events.
    });
    child.stderr?.on('error', () => undefined);
    child.on('error', (error: unknown) => {
      this.child = null;
      this.failPending(toError(error));
    });
    child.on('close', (code) => {
      this.child = null;
      if (!this.closed) {
        this.failPending(new Error(`Codex App Server exited${code === null ? '' : ` with code ${code}`}`));
      }
    });
    return child;
  }

  private sendNotification(method: string, params: Readonly<Record<string, unknown>>): void {
    const child = this.ensureChild();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private sendRequest(method: string, params: Readonly<Record<string, unknown>>): Promise<JsonRpcResponse> {
    const child = this.ensureChild();
    const id = this.nextRequestId++;
    const message = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(toError(error));
      }
    });
  }

  private consumeOutput(chunk: string): void {
    this.inputBuffer += chunk;
    let newlineIndex = this.inputBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.inputBuffer.slice(0, newlineIndex).trim();
      this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);
      if (line.length > 0) this.consumeLine(line);
      newlineIndex = this.inputBuffer.indexOf('\n');
    }
  }

  private consumeLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // A malformed line is protocol noise; pending requests remain protected
      // by their timeout rather than being resolved with untrusted data.
      return;
    }
    if (!isRecord(message)) return;
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const request = this.pending.get(message.id);
      if (request === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if ('error' in message && isRecord(message.error)) {
        request.reject(new AppServerProtocolError(errorMessage(message.error)));
      } else {
        request.resolve(isRecord(message.result) ? message.result : {});
      }
      return;
    }
    if (typeof message.method !== 'string') return;
    const notification: AppServerNotification = {
      method: message.method,
      params: isRecord(message.params) ? message.params : {},
    };
    if (message.method === 'turn/completed' || message.method === 'turn/failed' || message.method === 'turn/aborted') {
      this.activeTurn = false;
    } else if (message.method === 'thread/status/changed') {
      const status = notification.params.status;
      if (typeof status === 'string' && /^(completed|failed|aborted|idle)$/i.test(status)) this.activeTurn = false;
    }
    this.onNotification?.(notification);
  }

  private failPending(error: Error): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(id);
    }
    this.activeTurn = false;
  }
}

function defaultSpawn(command: string, args: readonly string[], options: AppServerSpawnOptions): AppServerChild {
  const launch = windowsLaunch(command, args);
  return nodeSpawn(launch.command, launch.args, {
    stdio: [...options.stdio],
    windowsHide: options.windowsHide,
  }) as unknown as ChildProcessWithoutNullStreams;
}

function windowsLaunch(
  command: string,
  args: readonly string[],
): { readonly command: string; readonly args: readonly string[] } {
  if (process.platform !== 'win32' || /\.(?:com|exe)$/i.test(command)) {
    return { command, args: [...args] };
  }
  const commandLine = ['call', command, ...args].map(quoteWindowsCommandToken).join(' ');
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
  };
}

function quoteWindowsCommandToken(value: string): string {
  if (value.includes('\0') || value.includes('\r') || value.includes('\n') || value.includes('"')) {
    throw new TypeError('App Server command tokens cannot contain control characters or quotes');
  }
  return `"${value.replaceAll('%', '%%')}"`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} must be non-empty`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: Readonly<Record<string, unknown>>): string {
  if (typeof error.message === 'string') return error.message;
  return 'Codex App Server returned a JSON-RPC error';
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
