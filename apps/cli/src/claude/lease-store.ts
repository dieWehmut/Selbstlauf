import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve, win32 } from 'node:path';

import { isValidPid, isValidPromptText } from '../transport/transport.js';

const SCHEMA_VERSION = 1 as const;
const MAX_IDENTITY_LENGTH = 512;
const MAX_PROMPT_LENGTH = 8_192;
const LOCK_RETRY_MS = 5;
const LOCK_TIMEOUT_MS = 10_000;

export interface ClaudeActivityFingerprint {
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ClaudeLeaseRequest {
  readonly sessionId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly rootPid: number;
  readonly processStartedAtMs: number;
  readonly activity: ClaudeActivityFingerprint;
  readonly ttlMs: number;
  readonly transcriptPath?: string | null;
}

export interface ClaudeContinuationLease {
  readonly id: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly rootPid: number;
  readonly processStartedAtMs: number;
  readonly activity: ClaudeActivityFingerprint;
  readonly transcriptPath: string | null;
  readonly armedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ClaudeLeaseConsumeRequest {
  readonly sessionId: string;
  readonly cwd: string;
  readonly processStartedAtMs?: number;
  readonly activity?: ClaudeActivityFingerprint | null;
  readonly transcriptPath?: string | null;
}

interface LeaseDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly leases: readonly ClaudeContinuationLease[];
}

const pathQueues = new Map<string, Promise<void>>();

/** A small cross-process, one-shot lease store used by the watchdog and hook CLI. */
export class ClaudeLeaseStore {
  public readonly path: string;
  private readonly lockPath: string;
  private readonly now: () => number;

  public constructor(path: string, options: { readonly now?: () => number } = {}) {
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new TypeError('lease path must be a non-empty string');
    }
    this.path = resolve(path);
    this.lockPath = `${this.path}.lock`;
    this.now = options.now ?? Date.now;
  }

  public async arm(request: ClaudeLeaseRequest): Promise<ClaudeContinuationLease> {
    const normalized = validateRequest(request);
    return this.withLock(async () => {
      const timestamp = this.now();
      const current = await this.readDocument();
      const active = current.leases.filter((lease) => lease.expiresAtMs > timestamp);
      const lease: ClaudeContinuationLease = Object.freeze({
        id: randomUUID(),
        sessionId: normalized.sessionId,
        cwd: normalized.cwd,
        prompt: normalized.prompt,
        rootPid: normalized.rootPid,
        processStartedAtMs: normalized.processStartedAtMs,
        activity: normalized.activity,
        transcriptPath: normalized.transcriptPath,
        armedAtMs: timestamp,
        expiresAtMs: timestamp + normalized.ttlMs,
      });
      const withoutSameIdentity = active.filter((candidate) => !sameIdentity(candidate, lease));
      await this.writeDocument({ schemaVersion: SCHEMA_VERSION, leases: [...withoutSameIdentity, lease] });
      return lease;
    });
  }

  public async consume(request: ClaudeLeaseConsumeRequest): Promise<ClaudeContinuationLease | null> {
    const normalized = validateConsumeRequest(request);
    return this.withLock(async () => {
      const timestamp = this.now();
      const current = await this.readDocument();
      const active = current.leases.filter((lease) => lease.expiresAtMs > timestamp);
      const candidates = active.filter((lease) => matchesIdentity(lease, normalized));
      let remaining = active;
      if (candidates.length === 1) {
        const candidate = candidates[0];
        if (normalized.activity !== undefined && normalized.activity !== null &&
            !sameActivity(candidate.activity, normalized.activity)) {
          remaining = active.filter((lease) => lease.id !== candidate.id);
        } else if (normalized.transcriptPath !== undefined &&
                   normalizeOptionalPath(normalized.transcriptPath) !== candidate.transcriptPath) {
          return null;
        } else {
          remaining = active.filter((lease) => lease.id !== candidate.id);
          await this.writeDocument({ schemaVersion: SCHEMA_VERSION, leases: remaining });
          return candidate;
        }
      }
      if (remaining.length !== current.leases.length) {
        await this.writeDocument({ schemaVersion: SCHEMA_VERSION, leases: remaining });
      }
      return null;
    });
  }

  public async list(): Promise<readonly ClaudeContinuationLease[]> {
    return this.withLock(async () => {
      const timestamp = this.now();
      const current = await this.readDocument();
      const active = current.leases.filter((lease) => lease.expiresAtMs > timestamp);
      if (active.length !== current.leases.length) {
        await this.writeDocument({ schemaVersion: SCHEMA_VERSION, leases: active });
      }
      return Object.freeze(active.map((lease) => Object.freeze({ ...lease })));
    });
  }

  public async clearSession(sessionId: string): Promise<void> {
    const normalized = validateSessionId(sessionId);
    await this.withLock(async () => {
      const current = await this.readDocument();
      const remaining = current.leases.filter((lease) => lease.sessionId !== normalized);
      if (remaining.length !== current.leases.length) {
        await this.writeDocument({ schemaVersion: SCHEMA_VERSION, leases: remaining });
      }
    });
  }

  public async clearAll(): Promise<void> {
    await this.withLock(async () => {
      const current = await this.readDocument();
      if (current.leases.length > 0) await this.writeDocument({ schemaVersion: SCHEMA_VERSION, leases: [] });
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const key = this.path.toLocaleLowerCase();
    const previous = pathQueues.get(key) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const current = new Promise<void>((resolveQueue) => { releaseQueue = resolveQueue; });
    const queued = previous.then(() => current);
    pathQueues.set(key, queued);
    await previous;
    let lockHandle;
    try {
      lockHandle = await acquireLock(this.lockPath);
      return await operation();
    } finally {
      await lockHandle?.close().catch(() => undefined);
      await rm(this.lockPath, { force: true }).catch(() => undefined);
      releaseQueue();
      if (pathQueues.get(key) === queued) pathQueues.delete(key);
    }
  }

  private async readDocument(): Promise<LeaseDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      return parseDocument(parsed);
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: SCHEMA_VERSION, leases: [] };
      throw error;
    }
  }

  private async writeDocument(document: LeaseDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await replaceAtomically(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

interface RawLeaseRequest {
  readonly sessionId: unknown;
  readonly cwd: unknown;
  readonly prompt: unknown;
  readonly rootPid: unknown;
  readonly processStartedAtMs: unknown;
  readonly activity: unknown;
  readonly ttlMs: unknown;
  readonly transcriptPath?: unknown;
}

function validateRequest(request: RawLeaseRequest): Omit<ClaudeContinuationLease, 'id' | 'armedAtMs' | 'expiresAtMs'> & { ttlMs: number } {
  if (!request || typeof request !== 'object') throw new TypeError('lease request must be an object');
  const sessionId = validateSessionId(request.sessionId);
  const cwd = normalizeCwd(request.cwd);
  const prompt = validatePrompt(request.prompt);
  if (typeof request.rootPid !== 'number' || !isValidPid(request.rootPid)) throw new RangeError('rootPid must be a valid PID');
  const processStartedAtMs = validateTimestamp(request.processStartedAtMs, 'processStartedAtMs');
  const activity = validateActivity(request.activity);
  const ttlMs = validatePositiveInteger(request.ttlMs, 'ttlMs');
  return {
    sessionId,
    cwd,
    prompt,
    rootPid: request.rootPid,
    processStartedAtMs,
    activity,
    ttlMs,
    transcriptPath: normalizeOptionalPath(request.transcriptPath),
  };
}

function validateConsumeRequest(request: ClaudeLeaseConsumeRequest): ClaudeLeaseConsumeRequest & {
  readonly sessionId: string;
  readonly cwd: string;
  readonly processStartedAtMs?: number;
  readonly transcriptPath?: string | null;
} {
  if (!request || typeof request !== 'object') throw new TypeError('consume request must be an object');
  return {
    ...request,
    sessionId: validateSessionId(request.sessionId),
    cwd: normalizeCwd(request.cwd),
    processStartedAtMs: request.processStartedAtMs === undefined
      ? undefined
      : validateTimestamp(request.processStartedAtMs, 'processStartedAtMs'),
    activity: request.activity === undefined || request.activity === null
      ? request.activity
      : validateActivity(request.activity),
    transcriptPath: request.transcriptPath === undefined
      ? undefined
      : normalizeOptionalPath(request.transcriptPath),
  };
}

function parseDocument(value: unknown): LeaseDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('lease document must be an object');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SCHEMA_VERSION || !Array.isArray(record.leases)) {
    throw new TypeError('lease document schema is invalid');
  }
  const leases = record.leases.map((entry) => parseLease(entry));
  return { schemaVersion: SCHEMA_VERSION, leases: Object.freeze(leases) };
}

function parseLease(value: unknown): ClaudeContinuationLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('lease entry must be an object');
  const entry = value as Record<string, unknown>;
  const base = validateRequest({
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    prompt: entry.prompt,
    rootPid: entry.rootPid,
    processStartedAtMs: entry.processStartedAtMs,
    activity: entry.activity,
    ttlMs: Number(entry.expiresAtMs) - Number(entry.armedAtMs),
    transcriptPath: entry.transcriptPath as string | null | undefined,
  });
  if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > MAX_IDENTITY_LENGTH) {
    throw new TypeError('lease id is invalid');
  }
  const armedAtMs = validateTimestamp(entry.armedAtMs, 'armedAtMs');
  const expiresAtMs = validateTimestamp(entry.expiresAtMs, 'expiresAtMs');
  if (expiresAtMs <= armedAtMs) throw new RangeError('lease expiry must be after arming');
  return Object.freeze({ ...base, id: entry.id, armedAtMs, expiresAtMs });
}

function matchesIdentity(lease: ClaudeContinuationLease, request: ClaudeLeaseConsumeRequest): boolean {
  if (lease.sessionId !== request.sessionId || lease.cwd !== request.cwd) return false;
  if (request.processStartedAtMs !== undefined && lease.processStartedAtMs !== request.processStartedAtMs) return false;
  return request.transcriptPath === undefined || normalizeOptionalPath(request.transcriptPath) === lease.transcriptPath;
}

function sameIdentity(left: ClaudeContinuationLease, right: ClaudeContinuationLease): boolean {
  return left.sessionId === right.sessionId && left.cwd === right.cwd &&
    left.rootPid === right.rootPid && left.processStartedAtMs === right.processStartedAtMs;
}

function sameActivity(left: ClaudeActivityFingerprint, right: ClaudeActivityFingerprint): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function validateSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_IDENTITY_LENGTH || /[\u0000\r\n]/u.test(value)) {
    throw new TypeError('sessionId must be a bounded non-empty string');
  }
  return value.trim();
}

function validatePrompt(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_PROMPT_LENGTH || !isValidPromptText(value)) {
    throw new TypeError('prompt must be bounded single-line text');
  }
  return value;
}

function normalizeCwd(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_IDENTITY_LENGTH || /[\u0000\r\n]/u.test(value)) {
    throw new TypeError('cwd must be a bounded absolute path');
  }
  const trimmed = value.trim();
  if (win32.isAbsolute(trimmed)) return trimRoot(win32.normalize(trimmed).toLocaleLowerCase());
  if (isAbsolute(trimmed)) return normalize(trimmed);
  throw new TypeError('cwd must be an absolute path');
}

function normalizeOptionalPath(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_IDENTITY_LENGTH) {
    throw new TypeError('transcriptPath must be a bounded path');
  }
  const trimmed = value.trim();
  if (win32.isAbsolute(trimmed)) return trimRoot(win32.normalize(trimmed).toLocaleLowerCase());
  if (isAbsolute(trimmed)) return normalize(trimmed);
  throw new TypeError('transcriptPath must be an absolute path');
}

function trimRoot(value: string): string {
  if (/^[a-z]:\\$/iu.test(value) || value === '\\\\') return value;
  return value.replace(/[\\]+$/u, '');
}

function validateActivity(value: unknown): ClaudeActivityFingerprint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('activity must be an object');
  const entry = value as Record<string, unknown>;
  if (typeof entry.size !== 'number' || !Number.isFinite(entry.size) || entry.size < 0 ||
      typeof entry.mtimeMs !== 'number' || !Number.isFinite(entry.mtimeMs) || entry.mtimeMs < 0) {
    throw new TypeError('activity must contain non-negative finite size and mtimeMs');
  }
  return Object.freeze({ size: entry.size, mtimeMs: entry.mtimeMs });
}

function validateTimestamp(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`);
  return value;
}

function validatePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

async function acquireLock(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      return await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (Date.now() >= deadline) throw new Error('timed out acquiring Claude lease lock');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
    }
  }
}

async function replaceAtomically(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const backup = `${destination}.${randomUUID()}.bak`;
  await rename(destination, backup);
  try {
    await rename(source, destination);
  } catch (error) {
    await rename(backup, destination).catch(() => undefined);
    throw error;
  }
  await rm(backup, { force: true });
}

function isMissing(error: unknown): boolean {
  return isCode(error, 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return isCode(error, 'EEXIST') || isCode(error, 'EPERM') || isCode(error, 'ENOTEMPTY');
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === code);
}
