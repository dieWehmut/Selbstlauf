import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TransportKind } from '../domain/types.js';

/** The process metadata needed to associate a Claude process with its JSONL session. */
export interface ClaudeProcessRecord {
  readonly pid: number;
  readonly cwd: string | null;
  readonly creationTimeMs: number;
  readonly commandLine?: string;
}

/** A lightweight index entry. The service never copies the JSONL transcript. */
export interface ClaudeSessionFile {
  readonly path: string;
  readonly projectPath: string | null;
  readonly sessionId: string | null;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ClaudeAssociationOptions {
  /** Upper bound for a file written after process creation to be considered. */
  readonly recentWindowMs?: number;
  /** A transport is supplied by a trusted adapter after association. */
  readonly transport?: Extract<TransportKind, 'classic-console' | 'pty'>;
}

export interface ClaudeAssociation {
  readonly conversationId: string | null;
  readonly sessionPath: string | null;
  readonly transport: TransportKind;
  readonly activity: { readonly size: number; readonly mtimeMs: number } | null;
  readonly reason?: string;
}

const DEFAULT_RECENT_WINDOW_MS = 15 * 60 * 1_000;
const MAX_METADATA_BYTES = 64 * 1_024;

export async function scanClaudeSessionFiles(projectsDirectory: string): Promise<readonly ClaudeSessionFile[]> {
  const files: ClaudeSessionFile[] = [];
  let projects;
  try {
    projects = await readdir(projectsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return files;
    throw error;
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDirectory = join(projectsDirectory, project.name);
    const entries = await readdir(projectDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLocaleLowerCase().endsWith('.jsonl')) continue;
      const path = join(projectDirectory, entry.name);
      const metadata = await readClaudeMetadata(path);
      if (metadata === null) continue;
      const details = await stat(path);
      files.push({
        path,
        projectPath: metadata.cwd,
        sessionId: metadata.sessionId,
        size: details.size,
        mtimeMs: details.mtimeMs,
      });
    }
  }
  return Object.freeze(files.sort((left, right) => right.mtimeMs - left.mtimeMs));
}

export function hasClaudeSessionActivity(
  previous: Pick<ClaudeSessionFile, 'size' | 'mtimeMs'>,
  current: Pick<ClaudeSessionFile, 'size' | 'mtimeMs'>,
): boolean {
  return current.size !== previous.size || current.mtimeMs > previous.mtimeMs;
}

/**
 * Associate a process with one and only one recent JSONL file.
 *
 * Claude's on-disk layout can contain several sessions for the same project.
 * We therefore fail closed whenever more than one file could have been opened
 * by this process. File metadata is returned as an activity signal; transcript
 * contents are intentionally never read here.
 */
export function associateClaudeSession(
  process: ClaudeProcessRecord,
  files: readonly ClaudeSessionFile[],
  options: ClaudeAssociationOptions = {},
): ClaudeAssociation {
  const recentWindowMs = options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  if (!Number.isFinite(recentWindowMs) || recentWindowMs <= 0) {
    throw new RangeError('recentWindowMs must be a positive finite number');
  }

  const project = normalizePath(process.cwd);
  if (project === null) {
    return monitorOnly('process working directory is unknown');
  }

  const projectMatches = files.filter((file) => normalizePath(file.projectPath) === project);
  const resumedSessionId = extractResumeSessionId(process.commandLine);
  if (resumedSessionId !== null) {
    const explicitMatches = projectMatches.filter((file) => file.sessionId?.toLocaleLowerCase() === resumedSessionId);
    if (explicitMatches.length === 1) return association(explicitMatches[0], options.transport);
    if (explicitMatches.length > 1) return monitorOnly('ambiguous Claude resume session association');
  }

  const matches = projectMatches.filter((file) => {
    return (
      Number.isFinite(file.mtimeMs) &&
      file.mtimeMs >= process.creationTimeMs &&
      file.mtimeMs <= process.creationTimeMs + recentWindowMs &&
      typeof file.sessionId === 'string' &&
      file.sessionId.trim().length > 0
    );
  });

  if (matches.length === 0) {
    return monitorOnly('no unique recent Claude session was found');
  }
  if (matches.length !== 1) {
    return monitorOnly(`ambiguous Claude session association (${matches.length} candidates)`);
  }

  const match = matches[0];
  return association(match, options.transport);
}

function association(
  match: ClaudeSessionFile,
  transport: ClaudeAssociationOptions['transport'],
): ClaudeAssociation {
  return {
    conversationId: match.sessionId,
    sessionPath: match.path,
    transport: transport ?? 'monitor-only',
    activity: { size: match.size, mtimeMs: match.mtimeMs },
  };
}

function monitorOnly(reason: string): ClaudeAssociation {
  return {
    conversationId: null,
    sessionPath: null,
    transport: 'monitor-only',
    activity: null,
    reason,
  };
}

function normalizePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  return value.replaceAll('/', '\\').replace(/[\\]+$/, '').toLocaleLowerCase();
}

function extractResumeSessionId(commandLine: string | undefined): string | null {
  if (typeof commandLine !== 'string') return null;
  const match = /(?:^|\s)--resume(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(commandLine);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? null : value.toLocaleLowerCase();
}

async function readClaudeMetadata(path: string): Promise<{ cwd: string | null; sessionId: string | null } | null> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_METADATA_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
    if (firstLine.trim().length === 0) return null;
    const parsed = JSON.parse(firstLine) as { cwd?: unknown; sessionId?: unknown };
    return {
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}
