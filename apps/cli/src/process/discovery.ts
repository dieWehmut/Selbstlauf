import type { RawProcessRecord } from './process-provider.js';
import {
  classifySessionHost,
  hostAppFor,
  type HarnessHostHint,
  type SessionHost,
} from './host-apps.js';

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
  /** Marks the harness WebUI window so a hosted session can name its browser. */
  readonly harnessHost?: HarnessHostHint | null;
  /**
   * The WSL distribution these records came from, when they did.
   *
   * Three things follow from it, and each matters: the records are not subject to the Windows same-user
   * check (a Linux process has no Windows SID to compare), the watchdog's own PID means nothing in a Linux
   * pid namespace so no process is excluded on that basis, and every session is stamped with the
   * distribution so its identity cannot collide with a Windows pid.
   */
  readonly distribution?: string;
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
  /**
   * The WSL distribution a session runs in, or absent for a Windows process.
   *
   * This is not decoration: a Linux pid lives in its own namespace, so a WSL process numbered 98051 says
   * nothing about Windows process 98051, and the two can collide. Session identity therefore has to carry the
   * distribution, or a WSL session could be confused with an unrelated Windows one.
   *
   * It is also what tells the rest of the app that this session has no window: there is no Win32 handle for a
   * process inside a distribution, so nothing can be previewed or revealed for it.
   */
  readonly distribution?: string;
  /** The application the session is running inside, when it can be resolved. */
  readonly host?: SessionHost | null;
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

function containsPathToken(commandLine: string, token: string): boolean {
  const command = lower(commandLine).replaceAll('\\', '/');
  const normalizedToken = lower(token).replaceAll('\\', '/');
  const escapedToken = normalizedToken.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[\\s"'/])${escapedToken}(?:$|[\\s"'/])`, 'u').test(command);
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
    containsPathToken(commandLine, 'claude-code') ||
    containsPathToken(commandLine, 'claude.ps1') ||
    // The Linux launcher has no extension: measured inside Ubuntu, `claude` is a script at
    // `<prefix>/bin/claude`, where the Windows install is `claude.ps1`.
    containsPathToken(commandLine, 'bin/claude');
  const isCodex =
    configuredNameMatches(record, codexNames) ||
    containsPathToken(commandLine, '@openai/codex') ||
    containsPathToken(commandLine, 'codex.js') ||
    // Measured inside Ubuntu: the session's root is `node <prefix>/bin/codex`, an extension-less launcher,
    // while the child it spawns is `.../@openai/codex-linux-x64/vendor/.../bin/codex` and matched already.
    // Without this the root was missed and the session was reported as a bare child process.
    containsPathToken(commandLine, 'bin/codex') ||
    processName === 'codex.exe' ||
    executableName === 'codex.exe';
  const isDsh =
    configuredNameMatches(record, dshNames) ||
    containsPathToken(commandLine, 'dsh.cmd') ||
    containsPathToken(commandLine, 'dsh.ps1') ||
    containsPathToken(commandLine, 'bin/dsh') ||
    DSH_ENTRY_TOKENS.some((token) => containsPathToken(commandLine, token)) ||
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
  // WSL records come from a Linux pid namespace: they have no Windows SID to compare, and the watchdog's own
  // Windows PID is meaningless among them, so neither check can be applied to them.
  const distribution = options.distribution?.trim();
  const isWsl = distribution !== undefined && distribution.length > 0;
  const currentProcessId = options.currentProcessId ?? process.pid;
  const currentUserSid = options.currentUserSid?.trim() ??
    records.find((record) => record.pid === currentProcessId)?.userSid?.trim();
  if (sameUserOnly && !isWsl && !currentUserSid) {
    throw new Error('currentUserSid is required when sameUserOnly is enabled');
  }

  /**
   * The watchdog itself and everything it spawned.
   *
   * The watchdog runs a `codex app-server` child to continue Codex sessions, and that child carries a
   * codex signature on its command line, so discovery found it and listed the watchdog's own transport as
   * a session — labelled 命令提示符 after the `cmd.exe` that wraps it. Measured on a real machine: that row
   * appeared while the actual Codex conversations were also listed, and nothing can usefully be written
   * into the watchdog's own transport. Descendants are excluded, not just the process itself, because the
   * signature lives on the child rather than on the app.
   *
   * The ancestor chain comes from the provider, which resolves it for the intermediates that are not
   * themselves candidates — `cmd.exe` here — so one pass is normally enough. The loop runs to a fixed
   * point anyway: the chain is not guaranteed to be reported for every intermediate.
   */
  // In a Linux pid namespace the watchdog's Windows PID means nothing, so nothing is excluded there.
  const excludedPids = new Set<number>(isWsl ? [] : [currentProcessId]);
  for (let pass = 0; pass < records.length; pass += 1) {
    let changed = false;
    for (const record of records) {
      if (excludedPids.has(record.pid)) continue;
      const chain = [
        ...(record.ancestors ?? []).map((ancestor) => ancestor.pid),
        record.parentPid,
      ];
      if (chain.some((pid) => excludedPids.has(pid))) {
        excludedPids.add(record.pid);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const byPid = new Map<number, RawProcessRecord>();
  for (const record of records) {
    if (byPid.has(record.pid)) {
      throw new Error(`Duplicate process PID ${record.pid}`);
    }
    if (excludedPids.has(record.pid)) {
      continue;
    }
    // A WSL record carries no Windows SID, so the same-user rule cannot apply to it: the distribution is
    // already the user's own, and the provider only ever lists their processes.
    if (isWsl || !sameUserOnly || sidEquals(record.userSid, currentUserSid as string)) {
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

  /**
   * Fold a session root into an ancestor that is already a session of the same tool.
   *
   * The walk above climbs only through *consecutive* same-tool ancestors, so a codex process started
   * underneath a codex session but separated by a process that carries no signature becomes its own root
   * and therefore its own row. Measured on a real machine: a Tabby Codex conversation was listed twice —
   * once for the CLI (`node.exe … codex.js`) and once for the `codex.exe app-server` it spawned, reached
   * through `node_repl.exe` and a `cua-repl` node. Both rows resolved to the **same conversation id**, so
   * one conversation appeared as two processes.
   *
   * Folding is limited to a strict ancestor relationship with the same tool, so two genuinely independent
   * sessions of the same tool are never merged, however similar they look.
   */
  const foldedRootPid = new Map<number, number>();
  for (const [pid, root] of rootByPid) {
    const tool = toolByPid.get(pid);
    let outermost = root.pid;
    // The chain is ordered nearest first, so the last match is the outermost ancestor.
    for (const ancestor of root.ancestors ?? []) {
      if (toolByPid.get(ancestor.pid) !== tool) continue;
      const ancestorRoot = rootByPid.get(ancestor.pid);
      if (ancestorRoot !== undefined) outermost = ancestorRoot.pid;
    }
    foldedRootPid.set(pid, outermost);
  }

  const groups = new Map<string, { tool: DiscoveredTool; root: RawProcessRecord; childPids: number[] }>();
  for (const [pid, root] of rootByPid) {
    const tool = toolByPid.get(pid);
    if (!tool) {
      continue;
    }
    const finalRootPid = foldedRootPid.get(pid) ?? root.pid;
    const finalRoot = rootByPid.get(finalRootPid) ?? root;
    const key = `${tool}:${finalRootPid}`;
    const group = groups.get(key) ?? { tool, root: finalRoot, childPids: [] };
    if (pid !== finalRootPid) {
      group.childPids.push(pid);
    }
    groups.set(key, group);
  }

  return [...groups.values()]
    .map(({ tool, root, childPids }) => {
      const workingDirectory = root.workingDirectory ?? extractWorkingDirectory(root.commandLine);
      const host = classifySessionHost({
        rootPid: root.pid,
        rootName: root.name,
        ancestors: root.ancestors ?? [],
        windows: (root.windows ?? []).map((window) => ({
          handle: window.handle,
          pid: window.pid,
          processName: window.processName,
          title: window.title,
          className: window.className,
          visible: window.visible,
        })),
        // Only the harness serves its interface from a process outside the
        // session tree, so only its rows may match a browser window by title.
        harness: tool === 'dsh' ? options.harnessHost ?? null : null,
      });
      return {
        tool,
        rootPid: root.pid,
        childPids: childPids.sort((left, right) => left - right),
        commandLine: root.commandLine,
        executablePath: root.executablePath,
        creationTimeMs: root.creationTimeMs,
        userSid: root.userSid,
        ...(workingDirectory === null ? {} : { workingDirectory }),
        /**
         * A session inside a distribution gets a host only when its launching terminal was established.
         *
         * `classifySessionHost` answers "which application is this running inside" from the ancestor chain and
         * the desktop's window list, and a Linux process has neither — measured, a WSL pid has no Win32 window
         * at all — so it is not asked for one here.
         *
         * The user's request is that a Codex session inside WSL, started from Tabby, be grouped **with Tabby**:
         * the grouping should follow the application a person works in rather than the operating system. That
         * attribution comes from the interop socket (see `wsl-launcher.ts`) and is carried on the record as
         * `wslTerminal`. When it is present the session is given a host naming that terminal, with no window
         * handle — the window belongs to the terminal, not to the distribution — so the UI still says truthfully
         * that this session has no window of its own to preview.
         */
        ...(isWsl
          ? hostFromWslTerminal(root.wslTerminal, root.pid)
          : host === null ? {} : { host }),
        ...(isWsl ? { distribution } : {}),
        transportHint: 'unknown' as const,
      };
    })
    .sort(compareSessions);
}

/**
 * Build a host for a WSL session from the terminal that launched it.
 *
 * The window handle is deliberately null: the terminal's window shows this session's output, but the session is
 * not the terminal's process, and pointing the preview at the terminal's window would show the wrong thing under
 * this row's name. What the host is used for here is grouping.
 */
function hostFromWslTerminal(
  terminal: string | undefined,
  rootPid: number,
): { readonly host?: SessionHost } {
  if (terminal === undefined || terminal.trim().length === 0) return {};
  const known = hostAppFor(terminal);
  return {
    host: {
      processId: rootPid,
      executableName: terminal,
      label: known?.label ?? terminal,
      category: known?.category ?? 'terminal',
      windowHandle: null,
      windowTitle: null,
    },
  };
}

function extractWorkingDirectory(commandLine: string | null): string | null {
  if (typeof commandLine !== 'string') return null;
  const match = /(?:^|\s)(?:--cwd|--directory|-C)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/iu.exec(commandLine);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined || value.trim().length === 0 ? null : value;
}
