import type { TransportKind } from '../domain/types.js';

export type InjectableTransportKind = Extract<
  TransportKind,
  'classic-console' | 'pty'
>;

export type TransportErrorCode =
  | 'invalid-pid'
  | 'invalid-text'
  | 'pid-mismatch'
  | 'bridge-unavailable'
  | 'bridge-timeout'
  | 'bridge-protocol'
  | 'bridge-exit'
  | 'attach-failed'
  | 'transport-closed'
  | 'write-failed';

export interface TransportErrorInfo {
  readonly code: TransportErrorCode | string;
  readonly message: string;
  readonly nativeErrorCode?: number;
}

export interface CannotInjectResult {
  readonly ok: false;
  readonly kind: 'cannot-inject';
  readonly pid: number;
  readonly error: TransportErrorInfo;
}

export interface ProbeSuccess {
  readonly ok: true;
  readonly kind: InjectableTransportKind;
  readonly pid: number;
  readonly consoleProcessIds?: readonly number[];
}

export interface ActivitySuccess {
  readonly ok: true;
  readonly kind: InjectableTransportKind;
  readonly pid: number;
  readonly fingerprint: string;
}

export interface WriteSuccess {
  readonly ok: true;
  readonly kind: InjectableTransportKind;
  readonly pid: number;
  readonly recordsWritten?: number;
}

export type ProbeResult = ProbeSuccess | CannotInjectResult;
export type ActivityResult = ActivitySuccess | CannotInjectResult;
export type WriteResult = WriteSuccess | CannotInjectResult;

export interface SessionTransport {
  probe(pid: number): Promise<ProbeResult>;
  activityFingerprint(pid: number): Promise<ActivityResult>;
  write(pid: number, text: string): Promise<WriteResult>;
}

export interface BridgeProcessOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export interface ConsoleTransportOptions {
  readonly bridge?: BridgeProcessOptions;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface PtyTransportOptions {
  readonly pid: number;
  readonly input: NodeJS.WritableStream;
  readonly output: NodeJS.ReadableStream;
}

export function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffff_ffff;
}

export function isValidPromptText(text: string): boolean {
  return text.length > 0 && !/[\u0000\r\n]/u.test(text);
}

export function cannotInject(
  pid: number,
  code: TransportErrorCode | string,
  message: string,
  nativeErrorCode?: number,
): CannotInjectResult {
  const error: TransportErrorInfo = nativeErrorCode === undefined
    ? { code, message }
    : { code, message, nativeErrorCode };
  return { ok: false, kind: 'cannot-inject', pid, error };
}
