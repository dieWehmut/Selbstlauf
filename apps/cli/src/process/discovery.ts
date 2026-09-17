import type { RawProcessRecord } from './process-provider.js';

export type DiscoveredTool = 'claude' | 'codex' | 'dsh';

export interface ProcessNameOptions {
  readonly claudeExecutableNames?: readonly string[];
  readonly codexExecutableNames?: readonly string[];
  readonly dshExecutableNames?: readonly string[];
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
  readonly workingDirectory?: string | null;
  readonly threadId?: string;
  /**
   * Stable logical identity when one process hosts several sessions, as the
   * DeepSeek Harness `web` host does. Watchdog session ids use this value
   * instead of the root PID so each hosted session stays a distinct row.
   */
  readonly logicalId?: string;
  readonly transportHint: 'unknown';
}

const DEFAULT_CLAUDE_EXECUTABLE_NAMES = ['claude.ps1'];
const DEFAULT_CODEX_EXECUTABLE_NAMES = ['codex.exe'];
const DEFAULT_DSH_EXECUTABLE_NAMES = ['dsh.exe', 'dsh.cmd', 'dsh.ps1'];

/**
 * Entry points that only the DeepSeek Harness launches. Matching on the entry
 * point rather than on any occurrence of the repository name keeps an
 * unrelated shell that merely mentions the checkout from becoming a session.
 */
const DSH_ENTRY_TOKENS = [
  'deepseek-harness\\apps\\cli\\lib\\bin.js',
  'deepseek-harness\\packages\\subprocess\\subprocess-local\\lib\\runner.js',
  '@deepseek-ai\\dsh\\lib\\bin.js',
  '@deepseek-ai\\dsh\\bin\\dsh.js',
] as const;

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

function containsEntryToken(commandLine: string, token: string): boolean {
  return lower(commandLine).includes(lower(token));
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
  const dshNames = options.dshExecutableNames ?? DEFAULT_DSH_EXECUTABLE_NAMES;

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
  const isDsh =
    configuredNameMatches(record, dshNames) ||
    containsScriptToken(commandLine, 'dsh.cmd') ||
    containsScriptToken(commandLine, 'dsh.ps1') ||
    DSH_ENTRY_TOKENS.some((token) => containsEntryToken(commandLine, token)) ||
    (processName === 'dsh.exe' && executableName === 'dsh.exe');

  const matched = [
    ...(isClaude ? (['claude'] as const) : []),
    ...(isCodex ? (['codex'] as const) : []),
    ...(isDsh ? (['dsh'] as const) : []),
  ];
  return matched.length === 1 ? matched[0] : null;
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
    .map(({ tool, root, childPids }) => {
      const workingDirectory = root.workingDirectory ?? extractWorkingDirectory(root.commandLine);
      return {
        tool,
        rootPid: root.pid,
        childPids: childPids.sort((left, right) => left - right),
        commandLine: root.commandLine,
        executablePath: root.executablePath,
        creationTimeMs: root.creationTimeMs,
        userSid: root.userSid,
        ...(workingDirectory === null ? {} : { workingDirectory }),
        transportHint: 'unknown' as const,
      };
    })
    .sort(compareSessions);
}

function extractWorkingDirectory(commandLine: string | null): string | null {
  if (typeof commandLine !== 'string') return null;
  const match = /(?:^|\s)(?:--cwd|--directory|-C)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/iu.exec(commandLine);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined || value.trim().length === 0 ? null : value;
}
