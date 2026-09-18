import type { DshHostClient } from '../dsh/web-host.js';
import {
  cannotInject,
  isValidPid,
  isValidPromptText,
  type ActivityResult,
  type InjectableTransportKind,
  type ProbeResult,
  type SessionTransport,
  type WriteResult,
} from './transport.js';

export interface DshWebTransportOptions {
  /** The harness host root process this session belongs to. */
  readonly pid: number;
  /** The harness session the continuation is admitted into. */
  readonly sessionId: string;
  /** Authenticated client for the harness web host. */
  readonly client: DshHostClient;
  /**
   * Whether the harness session currently has no unfinished step. A running
   * step is never interrupted: the harness would treat the text as a queued
   * follow-up, and interrupting an agent mid-step is not what a continuation is.
   */
  readonly isIdle: () => boolean;
}

const KIND: InjectableTransportKind = 'dsh-web';

/**
 * Continuation transport for one DeepSeek Harness session.
 *
 * The harness has no console and no PID-scoped input channel: a session is
 * addressed by its own identity and its owner is the long-lived `web` host. This
 * adapter therefore validates the host PID it was bound to and admits the
 * continuation through the harness's own session RPC.
 *
 * Activity is deliberately not reported here — the session projection's event
 * sequence is the authoritative activity signal, and a constant fingerprint
 * keeps this adapter from double-counting it.
 */
export class DshWebTransport implements SessionTransport {
  readonly #pid: number;
  readonly #sessionId: string;
  readonly #client: DshHostClient;
  readonly #isIdle: () => boolean;

  constructor(options: DshWebTransportOptions) {
    if (!isValidPid(options.pid)) {
      throw new RangeError('DeepSeek Harness transport requires the host root PID.');
    }
    if (typeof options.sessionId !== 'string' || options.sessionId.trim().length === 0) {
      throw new TypeError('DeepSeek Harness transport requires a session id.');
    }
    this.#pid = options.pid;
    this.#sessionId = options.sessionId;
    this.#client = options.client;
    this.#isIdle = options.isIdle;
  }

  async probe(pid: number): Promise<ProbeResult> {
    const rejection = this.#validate(pid);
    if (rejection !== null) return rejection;
    if (this.#client.origin === null) {
      return cannotInject(pid, 'attach-failed', 'No authenticated DeepSeek Harness origin is available.');
    }
    return { ok: true, kind: KIND, pid };
  }

  async activityFingerprint(pid: number): Promise<ActivityResult> {
    const rejection = this.#validate(pid);
    if (rejection !== null) return rejection;
    return { ok: true, kind: KIND, pid, fingerprint: 'dsh-web' };
  }

  async write(pid: number, text: string): Promise<WriteResult> {
    const rejection = this.#validate(pid);
    if (rejection !== null) return rejection;
    if (!isValidPromptText(text)) {
      return cannotInject(pid, 'invalid-text', 'Prompt text must be non-empty and single-line.');
    }
    if (!this.#isIdle()) {
      return cannotInject(pid, 'write-failed', 'The harness session still has an unfinished step.');
    }

    const result = await this.#client.prompt(this.#sessionId, text);
    if (result.ok) return { ok: true, kind: KIND, pid };
    return cannotInject(pid, 'write-failed', result.error ?? 'The harness rejected the prompt.');
  }

  #validate(pid: number): ProbeResult & { ok: false } | null {
    if (!isValidPid(pid)) {
      return cannotInject(pid, 'invalid-pid', 'Target PID must be a positive Windows process ID.');
    }
    if (pid !== this.#pid) {
      return cannotInject(pid, 'pid-mismatch', 'DeepSeek Harness session belongs to a different host process.');
    }
    return null;
  }
}