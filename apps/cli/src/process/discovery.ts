import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawProcessRecord } from './process-provider.js';
import {
  classifySessionHost,
  hostAppFor,
  type HarnessHostHint,
  type SessionHost,
} from './host-apps.js';

export type DiscoveredTool = 'claude' | 'codex' | 'dsh' | 'gemini' | 'antigravity' | 'cursor';

export interface ProcessNameOptions {
  readonly claudeExecutableNames?: readonly string[];
  readonly codexExecutableNames?: readonly string[];
  readonly dshExecutableNames?: readonly string[];
  readonly geminiExecutableNames?: readonly string[];
  readonly antigravityExecutableNames?: readonly string[];
  readonly cursorExecutableNames?: readonly string[];
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
  readonly arguments?: readonly string[];
  readonly executablePath: string | null;
  readonly creationTimeMs: number | null;
  readonly userSid: string | null;
  readonly workingDirectory?: string | null;
  readonly threadId?: string;
  /** Separate a standalone CLI session from the editor/desktop app hosting it. */
  readonly processKind?: 'cli' | 'desktop';
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

const DEFAULT_CLAUDE_EXECUTABLE_NAMES = ['claude.ps1', 'claude.cmd', 'claude.exe'];
const DEFAULT_CODEX_EXECUTABLE_NAMES = ['codex.exe'];
const DEFAULT_DSH_EXECUTABLE_NAMES = ['dsh.exe', 'dsh.cmd', 'dsh.ps1'];
const DEFAULT_GEMINI_EXECUTABLE_NAMES = ['gemini', 'gemini.exe', 'gemini.cmd', 'gemini.ps1'];
const DEFAULT_CURSOR_EXECUTABLE_NAMES = ['cursor', 'cursor.exe', 'cursor-agent', 'cursor-agent.exe', 'cursor-agent.cmd', 'cursor-agent.ps1'];
const DEFAULT_ANTIGRAVITY_EXECUTABLE_NAMES = ['antigravity', 'antigravity.exe', 'antigravity.cmd', 'antigravity.ps1'];

/** Keep quoted paths and prompts whole, including --flag="a path". */
function commandArguments(commandLine: string | null, arguments_?: readonly string[]): readonly string[] {
  if (arguments_ !== undefined) return arguments_;
  const args: string[] = [];
  let value = '', quote = '', started = false;
  for (const char of commandLine ?? '') {
    if (quote) {
      if (char === quote) quote = '';
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char; started = true;
    } else if (/\s/u.test(char)) {
      if (started) args.push(value);
      value = ''; started = false;
    } else {
      value += char; started = true;
    }
  }
  if (started) args.push(value);
  return args;
}

/** The actual script executed by Node/Bun or a POSIX launcher, not prompt text. */
function runtimeEntry(record: RawProcessRecord): string | null {
  const args = commandArguments(record.commandLine, record.arguments);
  if (!/^(?:node|bun|sh|bash|zsh)(?:\.exe)?$/u.test(basename(args[0] ?? null) ?? '')) return null;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    // Evaluation text is never an executable entry point, even if it mentions a package.
    if (/^(?:--eval|--print|--command)(?:=|$)|^-(?:e|p|c)/u.test(arg)) return null;
    if (['--require', '-r', '--import', '--loader', '--experimental-loader'].includes(arg)) { index += 1; continue; }
    if (arg === '--') return args[index + 1] ?? null;
    if (!arg.startsWith('-')) return arg;
  }
  return null;
}

function pathParts(value: string | null): string[] {
  return lower(value ?? '').split('\\').filter(Boolean);
}

function cursorCliPath(value: string | null): boolean {
  const parts = pathParts(value);
  const filename = parts.at(-1) ?? '';
  if (/^cursor-agent(?:\.(?:exe|cmd|ps1))?$/u.test(filename)) return true;
  // `agent` is a generic executable name. Only Cursor's own installation directory proves ownership.
  return parts.includes('cursor-agent') && /^(?:agent(?:\.(?:exe|cmd|ps1))?|index\.(?:js|mjs|cjs))$/u.test(filename);
}

function geminiEntry(value: string | null): boolean {
  const parts = pathParts(value);
  const joined = parts.join('/');
  return /^gemini(?:\.(?:exe|cmd|ps1))?$/u.test(parts.at(-1) ?? '') ||
    /(?:^|\/)@google\/gemini-cli\/(?:dist\/index\.js|bundle\/gemini\.js)$/u.test(joined);
}

function cursorDesktopEntry(value: string | null): boolean {
  return /(?:^|\/)extensions\/cursor-agent-host\/dist\/agent-host-daemon\/dist\/bin\/daemon\.(?:js|cjs)$/u
    .test(pathParts(value).join('/'));
}

/** Electron may run Node workers under its own image name without --type. */
function electronScriptEntry(record: RawProcessRecord): string | null {
  const args = commandArguments(record.commandLine, record.arguments);
  const executable = record.executablePath ?? args[0] ?? null;
  const parts = pathParts(executable);
  if (!/^(?:cursor|antigravity)(?:\.exe)?$/u.test(parts.at(-1) ?? '')) return null;
  const entry = args.slice(1).find((arg) => !arg.startsWith('-')) ?? null;
  if (!entry) return null;
  const directory = parts.slice(0, -1).join('/').replace(/\/contents\/macos$/u, '/contents');
  const source = pathParts(entry).join('/');
  const internal = source.startsWith(`${directory}/resources/app/`) || source.startsWith(`${directory}/resources/app.asar/`);
  return internal && (/\.(?:js|cjs|mjs)$/u.test(source) || args.includes('--node-ipc')) ? entry : null;
}

function antigravityHelper(record: RawProcessRecord): boolean {
  const value = record.executablePath ?? commandArguments(record.commandLine, record.arguments)[0] ?? null;
  const parts = pathParts(value);
  if (!/(?:^|\/)resources\/bin\/language_server(?:\.exe)?$/u.test(parts.join('/'))) return false;
  // The filename is shared by other IDEs. Require Antigravity's installation
  // directory or an actual Antigravity ancestor to establish ownership.
  return parts.some((part) => part === 'antigravity' || part === 'antigravity.app') ||
    (record.ancestors ?? []).some((ancestor) => /^(?:antigravity|antigravity\.exe)$/u.test(basename(ancestor.name) ?? ''));
}

function desktopAgentHelper(record: RawProcessRecord): boolean {
  return cursorDesktopEntry(runtimeEntry(record) ?? electronScriptEntry(record)) || antigravityHelper(record);
}

function isElectronHelper(record: RawProcessRecord): boolean {
  return commandArguments(record.commandLine, record.arguments).slice(1).some((arg) =>
    /^--(?:type(?:=|$)|utility-sub-type(?:=|$)|crashpad-handler(?:=|$))/u.test(arg));
}

function processKind(record: RawProcessRecord, tool: DiscoveredTool): 'cli' | 'desktop' | undefined {
  if (tool === 'gemini') return 'cli';
  if (tool === 'cursor') {
    return cursorCliPath(record.executablePath) || cursorCliPath(record.name) || cursorCliPath(runtimeEntry(record)) ||
      cursorCliPath(commandArguments(record.commandLine, record.arguments)[0] ?? null)
      ? 'cli' : 'desktop';
  }
  if (tool === 'antigravity') return 'desktop';
  return undefined;
}

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
  const processName = basename(record.name);
  const executableName = basename(record.executablePath);
  const claudeNames = options.claudeExecutableNames ?? DEFAULT_CLAUDE_EXECUTABLE_NAMES;
  const codexNames = options.codexExecutableNames ?? DEFAULT_CODEX_EXECUTABLE_NAMES;
  const dshNames = options.dshExecutableNames ?? DEFAULT_DSH_EXECUTABLE_NAMES;
  const entry = runtimeEntry(record);
  const electronEntry = electronScriptEntry(record);
  const firstArgument = commandArguments(record.commandLine, record.arguments)[0] ?? null;
  const isGemini = configuredNameMatches(record, options.geminiExecutableNames ?? DEFAULT_GEMINI_EXECUTABLE_NAMES) ||
    geminiEntry(entry);
  const cursorCli = cursorCliPath(record.executablePath) || cursorCliPath(record.name) || cursorCliPath(entry) ||
    cursorCliPath(firstArgument);
  const isCursor = cursorCli || cursorDesktopEntry(entry ?? electronEntry) || (!isElectronHelper(record) && electronEntry === null &&
    configuredNameMatches(record, options.cursorExecutableNames ?? DEFAULT_CURSOR_EXECUTABLE_NAMES));
  const isAntigravity = antigravityHelper(record) || (!isElectronHelper(record) && electronEntry === null &&
    configuredNameMatches(record, options.antigravityExecutableNames ?? DEFAULT_ANTIGRAVITY_EXECUTABLE_NAMES));
  // A recognized entry point owns its arguments. A prompt naming another CLI
  // must not make that Gemini/Cursor/Antigravity process ambiguous.
  const commandLine = lower(isGemini || isCursor || isAntigravity
    ? entry ?? firstArgument ?? '' : record.commandLine ?? '');

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
    ...(isGemini ? (['gemini'] as const) : []),
    ...(isCursor ? (['cursor'] as const) : []),
    ...(isAntigravity ? (['antigravity'] as const) : []),
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
  const kindByPid = new Map<number, 'cli' | 'desktop' | undefined>();
  const desktopHelperPids = new Set<number>();
  for (const record of byPid.values()) {
    const tool = detectProcessTool(record, options);
    if (tool !== null) {
      toolByPid.set(record.pid, tool);
      const kind = processKind(record, tool);
      kindByPid.set(record.pid, kind);
      if (kind === 'desktop' && desktopAgentHelper(record)) desktopHelperPids.add(record.pid);
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
    const desktop = kindByPid.get(record.pid) === 'desktop';
    // A GUI can launch another independent GUI with its own profile/window.
    // Only its dedicated agent helpers may be absorbed into a desktop root.
    const desktopGui = desktop && !desktopHelperPids.has(record.pid);
    const visited = new Set<number>([record.pid]);
    while (!desktopGui && !visited.has(parentPid)) {
      visited.add(parentPid);
      const parent = byPid.get(parentPid);
      if (!parent || toolByPid.get(parent.pid) !== tool || kindByPid.get(parent.pid) !== kindByPid.get(record.pid)) {
        break;
      }
      root = parent;
      parentPid = parent.parentPid;
      if (desktop && !desktopHelperPids.has(parent.pid)) break;
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
   * Desktop helpers stop at the nearest GUI root; another GUI further up the
   * chain owns a different window/profile and remains independent.
   */
  const foldedRootPid = new Map<number, number>();
  for (const [pid, root] of rootByPid) {
    const tool = toolByPid.get(pid);
    let outermost = root.pid;
    const desktop = kindByPid.get(pid) === 'desktop';
    if (desktop && !desktopHelperPids.has(root.pid)) {
      foldedRootPid.set(pid, root.pid);
      continue;
    }
    // CLI helpers choose the outermost matching ancestor. Desktop helpers
    // stop at the first GUI root in this nearest-first chain.
    for (const ancestor of root.ancestors ?? []) {
      if (toolByPid.get(ancestor.pid) !== tool || kindByPid.get(ancestor.pid) !== kindByPid.get(pid)) continue;
      const ancestorRoot = rootByPid.get(ancestor.pid);
      if (ancestorRoot !== undefined) {
        outermost = ancestorRoot.pid;
        if (desktop && !desktopHelperPids.has(ancestorRoot.pid)) break;
      }
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
      const kind = kindByPid.get(root.pid);
      const desktopHelper = desktopHelperPids.has(root.pid);
      const workingDirectory = resolveWorkingDirectory(root.commandLine, root.workingDirectory, desktopHelper ? undefined : kind, root.arguments);
      const desktopHostName = hostAppFor(root.name) ? root.name : tool;
      const host = classifySessionHost({
        rootPid: root.pid,
        rootName: root.name,
        // An editor/desktop app is the host itself, not Explorer or the shell that launched it.
        ancestors: kind === 'desktop' ? [{ pid: root.pid, name: desktopHostName }, ...(root.ancestors ?? [])] : root.ancestors ?? [],
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
        ...(root.arguments === undefined ? {} : { arguments: root.arguments }),
        executablePath: root.executablePath,
        creationTimeMs: root.creationTimeMs,
        userSid: root.userSid,
        ...(kind === undefined ? {} : { processKind: kind }),
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
          ? hostFromWslTerminal(kind === 'desktop' ? desktopHostName : root.wslTerminal, root.pid)
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

function extractWorkingDirectory(commandLine: string | null, arguments_?: readonly string[]): string | null {
  const args = commandArguments(commandLine, arguments_).slice(1);
  for (let index = 0; index < args.length; index += 1) {
    if (arguments_ !== undefined) {
      if (args[index] === '--') break;
      if (['--prompt', '-p', '--system-prompt', '--system-prompt-file'].includes(args[index]!)) { index++; continue; }
    }
    const flag = /^(?:--cd|--cwd|--directory|-C)(?:=(.*))?$/u.exec(args[index]!);
    if (!flag) continue;
    const value = flag[1] ?? args[index + 1];
    if (value && !value.startsWith('-')) return value;
  }
  return null;
}

function desktopProjectDirectory(commandLine: string | null, arguments_?: readonly string[]): string | null {
  const args = commandArguments(commandLine, arguments_).slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arguments_ !== undefined && ['--prompt', '-p', '--system-prompt', '--system-prompt-file'].includes(arg)) { index++; continue; }
    const uriFlag = /^(--folder-uri|--file-uri)(?:=(.*))?$/u.exec(arg);
    if (!uriFlag) continue;
    const value = uriFlag[2] ?? args[index + 1];
    if (!value) continue;
    try {
      const url = new URL(value);
      // Remote workspaces belong to a different namespace, handled by session metadata.
      if (url.protocol !== 'file:') continue;
      const windows = url.hostname.length > 0 || /^\/[a-z]:\//iu.test(url.pathname);
      const directory = fileURLToPath(url, { windows });
      return uriFlag[1] === '--file-uri' ? (windows ? win32 : posix).dirname(directory) : directory;
    } catch { /* A malformed URI cannot identify a project. */ }
  }
  const valueFlags = new Set([
    '--user-data-dir', '--extensions-dir', '--profile', '--locale', '--log', '--port',
    '--remote', '--open-url', '--folder-uri', '--file-uri', '--inspect-extensions',
    '--inspect-brk-extensions', '--logsPath', '--crash-reporter-directory',
  ]);
  if (arguments_ !== undefined) for (const flag of ['--prompt', '-p', '--system-prompt', '--system-prompt-file']) valueFlags.add(flag);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith('-')) {
      if (!arg.includes('=') && valueFlags.has(arg)) index += 1;
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(arg)) continue;
    // A workspace file is not a working directory. Its constituent roots are resolved by metadata.
    if (/\.code-workspace$/iu.test(arg)) return (win32.isAbsolute(arg) ? win32 : posix).dirname(arg);
    return arg || null;
  }
  return null;
}

function resolveWorkingDirectory(
  commandLine: string | null,
  processCwd?: string | null,
  kind?: 'cli' | 'desktop',
  arguments_?: readonly string[],
): string | null {
  const explicit = extractWorkingDirectory(commandLine, arguments_) ??
    (kind === 'desktop' ? desktopProjectDirectory(commandLine, arguments_) : null);
  if (explicit === null) return processCwd ?? null;
  const paths = /^[a-z]:[\\/]|^[\\]{2}/iu.test(explicit) || /^[a-z]:[\\/]|^[\\]{2}/iu.test(processCwd ?? '') ? win32 : posix;
  if (paths.isAbsolute(explicit)) return explicit;
  // A relative flag has no identity without its launching directory.
  return processCwd ? paths.resolve(processCwd, explicit) : null;
}
