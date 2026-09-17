import { open, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { createZstdDecompress } from 'node:zlib';

/**
 * The DeepSeek Harness (`dsh`) keeps one materialized directory per logical
 * session below `$DSH_HOME/sessions/<project-key>/<session-id>/`, and mirrors
 * the live session projection below
 * `$DSH_HOME/storages/session_projcache/sessions/<session-id>.json`.
 *
 * The projection is the only authoritative local statement of whether a
 * session is running, idle, or empty, so it is preferred over the transcript.
 * Both sources are read-only: the watchdog never appends to harness state.
 */
export interface DshSessionFile {
  readonly sessionId: string;
  /** The `--<project>--` directory name the harness derived from the cwd. */
  readonly projectKey: string;
  readonly transcriptPath: string | null;
  readonly transcriptSize: number | null;
  readonly transcriptMtimeMs: number | null;
  readonly projectionPath: string | null;
  readonly projectionMtimeMs: number | null;
  readonly cwd: string | null;
  readonly createdAtMs: number | null;
  readonly lastPromptAtMs: number | null;
  /** Monotonic event sequence of the newest projected event, when known. */
  readonly sequence: number | null;
  /** True while the newest projected step has started and not yet finished. */
  readonly turnOpen: boolean;
  readonly turnCount: number | null;
  /** True for a session that never received a prompt. */
  readonly blank: boolean;
}

export interface DshSessionIndexOptions {
  /** Override for `$DSH_HOME`; defaults to the caller-provided home. */
  readonly homeDirectory: string;
}

export interface DshSessionLivenessOptions {
  readonly nowMs: number;
  /** Sessions quieter than this are history rather than live agents. */
  readonly windowMs: number;
  /** The oldest DSH host start that may own the session. */
  readonly hostStartedAtMs?: number | null;
}

export interface DshSessionActivity {
  readonly sequence: number | null;
  readonly transcriptSize: number | null;
  readonly transcriptMtimeMs: number | null;
}

const TRANSCRIPT_DIRECTORY = 'sessions';
const PROJECTION_DIRECTORY = join('storages', 'session_projcache', 'sessions');
const SESSION_ID_PATTERN = /^session-[0-9a-f-]{8,}$/iu;
const TRANSCRIPT_NAMES = ['session.v3.jsonl.zstd', 'session.v3.jsonl'] as const;
const DEFAULT_HEADER_OUTPUT_LIMIT = 4 * 1_024 * 1_024;

/**
 * The harness's readable project directory key. Filesystem and drive
 * separators collapse to one `-`, unsupported code units escape as `~XXXX`,
 * leading separators drop, and the result is wrapped in `--`.
 */
export function dshProjectKey(cwd: string): string {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('cannot encode an empty project path');
  }
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (character !== '~' && /^[A-Za-z0-9._-]$/u.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/u, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

/** The newest observed activity timestamp for a session, or null when unknown. */
export function dshSessionActivityMs(session: DshSessionFile): number | null {
  const candidates = [session.transcriptMtimeMs, session.projectionMtimeMs]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return candidates.length === 0 ? null : Math.max(...candidates);
}

export function dshSessionActivity(session: DshSessionFile): DshSessionActivity {
  return {
    sequence: session.sequence,
    transcriptSize: session.transcriptSize,
    transcriptMtimeMs: session.transcriptMtimeMs,
  };
}

export function hasDshSessionActivity(
  previous: DshSessionActivity,
  current: DshSessionActivity,
): boolean {
  if (previous.sequence !== current.sequence) return true;
  if (previous.transcriptSize !== current.transcriptSize) return true;
  return (
    previous.transcriptMtimeMs !== null &&
    current.transcriptMtimeMs !== null &&
    current.transcriptMtimeMs > previous.transcriptMtimeMs
  );
}

/**
 * Whether a materialized session is still a live agent rather than history.
 *
 * A session counts as live when the harness recorded something for it after
 * the oldest running host started, and within the configured activity window.
 * A blank session, or one whose transcript directory cannot be read, never
 * becomes a monitored row.
 */
export function isLiveDshSession(
  session: DshSessionFile,
  options: DshSessionLivenessOptions,
): boolean {
  if (session.blank) return false;
  if (session.cwd === null) return false;
  const activityMs = dshSessionActivityMs(session);
  if (activityMs === null) return false;
  if (options.nowMs - activityMs > options.windowMs) return false;
  const hostStartedAtMs = options.hostStartedAtMs ?? null;
  if (hostStartedAtMs !== null && activityMs < hostStartedAtMs) return false;
  return true;
}

/** Read every materialized session below the harness home. */
export async function scanDshSessions(
  options: DshSessionIndexOptions,
): Promise<readonly DshSessionFile[]> {
  const sessionsRoot = join(options.homeDirectory, TRANSCRIPT_DIRECTORY);
  const projectionRoot = join(options.homeDirectory, PROJECTION_DIRECTORY);
  const projections = await readProjections(projectionRoot);
  const sessions: DshSessionFile[] = [];
  const seen = new Set<string>();

  let projectKeys: Dirent[];
  try {
    projectKeys = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    projectKeys = [];
  }

  for (const project of projectKeys) {
    if (!project.isDirectory()) continue;
    const projectKey = project.name;
    const projectDirectory = join(sessionsRoot, projectKey);
    let entries;
    try {
      entries = await readdir(projectDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name)) continue;
      const sessionId = entry.name;
      const directory = join(projectDirectory, sessionId);
      const transcript = await readTranscript(directory, sessionId);
      if (transcript === null) continue;
      seen.add(sessionId);
      sessions.push(await buildSession({
        sessionId,
        projectKey,
        transcript,
        projection: projections.get(sessionId) ?? null,
      }));
    }
  }

  // A projection without a materialized directory still describes a session
  // the harness is holding in memory; keep it so an unmaterialized run is
  // never silently invisible.
  for (const projection of projections.values()) {
    if (seen.has(projection.sessionId)) continue;
    sessions.push(await buildSession({
      sessionId: projection.sessionId,
      projectKey: projection.cwd === null ? '' : dshProjectKey(projection.cwd),
      transcript: null,
      projection,
    }));
  }

  return Object.freeze(
    sessions.sort((left, right) =>
      (dshSessionActivityMs(right) ?? 0) - (dshSessionActivityMs(left) ?? 0)),
  );
}

interface TranscriptEntry {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly cwd: string | null;
  readonly createdAtMs: number | null;
  readonly sessionId: string | null;
}

interface ProjectionEntry {
  readonly sessionId: string;
  readonly path: string;
  readonly mtimeMs: number;
  readonly cwd: string | null;
  readonly createdAtMs: number | null;
  readonly lastPromptAtMs: number | null;
  readonly sequence: number | null;
  readonly turnOpen: boolean;
  readonly turnCount: number | null;
  readonly blank: boolean;
}

async function readTranscript(
  directory: string,
  sessionId: string,
): Promise<TranscriptEntry | null> {
  for (const name of TRANSCRIPT_NAMES) {
    const path = join(directory, name);
    let details;
    try {
      details = await stat(path);
    } catch {
      continue;
    }
    if (!details.isFile()) continue;
    const header = await readTranscriptHeader(path);
    return {
      path,
      size: details.size,
      mtimeMs: details.mtimeMs,
      cwd: header?.cwd ?? null,
      createdAtMs: header?.createdAtMs ?? null,
      sessionId: header?.sessionId ?? sessionId,
    };
  }
  return null;
}

async function buildSession(input: {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly transcript: TranscriptEntry | null;
  readonly projection: ProjectionEntry | null;
}): Promise<DshSessionFile> {
  const { transcript, projection } = input;
  return Object.freeze({
    sessionId: projection?.sessionId ?? transcript?.sessionId ?? input.sessionId,
    projectKey: input.projectKey,
    transcriptPath: transcript?.path ?? null,
    transcriptSize: transcript?.size ?? null,
    transcriptMtimeMs: transcript?.mtimeMs ?? null,
    projectionPath: projection?.path ?? null,
    projectionMtimeMs: projection?.mtimeMs ?? null,
    cwd: projection?.cwd ?? transcript?.cwd ?? null,
    createdAtMs: projection?.createdAtMs ?? transcript?.createdAtMs ?? null,
    lastPromptAtMs: projection?.lastPromptAtMs ?? null,
    sequence: projection?.sequence ?? null,
    turnOpen: projection?.turnOpen ?? false,
    turnCount: projection?.turnCount ?? null,
    blank: projection?.blank ?? transcript?.cwd === null,
  });
}

async function readProjections(root: string): Promise<Map<string, ProjectionEntry>> {
  const projections = new Map<string, ProjectionEntry>();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return projections;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLocaleLowerCase().endsWith('.json')) continue;
    const sessionId = entry.name.slice(0, -'.json'.length);
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    const path = join(root, entry.name);
    let details;
    try {
      details = await stat(path);
    } catch {
      continue;
    }
    const projection = await readProjection(path, sessionId, details.mtimeMs);
    if (projection !== null) projections.set(sessionId, projection);
  }
  return projections;
}

async function readProjection(
  path: string,
  sessionId: string,
  mtimeMs: number,
): Promise<ProjectionEntry | null> {
  let text: string;
  try {
    const handle = await open(path, 'r');
    try {
      text = (await handle.readFile({ encoding: 'utf8' })) as unknown as string;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  const record = readRecord(readRecord(parsed)?.record);
  const identity = readRecord(record?.identity);
  const rows = readRecord(record?.rows);
  const metadata = readRow(rows, 'sessionListMetadata');
  const turnBoundary = readRow(rows, 'turnBoundary');

  return {
    sessionId: readString(identity?.id) ?? sessionId,
    path,
    mtimeMs,
    cwd: readString(identity?.cwd),
    createdAtMs: readNumber(identity?.createdAt),
    lastPromptAtMs: readNumber(readRecord(metadata?.val)?.lastPromptAt),
    sequence: readNumber(metadata?.seq) ?? readNumber(turnBoundary?.seq),
    turnOpen: readRecord(turnBoundary?.val)?.lastStepBoundary !== undefined &&
      readString(readRecord(readRecord(turnBoundary?.val)?.lastStepBoundary)?.kind) === 'start',
    turnCount: readNumber(readRecord(turnBoundary?.val)?.lastTurn),
    blank: readBoolean(readRecord(metadata?.val)?.blank) ?? false,
  };
}

async function readTranscriptHeader(
  path: string,
): Promise<{ sessionId: string | null; cwd: string | null; createdAtMs: number | null } | null> {
  const line = await readFirstJsonLine(path);
  if (line === null) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return {
      sessionId: readString(parsed.id),
      cwd: readString(parsed.cwd),
      createdAtMs: readNumber(parsed.createdAt),
    };
  } catch {
    return null;
  }
}

/**
 * Read the first JSONL record without ever materializing the whole transcript.
 * The harness compresses the log with zstd; a plain log is read directly.
 */
async function readFirstJsonLine(path: string): Promise<string | null> {
  const compressed = path.toLocaleLowerCase().endsWith('.zstd');
  let buffer: Buffer;
  try {
    const handle = await open(path, 'r');
    try {
      buffer = Buffer.alloc(DEFAULT_HEADER_OUTPUT_LIMIT);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      buffer = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  if (!compressed) {
    const newline = buffer.indexOf(0x0a);
    const line = buffer.subarray(0, newline < 0 ? buffer.length : newline).toString('utf8').trim();
    return line.length === 0 ? null : line;
  }

  return await inflateFirstLine(buffer);
}

async function inflateFirstLine(compressed: Buffer): Promise<string | null> {
  if (compressed.length === 0) return null;
  const inflate = createZstdDecompress();
  try {
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      let total = 0;
      const chunks: Buffer[] = [];
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const takeFirstLine = (): string | null => {
        const text = Buffer.concat(chunks).toString('utf8');
        const newline = text.indexOf('\n');
        const line = (newline < 0 ? text : text.slice(0, newline)).trim();
        return line.length === 0 ? null : line;
      };
      inflate.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.includes('\n') || total >= DEFAULT_HEADER_OUTPUT_LIMIT) finish(takeFirstLine());
      });
      inflate.on('end', () => finish(takeFirstLine()));
      inflate.on('error', () => finish(null));
      inflate.end(compressed);
    });
  } catch {
    return null;
  } finally {
    inflate.destroy();
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readRow(
  rows: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  return rows === null ? null : readRecord(rows[key]);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error &&
    (error as { code?: string }).code === 'ENOENT',
  );
}