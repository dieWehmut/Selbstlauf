import { createHash } from 'node:crypto';

import {
  cannotInject,
  isValidPid,
  isValidPromptText,
  type ActivityResult,
  type ProbeResult,
  type PtyTransportOptions,
  type SessionTransport,
  type WriteResult,
} from './transport.js';

function asBytes(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

function nextFingerprint(previous: string, chunk: Buffer): string {
  return createHash('sha256')
    .update(previous, 'utf8')
    .update(chunk)
    .digest('hex');
}

export class PtyTransport implements SessionTransport {
  readonly #pid: number;
  readonly #input: NodeJS.WritableStream;
  readonly #output: NodeJS.ReadableStream;
  #fingerprint = createHash('sha256').update('pty:empty', 'utf8').digest('hex');
  #closedReason: string | null = null;

  constructor(options: PtyTransportOptions) {
    if (!isValidPid(options.pid)) {
      throw new RangeError('PTY transport requires a positive owner PID.');
    }
    this.#pid = options.pid;
    this.#input = options.input;
    this.#output = options.output;
    this.#output.on('data', (chunk: unknown) => {
      this.#fingerprint = nextFingerprint(this.#fingerprint, asBytes(chunk));
    });
    this.#input.on('finish', () => {
      this.#markClosed('The owned PTY input stream is closed.');
    });
    this.#input.on('close', () => {
      this.#markClosed('The owned PTY input stream is closed.');
    });
    this.#input.on('error', (error: Error) => {
      this.#markClosed(error.message || 'The owned PTY input stream failed.');
    });
    this.#output.on('end', () => {
      this.#markClosed('The owned PTY output stream is closed.');
    });
    this.#output.on('close', () => {
      this.#markClosed('The owned PTY output stream is closed.');
    });
    this.#output.on('error', (error: Error) => {
      this.#markClosed(error.message || 'The owned PTY output stream failed.');
    });
  }

  async probe(pid: number): Promise<ProbeResult> {
    const mismatch = this.#validatePid(pid);
    if (mismatch) return mismatch;
    if (this.#closedReason) {
      return cannotInject(pid, 'transport-closed', this.#closedReason);
    }
    return { ok: true, kind: 'pty', pid };
  }

  async activityFingerprint(pid: number): Promise<ActivityResult> {
    const mismatch = this.#validatePid(pid);
    if (mismatch) return mismatch;
    if (this.#closedReason) {
      return cannotInject(pid, 'transport-closed', this.#closedReason);
    }
    return {
      ok: true,
      kind: 'pty',
      pid,
      fingerprint: this.#fingerprint,
    };
  }

  async write(pid: number, text: string): Promise<WriteResult> {
    const mismatch = this.#validatePid(pid);
    if (mismatch) return mismatch;
    if (!isValidPromptText(text)) {
      return cannotInject(pid, 'invalid-text', 'Prompt text must be non-empty and single-line.');
    }
    if (this.#closedReason) {
      return cannotInject(pid, 'transport-closed', this.#closedReason);
    }

    return await new Promise<WriteResult>((resolve) => {
      try {
        this.#input.write(`${text}\r`, (error?: Error | null) => {
          if (error) {
            resolve(cannotInject(pid, 'write-failed', error.message));
            return;
          }
          resolve({ ok: true, kind: 'pty', pid });
        });
      } catch (error) {
        resolve(cannotInject(
          pid,
          'write-failed',
          error instanceof Error ? error.message : 'PTY input write failed.',
        ));
      }
    });
  }

  #validatePid(pid: number) {
    if (!isValidPid(pid)) {
      return cannotInject(pid, 'invalid-pid', 'Target PID must be a positive Windows process ID.');
    }
    if (pid !== this.#pid) {
      return cannotInject(pid, 'pid-mismatch', 'PTY is owned by a different process ID.');
    }
    return null;
  }

  #markClosed(reason: string): void {
    this.#closedReason ??= reason;
  }
}
