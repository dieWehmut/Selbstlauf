import { execFile } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import { AGENT_REGISTRY } from './registry.js';
import type { AgentInstallation, AgentTool } from './types.js';

const execute = promisify(execFile);
const MISSING = new Set(['ENOENT', 'ENOTDIR']);
const EXTENSIONS: Partial<Record<AgentTool, string>> = {
  claude: 'anthropic.claude-code', cline: 'saoudrizwan.claude-dev',
  kilo: 'kilocode.kilo-code', roo: 'rooveterinaryinc.roo-cline',
};

interface DesktopIdentity {
  windows: readonly string[];
  folders: readonly string[];
  mac: readonly string[];
  linux: readonly string[];
  registry: RegExp;
  appx?: RegExp;
}

/** Exact executable/product identities; a directory name alone never proves installation. */
const DESKTOPS: Partial<Record<AgentTool, DesktopIdentity>> = {
  codex: { windows: ['Codex.exe'], folders: ['Codex'], mac: ['Codex'], linux: [], registry: /^Codex(?:\s+\d|$)/iu, appx: /^OpenAI\.Codex$/iu },
  'claude-app': { windows: ['Claude.exe'], folders: ['AnthropicClaude', 'Claude'], mac: ['Claude'], linux: [],
    registry: /^Claude(?:\s+(?:\d|\()|$)/iu, appx: /^Anthropic(?:PBC)?\.Claude(?:Desktop)?$/iu },
  trae: { windows: ['Trae.exe'], folders: ['Trae', 'TRAE CN'], mac: ['Trae', 'TRAE'], linux: ['trae'], registry: /^TRAE(?:\s+(?:\d|\(|CN)|$)/iu },
  zcode: { windows: ['ZCode.exe'], folders: ['ZCode'], mac: ['ZCode'], linux: ['zcode'], registry: /^ZCode(?:\s+\d|$)/iu },
  workbuddy: { windows: ['WorkBuddy.exe'], folders: ['WorkBuddy'], mac: ['WorkBuddy'], linux: ['workbuddy'], registry: /^WorkBuddy(?:\s+\d|$)/iu },
  'workbuddy-intl': { windows: ['WorkBuddyAI.exe'], folders: ['WorkBuddyAI'], mac: ['WorkBuddyAI'], linux: ['workbuddyai'], registry: /^WorkBuddy AI(?:\s+\d|$)/iu },
  'craft-agents': { windows: ['Craft Agents.exe', 'craft-agents.exe'], folders: ['@craft-agentelectron', 'Craft Agents', 'craft-agents'],
    mac: ['Craft Agents'], linux: ['craft-agents'], registry: /^Craft Agents(?:\s+\d|$)/iu },
  antigravity: { windows: ['Antigravity.exe'], folders: ['antigravity'], mac: ['Antigravity'], linux: ['antigravity'], registry: /^Antigravity(?:\s+\d|$)/iu },
  cursor: { windows: ['Cursor.exe'], folders: ['cursor'], mac: ['Cursor'], linux: ['cursor'], registry: /^Cursor(?:\s+(?:\d|\()|$)/iu },
};

export interface InstallationFileSystem {
  isExecutableFile(path: string, platform: NodeJS.Platform): Promise<boolean>;
  directories(path: string): Promise<string[]>;
  json(path: string): Promise<unknown>;
}

const nativeFiles: InstallationFileSystem = {
  async isExecutableFile(path, platform) {
    if (!(await stat(path)).isFile()) return false;
    await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  },
  async directories(path) {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  },
  async json(path) { return JSON.parse(await readFile(path, 'utf8')) as unknown; },
};

export interface WindowsInstallationSnapshot {
  registry: { displayName: string; installLocation: string | null; displayIcon: string | null }[];
  appx: { name: string; installLocation: string }[];
  processes: { executablePath: string }[];
  errors: string[];
}

function environment(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
}

/** One bounded, hidden read-only system query. It never invokes an agent or opens an application. */
export async function readWindowsInstallation(env: NodeJS.ProcessEnv, timeoutMs = 1800): Promise<WindowsInstallationSnapshot> {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$result = @{registry=@();appx=@();processes=@();errors=@()}
foreach ($root in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
  try {
    if (Test-Path -LiteralPath $root) {
      $result.registry += @(Get-ChildItem -LiteralPath $root | ForEach-Object {
        $item = Get-ItemProperty -LiteralPath $_.PSPath
        if ($item.DisplayName) { @{displayName=[string]$item.DisplayName;installLocation=$item.InstallLocation;displayIcon=$item.DisplayIcon} }
      })
    }
  } catch { $result.errors += 'registry' }
}
try { $result.appx = @(Get-AppxPackage | ForEach-Object { @{name=[string]$_.Name;installLocation=[string]$_.InstallLocation} }) } catch { $result.errors += 'appx' }
try { $result.processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { @{executablePath=[string]$_.ExecutablePath} }) } catch { $result.errors += 'processes' }
ConvertTo-Json -InputObject $result -Depth 5 -Compress
`;
  const executable = win32.join(environment(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execute(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
  const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/u, ''));
  if (!value || typeof value !== 'object') throw new Error('Invalid installation response');
  const record = value as Record<string, unknown>;
  if (!['registry', 'appx', 'processes', 'errors'].every((key) => Array.isArray(record[key]))) throw new Error('Incomplete installation response');
  const object = (entry: unknown): entry is Record<string, unknown> => !!entry && typeof entry === 'object';
  const nullable = (entry: unknown) => typeof entry === 'string' ? entry : null;
  return {
    registry: (record.registry as unknown[]).filter(object).filter((entry) => typeof entry.displayName === 'string').map((entry) => ({
      displayName: entry.displayName as string, installLocation: nullable(entry.installLocation), displayIcon: nullable(entry.displayIcon),
    })),
    appx: (record.appx as unknown[]).filter(object).filter((entry) => typeof entry.name === 'string' && typeof entry.installLocation === 'string')
      .map((entry) => ({ name: entry.name as string, installLocation: entry.installLocation as string })),
    processes: (record.processes as unknown[]).filter(object).filter((entry) => typeof entry.executablePath === 'string')
      .map((entry) => ({ executablePath: entry.executablePath as string })),
    errors: (record.errors as unknown[]).filter((entry): entry is string => typeof entry === 'string'),
  };
}

export interface InstallationOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Injectable read-only providers allow platform tests without touching another host's filesystem. */
  files?: InstallationFileSystem;
  windows?: () => Promise<WindowsInstallationSnapshot>;
}

const cache = new Map<string, { expires: number; pending: Promise<Map<AgentTool, AgentInstallation>> }>();

function allUnknown(reason: string): Map<AgentTool, AgentInstallation> {
  return new Map(AGENT_REGISTRY.filter((entry) => entry.kind !== 'shell' && entry.kind !== 'custom')
    .map((entry) => [entry.id, { status: 'unknown', reason }]));
}

export async function detectAgentInstallations(options: InstallationOptions = {}): Promise<Map<AgentTool, AgentInstallation>> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? environment(env, platform === 'win32' ? 'USERPROFILE' : 'HOME') ?? (platform === process.platform ? homedir() : undefined);
  if (platform !== process.platform && options.files === undefined) return allUnknown('无法读取另一平台的本机安装信息。');
  if (!home) return allUnknown('无法确定本机用户目录。');
  const timeoutMs = options.timeoutMs ?? 2400;
  const cacheTtlMs = options.cacheTtlMs ?? 10_000;
  const custom = options.files !== undefined || options.windows !== undefined;
  const key = JSON.stringify([platform, home, environment(env, 'LOCALAPPDATA'), environment(env, 'ProgramFiles'), environment(env, 'ProgramFiles(x86)')]);
  const cached = custom ? undefined : cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.pending;
  const pending = bounded(scan(platform, env, home, options.files ?? nativeFiles, options.windows, timeoutMs).catch(() => allUnknown('无法读取本机安装信息。')), timeoutMs,
    () => allUnknown('本机安装检测超时，请稍后重新检测。'));
  if (!custom && cacheTtlMs > 0) {
    if (cache.size >= 16) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + cacheTtlMs, pending });
  }
  return pending;
}

async function bounded<T>(pending: Promise<T>, timeoutMs: number, fallback: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([pending, new Promise<T>((done) => { timer = setTimeout(() => done(fallback()), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function scan(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string, files: InstallationFileSystem,
  windows: InstallationOptions['windows'], timeoutMs: number): Promise<Map<AgentTool, AgentInstallation>> {
  const paths = platform === 'win32' ? win32 : posix;
  const result = new Map<AgentTool, AgentInstallation>();
  let snapshot: WindowsInstallationSnapshot = { registry: [], appx: [], processes: [], errors: [] };
  const windowsPending = platform === 'win32' ? (windows ?? (() => readWindowsInstallation(env, Math.max(100, timeoutMs - 200))))()
    .then((value) => { snapshot = value; }).catch(() => { snapshot.errors.push('windows'); }) : Promise.resolve();
  const extensionsPending = findExtensions(platform, home, files);
  const desktopPending = Promise.all(Object.entries(DESKTOPS).map(async ([id, identity]) => {
    const candidates = desktopPaths(platform, env, home, identity!);
    let uncertain = candidates.length === 0;
    for (const path of candidates) {
      try {
        if (await files.isExecutableFile(path, platform)) { result.set(id as AgentTool, { status: 'installed', path, source: 'standard-location' }); return; }
      } catch (cause) { if (!missing(cause)) uncertain = true; }
    }
    // Claude's Windows updater keeps executables in versioned app-* directories.
    if (platform === 'win32' && id === 'claude-app') {
      const root = paths.join(environment(env, 'LOCALAPPDATA') ?? paths.join(home, 'AppData', 'Local'), 'AnthropicClaude');
      try {
        for (const directory of (await files.directories(root)).filter((name) => /^app-\d/u.test(name)).sort().reverse()) {
          const path = paths.join(root, directory, 'Claude.exe');
          if (await files.isExecutableFile(path, platform)) { result.set(id as AgentTool, { status: 'installed', path, source: 'standard-location' }); return; }
        }
      } catch (cause) { if (!missing(cause)) uncertain = true; }
    }
    result.set(id as AgentTool, uncertain ? { status: 'unknown', reason: '无法完整读取本机安装位置。' } : { status: 'not-found' });
  }));
  await Promise.all([windowsPending, desktopPending]);
  if (platform === 'win32') {
    await Promise.all(Object.entries(DESKTOPS).map(async ([id, identity]) => {
      if (result.get(id as AgentTool)?.status === 'installed') return;
      const candidates: { path: string; source: AgentInstallation['source'] }[] = [];
      for (const entry of snapshot.registry.filter((item) => identity!.registry.test(item.displayName))) {
        const icon = entry.displayIcon?.replace(/,\s*-?\d+\s*$/u, '').replace(/^"(.*)"$/u, '$1');
        if (icon && paths.isAbsolute(icon)) {
          if (identity!.windows.some((name) => name.toLowerCase() === paths.basename(icon).toLowerCase())) candidates.push({ path: icon, source: 'windows-registry' });
          for (const executable of identity!.windows) candidates.push({ path: paths.join(paths.dirname(icon), executable), source: 'windows-registry' });
        }
        if (entry.installLocation && paths.isAbsolute(entry.installLocation)) {
          for (const executable of identity!.windows) candidates.push({ path: paths.join(entry.installLocation, executable), source: 'windows-registry' });
        }
      }
      for (const entry of snapshot.appx.filter((item) => identity!.appx?.test(item.name))) {
        if (paths.isAbsolute(entry.installLocation)) {
          for (const executable of identity!.windows) {
            for (const relative of [executable, paths.join('app', executable)]) candidates.push({ path: paths.join(entry.installLocation, relative), source: 'windows-appx' });
          }
        }
      }
      for (const entry of snapshot.processes) {
        if (paths.isAbsolute(entry.executablePath) && identity!.windows.some((name) => name.toLowerCase() === paths.basename(entry.executablePath).toLowerCase())) {
          candidates.push({ path: entry.executablePath, source: 'running-executable' });
        }
      }
      let uncertain = snapshot.errors.length > 0 || result.get(id as AgentTool)?.status === 'unknown';
      for (const { path, source } of candidates) {
        try {
          if (await files.isExecutableFile(path, platform)) { result.set(id as AgentTool, { status: 'installed', path, source }); return; }
        } catch (cause) { if (!missing(cause)) uncertain = true; }
      }
      if (uncertain) result.set(id as AgentTool, { status: 'unknown', reason: '无法完整读取本机安装信息。' });
    }));
  }
  const extensions = await extensionsPending;
  for (const entry of AGENT_REGISTRY.filter((item) => item.kind !== 'shell' && item.kind !== 'custom')) {
    if (result.has(entry.id)) continue;
    const found = extensions.found.get(entry.id);
    result.set(entry.id, found?.length ? { status: 'installed', path: found[0].path, source: 'vscode-extension', extensions: found }
      : EXTENSIONS[entry.id] && extensions.uncertain ? { status: 'unknown', reason: '无法完整读取本机编辑器扩展。' } : { status: 'not-found' });
  }
  return result;
}

function missing(cause: unknown): boolean {
  return !!cause && typeof cause === 'object' && 'code' in cause && MISSING.has(String(cause.code));
}

function desktopPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string, identity: DesktopIdentity): string[] {
  if (platform === 'win32') {
    const local = environment(env, 'LOCALAPPDATA') ?? win32.join(home, 'AppData', 'Local');
    const roots = [win32.join(local, 'Programs'), local, environment(env, 'ProgramFiles'), environment(env, 'ProgramFiles(x86)')].filter((value): value is string => !!value);
    const candidates = roots.flatMap((root) => identity.folders.flatMap((folder) => identity.windows.map((exe) => win32.join(root, folder, exe))));
    if (identity.windows.includes('WorkBuddyAI.exe')) candidates.push(win32.join(home, 'WorkBuddy', 'WorkBuddyAI', 'WorkBuddyAI.exe'));
    return candidates;
  }
  if (platform === 'darwin') return ['/Applications', posix.join(home, 'Applications')].flatMap((root) => identity.mac.map((app) => posix.join(root, `${app}.app`, 'Contents', 'MacOS', app)));
  if (platform === 'linux') return identity.linux.flatMap((exe) => [posix.join('/usr/bin', exe), posix.join('/usr/local/bin', exe), posix.join(home, '.local/bin', exe),
    posix.join('/opt', exe, exe), posix.join('/usr/share', exe, exe), posix.join(home, '.local/share', exe, exe)]);
  return [];
}

async function findExtensions(platform: NodeJS.Platform, home: string, files: InstallationFileSystem) {
  const paths = platform === 'win32' ? win32 : posix;
  const found = new Map<AgentTool, { id: string; path: string }[]>();
  let uncertain = false;
  const roots = ['.vscode', '.vscode-insiders', '.cursor', '.windsurf', '.trae', '.vscode-oss'].map((editor) => paths.join(home, editor, 'extensions'));
  if (platform !== 'win32') roots.push(paths.join(home, '.vscode-server', 'extensions'), paths.join(home, '.vscode-server-insiders', 'extensions'));
  await Promise.all(roots.map(async (root) => {
    let directories: string[];
    try { directories = await files.directories(root); } catch (cause) { if (!missing(cause)) uncertain = true; return; }
    if (directories.length > 1024) { uncertain = true; directories = directories.slice(0, 1024); }
    await Promise.all(directories.map(async (directory) => {
      const path = paths.join(root, directory);
      try {
        const value = await files.json(paths.join(path, 'package.json'));
        if (!value || typeof value !== 'object') return;
        const manifest = value as { publisher?: unknown; name?: unknown; version?: unknown; engines?: { vscode?: unknown }; main?: unknown; browser?: unknown; __metadata?: { targetPlatform?: unknown } };
        if (typeof manifest.publisher !== 'string' || typeof manifest.name !== 'string') return;
        const identity = `${manifest.publisher}.${manifest.name}`.toLowerCase();
        const id = Object.entries(EXTENSIONS).find(([, extension]) => extension === identity)?.[0] as AgentTool | undefined;
        if (!id || typeof manifest.version !== 'string' || typeof manifest.engines?.vscode !== 'string') return;
        const target = manifest.__metadata?.targetPlatform;
        if (typeof target === 'string' && target !== 'universal' && target !== 'undefined' && !target.startsWith(`${platform}-`) && !(platform === 'linux' && target.startsWith('alpine-'))) return;
        const entry = typeof manifest.main === 'string' ? manifest.main : typeof manifest.browser === 'string' ? manifest.browser : null;
        if (!entry || paths.isAbsolute(entry) || entry.split(/[/\\]/u).includes('..')) return;
        // The published manifest and its entry must both exist; executable permission is unnecessary for JS.
        const actual = paths.join(path, entry);
        if (!(await files.isExecutableFile(actual, 'win32'))) return;
        const current = found.get(id) ?? [];
        current.push({ id: identity, path }); found.set(id, current);
      } catch (cause) { if (!missing(cause)) uncertain = true; }
    }));
  }));
  for (const values of found.values()) values.sort((a, b) => a.path.localeCompare(b.path));
  return { found, uncertain };
}
