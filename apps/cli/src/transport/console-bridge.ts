import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cannotInject,
  isValidPid,
  isValidPromptText,
  type ActivityResult,
  type BridgeProcessOptions,
  type CannotInjectResult,
  type ConsoleTransportOptions,
  type ProbeResult,
  type SessionTransport,
  type TransportErrorInfo,
  type WriteResult,
} from './transport.js';

type BridgeCommand = 'probe' | 'snapshot' | 'write';

interface BridgeRequest {
  readonly command: BridgeCommand;
  readonly pid: number;
  readonly text?: string;
}

interface BridgeResponse {
  readonly ok?: unknown;
  readonly kind?: unknown;
  readonly command?: unknown;
  readonly pid?: unknown;
  readonly consoleProcessIds?: unknown;
  readonly fingerprint?: unknown;
  readonly recordsWritten?: unknown;
  readonly error?: unknown;
}

interface ValidatedBridgeSuccess {
  readonly ok: true;
  readonly kind: 'classic-console';
  readonly command: BridgeCommand;
  readonly pid: number;
  readonly consoleProcessIds?: unknown;
  readonly fingerprint?: unknown;
  readonly recordsWritten?: unknown;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

function defaultBridge(): BridgeProcessOptions {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = process.platform === 'win32'
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const scriptPath = fileURLToPath(
    new URL('../../../../../native/windows/ConsoleBridge.ps1', import.meta.url),
  );
  return {
    command: powershell,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asErrorInfo(value: unknown): TransportErrorInfo {
  if (!isRecord(value)) {
    return {
      code: 'bridge-protocol',
      message: 'ConsoleBridge returned an invalid error object.',
    };
  }
  const code = typeof value.code === 'string' && value.code.length > 0
    ? value.code
    : 'bridge-protocol';
  const message = typeof value.message === 'string' && value.message.length > 0
    ? value.message
    : 'ConsoleBridge returned an invalid error message.';
  const nativeErrorCode = typeof value.nativeErrorCode === 'number' &&
      Number.isInteger(value.nativeErrorCode)
    ? value.nativeErrorCode
    : undefined;
  return nativeErrorCode === undefined
    ? { code, message }
    : { code, message, nativeErrorCode };
}

function protocolFailure(
  pid: number,
  message: string,
): CannotInjectResult {
  return cannotInject(pid, 'bridge-protocol', message);
}

function validateResponse(
  raw: string,
  request: BridgeRequest,
): ValidatedBridgeSuccess | CannotInjectResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return protocolFailure(request.pid, 'ConsoleBridge returned no response.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return protocolFailure(request.pid, 'ConsoleBridge returned invalid JSON.');
  }
  if (!isRecord(parsed)) {
    return protocolFailure(request.pid, 'ConsoleBridge response is not an object.');
  }

  const response = parsed as BridgeResponse;
  if (response.pid !== request.pid || response.command !== request.command) {
    return protocolFailure(
      request.pid,
      'ConsoleBridge response did not match the requested PID and command.',
    );
  }
  if (response.ok === false) {
    if (response.kind !== 'cannot-inject') {
      return protocolFailure(
        request.pid,
        'ConsoleBridge failure response reported an unsupported kind.',
      );
    }
    const errorInfo = asErrorInfo(response.error);
    return cannotInject(
      request.pid,
      errorInfo.code,
      errorInfo.message,
      errorInfo.nativeErrorCode,
    );
  }
  if (response.ok !== true) {
    return protocolFailure(request.pid, 'ConsoleBridge response omitted ok.');
  }
  if (response.kind !== 'classic-console') {
    return protocolFailure(
      request.pid,
      'ConsoleBridge reported an unsupported transport kind.',
    );
  }
  return {
    ok: true,
    kind: 'classic-console',
    command: request.command,
    pid: request.pid,
    consoleProcessIds: response.consoleProcessIds,
    fingerprint: response.fingerprint,
    recordsWritten: response.recordsWritten,
  };
}

export class ConsoleTransport implements SessionTransport {
  readonly #bridge: BridgeProcessOptions;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: ConsoleTransportOptions = {}) {
    this.#bridge = options.bridge ?? defaultBridge();
    this.#timeoutMs = Number.isFinite(options.timeoutMs) &&
        (options.timeoutMs ?? 0) > 0
      ? Math.floor(options.timeoutMs as number)
      : DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = Number.isFinite(options.maxResponseBytes) &&
        (options.maxResponseBytes ?? 0) > 0
      ? Math.floor(options.maxResponseBytes as number)
      : DEFAULT_MAX_RESPONSE_BYTES;
  }

  async probe(pid: number): Promise<ProbeResult> {
    const response = await this.#invoke({ command: 'probe', pid });
    if (!response.ok) return response;
    if (!Array.isArray(response.consoleProcessIds) ||
        response.consoleProcessIds.length === 0 ||
        !response.consoleProcessIds.every(isValidPid) ||
        !response.consoleProcessIds.includes(pid)) {
      return protocolFailure(pid, 'ConsoleBridge returned invalid console process IDs.');
    }
    return {
      ok: true,
      kind: 'classic-console',
      pid,
      consoleProcessIds: response.consoleProcessIds,
    };
  }

  async activityFingerprint(pid: number): Promise<ActivityResult> {
    const response = await this.#invoke({ command: 'snapshot', pid });
    if (!response.ok) return response;
    if (typeof response.fingerprint !== 'string' ||
        response.fingerprint.length === 0) {
      return protocolFailure(pid, 'ConsoleBridge returned an empty fingerprint.');
    }
    return {
      ok: true,
      kind: 'classic-console',
      pid,
      fingerprint: response.fingerprint,
    };
  }

  async write(pid: number, text: string): Promise<WriteResult> {
    const response = await this.#invoke({ command: 'write', pid, text });
    if (!response.ok) return response;
    if (typeof response.recordsWritten !== 'number' ||
        !Number.isInteger(response.recordsWritten) ||
        response.recordsWritten <= 0) {
      return protocolFailure(pid, 'ConsoleBridge returned an invalid write count.');
    }
    return {
      ok: true,
      kind: 'classic-console',
      pid,
      recordsWritten: response.recordsWritten,
    };
  }

  async #invoke(
    request: BridgeRequest,
  ): Promise<ValidatedBridgeSuccess | CannotInjectResult> {
    if (!isValidPid(request.pid)) {
      return cannotInject(request.pid, 'invalid-pid', 'Target PID must be a positive Windows process ID.');
    }
    if (request.command === 'write' &&
        (typeof request.text !== 'string' || !isValidPromptText(request.text))) {
      return cannotInject(request.pid, 'invalid-text', 'Prompt text must be non-empty and single-line.');
    }

    const args = [...(this.#bridge.args ?? [])];
    let child;
    try {
      child = spawn(this.#bridge.command, args, {
        env: this.#bridge.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return cannotInject(
        request.pid,
        'bridge-unavailable',
        error instanceof Error ? error.message : 'ConsoleBridge could not start.',
      );
    }

    return await new Promise<ValidatedBridgeSuccess | CannotInjectResult>((resolve) => {
      let settled = false;
      let stdoutBytes = 0;
      const stdout: Buffer[] = [];
      const settle = (result: ValidatedBridgeSuccess | CannotInjectResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const fail = (
        code: string,
        message: string,
      ): void => settle(cannotInject(request.pid, code, message));
      const timeout = setTimeout(() => {
        child.kill();
        fail('bridge-timeout', 'ConsoleBridge did not respond before the timeout.');
      }, this.#timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, 'utf8');
        stdoutBytes += bytes.byteLength;
        if (stdoutBytes > this.#maxResponseBytes) {
          child.kill();
          fail('bridge-protocol', 'ConsoleBridge response exceeded the size limit.');
          return;
        }
        stdout.push(bytes);
      });
      // Consume stderr so an uncooperative bridge cannot block on a full pipe.
      child.stderr?.on('data', () => undefined);
      child.stdin?.once('error', () => {
        fail('bridge-exit', 'ConsoleBridge stdin closed before the request was sent.');
      });
      child.once('error', (error: Error) => {
        fail('bridge-unavailable', error.message || 'ConsoleBridge could not start.');
      });
      child.once('close', (code: number | null) => {
        if (settled) return;
        if (code !== 0) {
          fail('bridge-exit', `ConsoleBridge exited with code ${code ?? 'unknown'}.`);
          return;
        }
        const response = validateResponse(
          Buffer.concat(stdout).toString('utf8'),
          request,
        );
        settle(response);
      });

      try {
        child.stdin?.end(`${JSON.stringify(request)}\n`);
      } catch (error) {
        fail(
          'bridge-exit',
          error instanceof Error ? error.message : 'ConsoleBridge stdin failed.',
        );
      }
    });
  }
}
