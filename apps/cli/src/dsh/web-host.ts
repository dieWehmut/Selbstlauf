import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Client for the DeepSeek Harness web host's own loopback RPC.
 *
 * The harness serves its browser UI from `127.0.0.1` and authenticates every
 * `/api` request with a signed cookie minted from the `browser-session`
 * credential the harness itself stores in `$DSH_HOME/.credentials.yaml`. The
 * watchdog reads that credential (read-only, never logged, never persisted) and
 * speaks the exact `session/prompt` call the harness UI makes, so a continuation
 * is admitted through the harness's own session controller instead of a
 * keyboard or a private side channel.
 *
 * Everything here fails closed: an unreadable credential, an origin that does
 * not answer like the harness, a malformed response, or a rejected prompt all
 * surface as a plain failure the caller turns into `monitor-only`.
 */

const CREDENTIALS_FILENAME = '.credentials.yaml';
const BROWSER_SESSION_KEY = 'client-connection/browser-session';
const AUTH_COOKIE_PREFIX = 'dsh-auth-';
const AUTH_MARKER = 'dsh web authentication required';
const SECRET_BYTES = 32;
const COOKIE_TTL_MS = 60 * 60 * 1_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export interface DshWebOrigin {
  readonly origin: string;
  readonly authority: string;
}

export interface DshPromptResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface DshHostClientOptions {
  /** `$DSH_HOME`; defaults to the ambient `DSH_HOME` or `~/.dsh`. */
  readonly homeDirectory: string;
  /** Injectable for tests: reads the browser-session secret from the home. */
  readonly readSecret?: (homeDirectory: string) => Promise<string | null>;
  /** Injectable for tests: performs one HTTP request. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests: current time. */
  readonly now?: () => number;
}

interface DshEnvelope {
  readonly type?: unknown;
  readonly result?: unknown;
}

/** Normalize the authority form the harness signs: `host` or `host:port`. */
export function authorityOf(origin: string): string {
  return new URL(origin).host;
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeSecret(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');
  if (decoded.byteLength !== SECRET_BYTES) return null;
  return base64Url(decoded) === value ? decoded : null;
}

/**
 * Read the harness's browser-session signing secret.
 *
 * The file is machine-written with a fixed shape, so the record is located by
 * its key and its `secret` member is read from that block alone. Any deviation
 * returns null rather than guessing — a wrong secret must never be used.
 */
export async function readBrowserSessionSecret(homeDirectory: string): Promise<string | null> {
  let document: string;
  try {
    document = await readFile(join(homeDirectory, CREDENTIALS_FILENAME), 'utf8');
  } catch {
    return null;
  }
  const lines = document.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^\s+client-connection\/browser-session:\s*$/u.test(line));
  if (start < 0) return null;
  const indent = /^(\s*)/u.exec(lines[start] ?? '')?.[1]?.length ?? 0;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) continue;
    const currentIndent = /^(\s*)/u.exec(line)?.[1]?.length ?? 0;
    if (currentIndent <= indent) break;
    const match = /^\s+secret:\s*(\S+)\s*$/u.exec(line);
    if (match !== null) {
      const secret = decodeSecret(match[1] ?? '');
      return secret === null ? null : base64Url(secret);
    }
  }
  return null;
}

/** One harvested credential plus the request headers that authenticate with it. */
export class DshWebSession {
  private constructor(
    private readonly authority: string,
    private readonly cookie: string,
  ) {}

  /**
   * Mint the authentication cookie for one origin from the harness secret.
   * @param origin - loopback origin of the harness web host.
   * @param secret - base64url browser-session secret.
   * @param nowMs - issue time; also bounds the cookie lifetime.
   * @returns the authenticated session, or null when the secret is unusable.
   */
  static create(origin: string, secret: string, nowMs: number): DshWebSession | null {
    const secretBytes = decodeSecret(secret);
    if (secretBytes === null) return null;
    const authority = authorityOf(origin);
    const body = base64Url(JSON.stringify({
      version: 1,
      authority,
      issuedAt: nowMs,
      expiresAt: nowMs + COOKIE_TTL_MS,
    }));
    const signature = base64Url(createHmac('sha256', secretBytes).update(body).digest());
    const name = `${AUTH_COOKIE_PREFIX}${base64Url(createHash('sha256').update(authority).digest())}`;
    return new DshWebSession(authority, `${name}=v1.${body}.${signature}`);
  }

  /** Headers carrying only the credential; the harness rejects cross-origin markers anyway. */
  headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      cookie: this.cookie,
    };
  }

  get audience(): string {
    return this.authority;
  }
}

/**
 * Resolves and caches the harness web origin for one host process, then admits
 * prompts through `session/prompt`.
 */
export class DshHostClient {
  private readonly homeDirectory: string;
  private readonly readSecret: (homeDirectory: string) => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private session: DshWebSession | null = null;
  private sessionOrigin: string | null = null;

  constructor(options: DshHostClientOptions) {
    this.homeDirectory = options.homeDirectory;
    this.readSecret = options.readSecret ?? readBrowserSessionSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * Probe one candidate origin for the harness fingerprint without touching the
   * credential store. Used when the watchdog only needs to know *where* the
   * harness is, such as while a dry run is in effect.
   * @param origin - candidate loopback origin.
   * @returns true when this origin answered as the harness.
   */
  async probe(origin: string): Promise<boolean> {
    const parsed = parseLoopbackOrigin(origin);
    if (parsed === null) return false;
    if (!await this.answersAsHarness(parsed.origin)) return false;
    this.sessionOrigin = parsed.origin;
    return true;
  }

  /**
   * Probe one candidate origin for the harness fingerprint and adopt it when the
   * credential is usable.
   * @param origin - candidate loopback origin.
   * @returns true when this origin answered as the harness and can be authenticated.
   */
  async adopt(origin: string): Promise<boolean> {
    const parsed = parseLoopbackOrigin(origin);
    if (parsed === null) return false;
    if (!await this.answersAsHarness(parsed.origin)) return false;

    const secret = await this.readSecret(this.homeDirectory);
    if (secret === null) return false;
    const session = DshWebSession.create(parsed.origin, secret, this.now());
    if (session === null) return false;
    this.session = session;
    this.sessionOrigin = parsed.origin;
    return true;
  }

  private async answersAsHarness(origin: string): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${origin}/`, { redirect: 'manual' });
    } catch {
      return false;
    }
    if (response.status !== 401) return false;
    const body = await response.text().catch(() => '');
    return body.includes(AUTH_MARKER);
  }

  /** The adopted origin, or null while no authenticated harness origin is known. */
  get origin(): string | null {
    return this.sessionOrigin;
  }

  /**
   * Admit one prompt into a harness session.
   * @param sessionId - harness session identity.
   * @param text - single-line continuation text.
   * @returns success, or a short reason the caller records and shows.
   */
  async prompt(sessionId: string, text: string): Promise<DshPromptResult> {
    const response = await this.call('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
    });
    if (!response.ok) return response;
    return { ok: true };
  }

  /**
   * Create one harness session for a workspace.
   *
   * Used by the continuation verification to own a disposable session instead
   * of writing into a session a person is working in.
   * @param cwd - workspace the session belongs to.
   * @returns the new session identity, or a short failure reason.
   */
  async createSession(cwd: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    const response = await this.call<{ sessionId?: unknown }>('session/create', { request: { cwd } });
    if (!response.ok) return response;
    const sessionId = response.value?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, error: 'harness did not return a session id' };
    }
    return { ok: true, sessionId };
  }

  /**
   * Cancel one session's active turn.
   *
   * The continuation verification uses this so proving the write path does not
   * leave an agent working on a throwaway task.
   * @param sessionId - harness session identity.
   * @returns success, or a short failure reason.
   */
  async cancelSession(sessionId: string): Promise<DshPromptResult> {
    const response = await this.call('session/cancel', { request: { sessionId } });
    return response.ok ? { ok: true } : { ok: false, error: response.error };
  }

  /**
   * Perform one authenticated `session` RPC call.
   * @param method - `session/<method>` endpoint name.
   * @param args - the named argument record the endpoint expects.
   * @returns the decoded success value, or a short failure reason.
   */
  private async call<T = unknown>(
    method: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; value: T | undefined } | { ok: false; error: string }> {
    const session = this.session;
    const origin = this.sessionOrigin;
    if (session === null || origin === null) {
      return { ok: false, error: 'no authenticated harness origin is available' };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${origin}/api/${method}`, {
        method: 'POST',
        headers: session.headers(),
        body: JSON.stringify({
          type: 'client-request',
          rpcId: randomUUID(),
          method,
          payload: { args },
        }),
      });
    } catch (error) {
      return { ok: false, error: `harness request failed: ${errorMessage(error)}` };
    }

    if (response.status === 401 || response.status === 403) {
      // The credential is no longer accepted: forget it so the next poll
      // re-resolves instead of retrying a rejected cookie forever.
      this.session = null;
      this.sessionOrigin = null;
      return { ok: false, error: 'harness rejected the local session credential' };
    }
    if (!response.ok) {
      return { ok: false, error: `harness answered HTTP ${response.status}` };
    }

    let envelope: DshEnvelope;
    try {
      envelope = await response.json() as DshEnvelope;
    } catch (error) {
      return { ok: false, error: `harness answered malformed JSON: ${errorMessage(error)}` };
    }
    if (envelope.type !== 'server-response') {
      return { ok: false, error: 'harness answered an unexpected envelope' };
    }
    const result = envelope.result as { ok?: unknown; value?: T; error?: { message?: unknown } } | null;
    if (result === null || typeof result !== 'object') {
      return { ok: false, error: 'harness answered without a result' };
    }
    if (result.ok === true) return { ok: true, value: result.value };
    const message = typeof result.error?.message === 'string'
      ? result.error.message
      : 'harness rejected the request';
    return { ok: false, error: message };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Accept only a loopback http origin; anything else is refused before probing. */
function parseLoopbackOrigin(origin: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  return parsed;
}