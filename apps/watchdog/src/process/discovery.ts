import type { RawProcessRecord } from './process-provider.js';

export type DiscoveredTool = 'claude' | 'codex';

export interface ProcessNameOptions {
  readonly claudeExecutableNames?: readonly string[];
  readonly codexExecutableNames?: readonly string[];
}

export interface GroupProcessesOptions extends ProcessNameOptions {
  /** Required when same-user filtering is enabled, unless supplied by the caller. */
  readonly currentUserSid?: string;
  /** Override the watchdog PID in tests or when discovery runs in a host process. */
  readonly currentProcessId?: number;
  readonly sameUserOnly?: boolean;
}

export interface DiscoveredProcessSession {
  readonly tool: DiscoveredTool;
  readonly rootPid: number;
  readonly childPids: readonly number[];
  readonly commandLine: string | null;
  readonly executablePath: string | null;
  readonly creationTimeMs: number | null;
  readonly userSid: string | null;
  readonly threadId?: string;
  readonly transportHint: 'unknown';
}

const DEFAULT_CLAUDE_EXECUTABLE_NAMES = ['claude.ps1'];
const DEFAULT_CODEX_EXECUTABLE_NAMES = ['codex.exe'];

function lower(value: string): string {
  return value.replaceAll('/', '\\').toLowerCase();
}

function basename(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = lower(value).replace(/^['"]|['"]$/gu, '');
  const separator = normalized.lastIndexOf('\\');
  return separator >= 0 ? normalized.slice(separator + 1) : normalized;
}

function configuredNameMatches(
  record: RawProcessRecord,
  names: readonly string[],
): boolean {
  const candidates = new Set([
    lower(record.name),
    basename(record.name),
    basename(record.executablePath),
  ]);
  return names.some((name) => {
    const normalized = basename(name);
    return normalized !== null && candidates.has(normalized);
  });
}

function containsScriptToken(commandLine: string, scriptName: string): boolean {
  const command = lower(commandLine);
  const token = lower(scriptName);
  return new RegExp(`(?:^|[\\\\/\\s"'])${token}(?:$|[\\\\/\\s"'])`, 'u').test(command);
}

/** Return a tool only when the process has one unambiguous known signature. */
export function detectProcessTool(
  record: RawProcessRecord,
  options: ProcessNameOptions = {},
): DiscoveredTool | null {
  const commandLine = lower(record.commandLine ?? '');
  const processName = basename(record.name);
  const executableName = basename(record.executablePath);
  const claudeNames = options.claudeExecutableNames ?? DEFAULT_CLAUDE_EXECUTABLE_NAMES;
  const codexNames = options.codexExecutableNames ?? DEFAULT_CODEX_EXECUTABLE_NAMES;

  const isClaude =
    configuredNameMatches(record, claudeNames) ||
    commandLine.includes('claude-code') ||
    containsScriptToken(commandLine, 'claude.ps1');
  const isCodex =
    configuredNameMatches(record, codexNames) ||
    commandLine.includes('@openai\\codex') ||
    containsScriptToken(commandLine, 'codex.js') ||
    processName === 'codex.exe' ||
    executableName === 'codex.exe';

  if (isClaude === isCodex) {
    return null;
  }
  return isClaude ? 'claude' : 'codex';
}

function sidEquals(left: string | null, right: string): boolean {
  return left !== null && left.trim().toLowerCase() === right.trim().toLowerCase();
}

function compareSessions(
  left: DiscoveredProcessSession,
  right: DiscoveredProcessSession,
): number {
  if (left.creationTimeMs === null && right.creationTimeMs !== null) {
    return 1;
  }
  if (left.creationTimeMs !== null && right.creationTimeMs === null) {
    return -1;
  }
  if (left.creationTimeMs !== right.creationTimeMs) {
    return (left.creationTimeMs ?? 0) - (right.creationTimeMs ?? 0);
  }
  return left.rootPid - right.rootPid;
}

/** Group matching roots and descendants into independent logical sessions. */
export function groupProcesses(
  records: readonly RawProcessRecord[],
  options: GroupProcessesOptions = {},
): DiscoveredProcessSession[] {
  const sameUserOnly = options.sameUserOnly ?? true;
  const currentProcessId = options.currentProcessId ?? process.pid;
  const currentUserSid = options.currentUserSid?.trim() ??
    records.find((record) => record.pid === currentProcessId)?.userSid?.trim();
  if (sameUserOnly && !currentUserSid) {
    throw new Error('currentUserSid is required when sameUserOnly is enabled');
  }

  const byPid = new Map<number, RawProcessRecord>();
  for (const record of records) {
    if (byPid.has(record.pid)) {
      throw new Error(`Duplicate process PID ${record.pid}`);
    }
    if (!sameUserOnly || sidEquals(record.userSid, currentUserSid as string)) {
      byPid.set(record.pid, record);
    }
  }

  const toolByPid = new Map<number, DiscoveredTool>();
  for (const record of byPid.values()) {
    const tool = detectProcessTool(record, options);
    if (tool !== null) {
      toolByPid.set(record.pid, tool);
    }
  }

  const rootByPid = new Map<number, RawProcessRecord>();
  for (const record of byPid.values()) {
    const tool = toolByPid.get(record.pid);
    if (!tool) {
      continue;
    }

    let root = record;
    let parentPid = record.parentPid;
    const visited = new Set<number>([record.pid]);
    while (!visited.has(parentPid)) {
      visited.add(parentPid);
      const parent = byPid.get(parentPid);
      if (!parent || toolByPid.get(parent.pid) !== tool) {
        break;
      }
      root = parent;
      parentPid = parent.parentPid;
    }
    rootByPid.set(record.pid, root);
  }

  const groups = new Map<string, { tool: DiscoveredTool; root: RawProcessRecord; childPids: number[] }>();
  for (const [pid, root] of rootByPid) {
    const tool = toolByPid.get(pid);
    if (!tool) {
      continue;
    }
    const key = `${tool}:${root.pid}`;
    const group = groups.get(key) ?? { tool, root, childPids: [] };
    if (pid !== root.pid) {
      group.childPids.push(pid);
    }
    groups.set(key, group);
  }

  return [...groups.values()]
    .map(({ tool, root, childPids }) => ({
      tool,
      rootPid: root.pid,
      childPids: childPids.sort((left, right) => left - right),
      commandLine: root.commandLine,
      executablePath: root.executablePath,
      creationTimeMs: root.creationTimeMs,
      userSid: root.userSid,
      transportHint: 'unknown' as const,
    }))
    .sort(compareSessions);
}
