import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawProcessRecord } from './process-provider.js';
import { MONITOR_ONLY_TOOL_NAMES, type ToolName } from '../domain/types.js';
import {
  classifySessionHost,
  hostAppFor,
  type HarnessHostHint,
  type SessionHost,
} from './host-apps.js';

export type DiscoveredTool = ToolName;

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
  /** A real App Server subcommand on this process or a folded Codex child. */
  readonly codexAppServer?: boolean;
  /** Current process is verified, but its last known thread ownership could not be refreshed. */
  readonly codexThreadOwnershipPending?: boolean;
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

const DEFAULT_CLAUDE_EXECUTABLE_NAMES = ['claude', 'claude.ps1', 'claude.cmd', 'claude.exe'];
const DEFAULT_CODEX_EXECUTABLE_NAMES = ['codex', 'codex.exe', 'codex.cmd', 'codex.ps1'];
const DEFAULT_DSH_EXECUTABLE_NAMES = ['dsh', 'dsh.exe', 'dsh.cmd', 'dsh.ps1'];
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

/** A process title and argv[0] can be renamed; a resolved executable takes precedence. */
function processImage(record: RawProcessRecord): string {
  return record.executablePath ?? commandArguments(record.commandLine, record.arguments)[0] ?? record.name;
}

const RUNTIME_VALUE_OPTIONS = new Set([
  '--require', '-r', '--import', '--loader', '--experimental-loader', '--title', '--conditions', '-C',
  '--input-type', '--diagnostic-dir', '--redirect-warnings', '--openssl-config', '--icu-data-dir',
  '--inspect-port', '--inspect-publish-uid', '--dns-result-order', '--unhandled-rejections', '--disable-proto',
  '--env-file', '--env-file-if-exists', '--experimental-default-type', '--experimental-policy', '--policy-integrity',
  '--experimental-config-file', '--experimental-sea-config', '--experimental-package-map',
  '--cpu-prof-dir', '--cpu-prof-name', '--cpu-prof-interval', '--heap-prof-dir', '--heap-prof-name', '--heap-prof-interval',
  '--report-directory', '--report-filename', '--report-signal', '--snapshot-blob', '--heapsnapshot-signal',
  '--trace-event-categories', '--trace-event-file-pattern', '--max-http-header-size', '--security-revert',
  '--cwd', '--preload', '--config',
]);

interface RuntimeInvocation {
  readonly entry: string;
  readonly args: readonly string[];
}

/** The executed script and only its own argv, never interpreter options or eval text. */
function runtimeInvocation(record: RawProcessRecord): RuntimeInvocation | null {
  const args = commandArguments(record.commandLine, record.arguments);
  const invocationAt = (index: number): RuntimeInvocation | null => {
    const entry = args[index];
    return entry === undefined ? null : { entry, args: args.slice(index + 1) };
  };
  const runtime = (basename(processImage(record)) ?? '').replace(/\.exe$/u, '');
  if (/^(?:powershell|pwsh)$/u.test(runtime)) {
    // -File proves a script invocation. -Command and encoded shell programs do
    // not prove the identity of a live CLI; their native/Node children do.
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index]!.toLowerCase();
      if (arg === '-file' || arg === '-f') return invocationAt(index + 1);
      if (['-executionpolicy', '-windowstyle', '-inputformat', '-outputformat', '-workingdirectory'].includes(arg)) { index += 1; continue; }
      if (!['-nologo', '-noprofile', '-noninteractive', '-noexit', '-sta', '-mta'].includes(arg)) return null;
    }
    return null;
  }
  if (!/^(?:node|bun|sh|bash|zsh|python(?:\d+(?:\.\d+)?)?)$/u.test(runtime)) return null;
  const python = /^python/u.test(runtime);
  const shell = /^(?:sh|bash|zsh)$/u.test(runtime);
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-m') return python ? invocationAt(index + 1) : null;
    // Evaluation text is never an executable entry point, even if it mentions a package.
    if (python ? /^-c/u.test(arg) : shell ? /^-[^-]*c/u.test(arg) : /^(?:--eval|--print)(?:=|$)|^-[ep]/u.test(arg)) return null;
    if (arg === '--') return invocationAt(index + 1);
    if (!arg.startsWith('-')) return invocationAt(index);
    if (python) {
      if (['-W', '-X', '--check-hash-based-pycs'].includes(arg)) { index += 1; continue; }
      if (/^-[WX].+/u.test(arg) || ['-b', '-B', '-d', '-E', '-i', '-I', '-O', '-OO', '-P', '-q', '-s', '-S', '-u', '-v', '-x'].includes(arg)) continue;
    } else if (shell) {
      if (['--rcfile', '--init-file', '-o', '-O'].includes(arg)) { index += 1; continue; }
      if (['-l', '--login', '--noprofile', '--norc', '-e', '-u', '-x', '-v', '-f', '-n', '-p', '-r'].includes(arg)) continue;
    } else {
      if (RUNTIME_VALUE_OPTIONS.has(arg)) { index += 1; continue; }
      if (arg.includes('=') || /^--(?:no-[a-z-]+|inspect(?:-brk|-wait)?|trace-(?:warnings|deprecation|uncaught|sync-io|exit|sigint)|enable-source-maps|experimental-(?:sqlite|strip-types|transform-types|require-module|vm-modules|import-meta-resolve|network-inspection|webstorage|global-webcrypto|fetch|test-module-mocks)|preserve-symlinks(?:-main)?|throw-deprecation|pending-deprecation|abort-on-uncaught-exception|use-strict)$/u.test(arg)) continue;
    }
    // An unsupported option may consume the next argument. Treating that value
    // as a script would let --title/conditions/etc. impersonate another agent.
    return null;
  }
  return null;
}

function runtimeEntry(record: RawProcessRecord): string | null {
  return runtimeInvocation(record)?.entry ?? null;
}

function executedAgentArguments(record: RawProcessRecord): readonly string[] {
  const invocation = runtimeInvocation(record);
  return invocation === null ? commandArguments(record.commandLine, record.arguments).slice(1) : invocation.args;
}

/** Codex global options may precede the subcommand; their values never name it. */
function codexCommandArguments(record: RawProcessRecord): readonly string[] {
  const args = executedAgentArguments(record);
  const values = new Set(['-c', '--config', '-C', '--cd', '--cwd', '-m', '--model', '-p', '--profile', '-i', '--image', '-s', '--sandbox', '-a', '--ask-for-approval', '--local-provider', '--enable', '--disable']);
  const switches = new Set(['--oss', '--search', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') return [];
    if (!arg.startsWith('-')) return args.slice(index);
    if (values.has(arg)) { index++; continue; }
    if (switches.has(arg)) continue;
    const equals = arg.indexOf('=');
    if (equals > 0 && values.has(arg.slice(0, equals))) continue;
    if (/^-[cCmpisa].+/u.test(arg)) continue;
    return [];
  }
  return [];
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
  if (!/^(?:cursor|antigravity|claude|trae(?: cn)?|zcode|z code|workbuddy(?:ai)?|craft[- ]agents)(?:\.exe)?$/u.test(parts.at(-1) ?? '')) return null;
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

const ADDITIONAL_CLI_ENTRIES: readonly { tool: DiscoveredTool; names: readonly string[]; packageEntry?: RegExp }[] = [
  // npm 1.0.77 runs bin/grok through Node on Windows and installs a
  // bin/grok-native target on Unix. Canonical native files are versioned.
  { tool: 'grok', names: ['grok'], packageEntry: /(?:^|\/)@xai-official\/grok(?:-(?:linux|darwin|win32)-(?:arm64|x64))?\/bin\/grok(?:-native)?(?:\.exe)?$|(?:^|\/)grok-\d+\.\d+\.\d+(?:\.exe)?$/u },
  { tool: 'opencode', names: ['opencode'], packageEntry: /(?:^|\/)(?:opencode-ai\/bin\/opencode(?:\.exe)?|opencode-(?:linux|darwin|windows)-[^/]+\/bin\/opencode(?:\.exe)?)$/u },
  { tool: 'qwen', names: ['qwen'], packageEntry: /(?:^|\/)@qwen-code\/qwen-code\/cli-entry\.js$/u },
  { tool: 'openclaw', names: ['openclaw'], packageEntry: /(?:^|\/)openclaw\/(?:openclaw\.mjs|dist\/index\.js)$/u },
  { tool: 'hermes', names: ['hermes'], packageEntry: /(?:^|\/)(?:hermes-agent\/hermes_cli\/main\.py|hermes_cli\/main\.py)$|^hermes_cli(?:\.main)?$/u },
  { tool: 'pi', names: ['pi'], packageEntry: /(?:^|\/)@(?:mariozechner|earendil-works)\/pi-coding-agent\/dist\/(?:bundle\/)?cli\.js$/u },
  { tool: 'crush', names: ['crush'], packageEntry: /(?:^|\/)@charmland\/crush\/run-crush\.js$/u },
  { tool: 'cline', names: ['cline'], packageEntry: /(?:^|\/)(?:cline\/bin\/\.?cline|@cline\/cli-(?:linux|darwin|windows)-[^/]+\/bin\/cline)(?:\.exe)?$/u },
  { tool: 'kilo', names: ['kilo', 'kilocode'], packageEntry: /(?:^|\/)@kilocode\/cli(?:-(?:linux|darwin|windows)-[^/]+)?\/bin\/\.?kilo(?:\.exe)?$/u },
];

const ADDITIONAL_DESKTOP_NAMES: readonly { tool: DiscoveredTool; names: readonly string[] }[] = [
  { tool: 'trae', names: ['trae', 'trae cn'] },
  { tool: 'zcode', names: ['zcode', 'z code'] },
  // URLs and arbitrary argv cannot prove an edition. The separately observed
  // WorkBuddyAI executable does; a shared WorkBuddy image stays product-level.
  { tool: 'workbuddy', names: ['workbuddy'] },
  { tool: 'workbuddy-intl', names: ['workbuddyai'] },
  { tool: 'craft-agents', names: ['craft-agents', 'craft agents'] },
];

function launcherName(value: string | null): string {
  return (basename(value) ?? '').replace(/\.(?:exe|cmd|ps1)$/u, '');
}

/** Claude Desktop and the CLI share an image name; its install directory distinguishes them. */
function claudeDesktop(record: RawProcessRecord): boolean {
  if (launcherName(record.executablePath ?? record.name) !== 'claude') return false;
  const parts = pathParts(record.executablePath ?? commandArguments(record.commandLine, record.arguments)[0] ?? null);
  return parts.includes('anthropicclaude') || parts.includes('claude.app') ||
    parts.some(part => /^anthropic\.claude_[^/]+$/u.test(part));
}

function additionalProcessTool(record: RawProcessRecord, entry: string | null, electronEntry: string | null): DiscoveredTool | null {
  const candidates = [launcherName(processImage(record))];
  const scriptName = launcherName(entry);
  const script = pathParts(entry).join('/');
  for (const preset of ADDITIONAL_CLI_ENTRIES) {
    if (candidates.some(name => preset.names.includes(name)) || preset.names.includes(scriptName) ||
      preset.packageEntry?.test(script) || preset.packageEntry?.test(pathParts(record.executablePath).join('/'))) return preset.tool;
  }
  // VS Code extension hosts have no per-extension process identity. Only an
  // independently executed entry inside the official Roo installation qualifies.
  if (/(?:^|\/)rooveterinaryinc\.roo-cline-[^/]+\/dist\/extension\.(?:js|cjs)$/u.test(script)) return 'roo';
  if (isElectronHelper(record) || electronEntry !== null) return null;
  if (claudeDesktop(record)) return 'claude-app';
  return ADDITIONAL_DESKTOP_NAMES.find(preset => candidates.some(name => preset.names.includes(name)))?.tool ?? null;
}

function processKind(record: RawProcessRecord, tool: DiscoveredTool): 'cli' | 'desktop' | undefined {
  if (ADDITIONAL_DESKTOP_NAMES.some(preset => preset.tool === tool) || tool === 'claude-app') return 'desktop';
  if ((MONITOR_ONLY_TOOL_NAMES as readonly string[]).includes(tool)) return 'cli';
  if (tool === 'gemini') return 'cli';
  if (tool === 'cursor') {
    return cursorCliPath(processImage(record)) || cursorCliPath(runtimeEntry(record))
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
  const actualName = basename(processImage(record));
  return names.some((name) => {
    const normalized = basename(name);
    return normalized !== null && normalized === actualName;
  });
}

function entryPathEndsWith(path: string, token: string): boolean {
  const source = pathParts(path).join('/');
  const normalizedToken = pathParts(token).join('/');
  return source === normalizedToken || source.endsWith(`/${normalizedToken}`);
}

/** Return a tool only when the process has one unambiguous known signature. */
export function detectProcessTool(
  record: RawProcessRecord,
  options: ProcessNameOptions = {},
): DiscoveredTool | null {
  const claudeNames = options.claudeExecutableNames ?? DEFAULT_CLAUDE_EXECUTABLE_NAMES;
  const codexNames = options.codexExecutableNames ?? DEFAULT_CODEX_EXECUTABLE_NAMES;
  const dshNames = options.dshExecutableNames ?? DEFAULT_DSH_EXECUTABLE_NAMES;
  const entry = runtimeEntry(record);
  const electronEntry = electronScriptEntry(record);
  const additional = additionalProcessTool(record, entry, electronEntry);
  if (additional !== null) return additional;
  // A desktop child using Claude's image is never a Claude Code CLI.
  if (claudeDesktop(record)) return null;
  const isGemini = configuredNameMatches(record, options.geminiExecutableNames ?? DEFAULT_GEMINI_EXECUTABLE_NAMES) ||
    geminiEntry(entry);
  const cursorCli = cursorCliPath(processImage(record)) || cursorCliPath(entry);
  const isCursor = cursorCli || cursorDesktopEntry(entry ?? electronEntry) || (!isElectronHelper(record) && electronEntry === null &&
    configuredNameMatches(record, options.cursorExecutableNames ?? DEFAULT_CURSOR_EXECUTABLE_NAMES));
  const isAntigravity = antigravityHelper(record) || (!isElectronHelper(record) && electronEntry === null &&
    configuredNameMatches(record, options.antigravityExecutableNames ?? DEFAULT_ANTIGRAVITY_EXECUTABLE_NAMES));
  // Only the executed entry contributes package identity. Its trailing prompt,
  // preload/eval strings and the interpreter's own path never do.
  const entryPath = entry ?? '';
  const entryName = basename(entry);

  const isClaude =
    configuredNameMatches(record, claudeNames) ||
    DEFAULT_CLAUDE_EXECUTABLE_NAMES.includes(entryName ?? '') ||
    entryPathEndsWith(entryPath, 'claude-code/cli.js');
  const isCodex =
    configuredNameMatches(record, codexNames) ||
    DEFAULT_CODEX_EXECUTABLE_NAMES.includes(entryName ?? '') ||
    entryPathEndsWith(entryPath, '@openai/codex/bin/codex.js');
  const isDsh =
    configuredNameMatches(record, dshNames) ||
    DEFAULT_DSH_EXECUTABLE_NAMES.includes(entryName ?? '') ||
    DSH_ENTRY_TOKENS.some((token) => entryPathEndsWith(entryPath, token));
  const agentArgs = isCodex ? codexCommandArguments(record) : executedAgentArguments(record);
  // This observed daemon child only maintains the owner's PID file. The
  // listening App Server remains discoverable because it hosts real threads.
  if (isCodex && agentArgs[0] === 'app-server' && agentArgs[1] === 'daemon' && agentArgs[2] === 'pid-update-loop') return null;
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
      const workingDirectory = resolveWorkingDirectory(root, desktopHelper ? undefined : kind);
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
        ...(tool === 'codex' && [root.pid, ...childPids].some(pid => {
          const record = byPid.get(pid);
          return record !== undefined && codexCommandArguments(record)[0] === 'app-server';
        }) ? { codexAppServer: true } : {}),
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

function extractWorkingDirectory(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--') break;
    if (['--prompt', '-p', '--system-prompt', '--system-prompt-file'].includes(args[index]!)) { index++; continue; }
    const flag = /^(?:--cd|--cwd|--directory|-C)(?:=(.*))?$/u.exec(args[index]!);
    if (!flag) continue;
    const value = flag[1] ?? args[index + 1];
    if (value && !value.startsWith('-')) return value;
  }
  return null;
}

function desktopProjectDirectory(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') break;
    if (['--prompt', '-p', '--system-prompt', '--system-prompt-file'].includes(arg)) { index++; continue; }
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
  for (const flag of ['--prompt', '-p', '--system-prompt', '--system-prompt-file']) valueFlags.add(flag);
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
  record: RawProcessRecord,
  kind?: 'cli' | 'desktop',
): string | null {
  const args = runtimeInvocation(record)?.args ?? commandArguments(record.commandLine, record.arguments).slice(1);
  const processCwd = record.workingDirectory;
  const explicit = extractWorkingDirectory(args) ??
    (kind === 'desktop' ? desktopProjectDirectory(args) : null);
  if (explicit === null) return processCwd ?? null;
  const paths = /^[a-z]:[\\/]|^[\\]{2}/iu.test(explicit) || /^[a-z]:[\\/]|^[\\]{2}/iu.test(processCwd ?? '') ? win32 : posix;
  if (paths.isAbsolute(explicit)) return explicit;
  // A relative flag has no identity without its launching directory.
  return processCwd ? paths.resolve(processCwd, explicit) : null;
}
