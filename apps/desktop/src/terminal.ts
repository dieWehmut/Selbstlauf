import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, win32 } from 'node:path';

export interface TerminalSession {
  readonly id: string;
  readonly workingDirectory?: string | null;
  readonly sessionCwd?: string | null;
  readonly cwd?: string | null;
  readonly distribution?: string;
}

export interface TerminalResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly terminal?: string;
}

export interface TerminalCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly terminal: string;
}

export function windowsTerminalLaunchScript(command: TerminalCommand): string {
  const quoted = command.args.map((value) => `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`).join(' ');
  return `$p = Start-Process -FilePath ${psLiteral(command.executable)} -ArgumentList ${psLiteral(quoted)} -WorkingDirectory ${psLiteral(command.cwd)} -WindowStyle Normal -PassThru -ErrorAction Stop; $p.Id`;
}

/** Start-Process gives console applications a real visible console on Windows.
 * Node's detached spawn with ignored standard handles lets PowerShell exit before
 * it opens an interactive prompt, even though the spawn event reports success.
 */
export async function launchWindowsTerminal(command: TerminalCommand, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const powershell = win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = windowsTerminalLaunchScript(command);
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); finish(new Error('打开终端超时。')); }, 15_000);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // A console host can inherit the helper's pipe handles. Waiting for their
      // close event would wait for the user's terminal to close as well.
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      if (error) reject(error); else resolve();
    };
    child.stdout?.on('data', (data) => { stdout += String(data); if (/^\d+\r?\n/u.test(stdout)) finish(); });
    child.stderr?.on('data', (data) => { stderr += String(data); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => { if (!/^\d+\r?\n/u.test(stdout)) finish(new Error(stderr.trim() || `终端启动失败 (${code})。`)); });
  });
}

const TERMINALS: Readonly<Record<string, readonly string[]>> = {
  win32: ['system', 'cmd', 'powershell', 'windows-terminal'],
  linux: ['system', 'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'],
  darwin: ['system', 'terminal', 'iterm'],
};

const psLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export async function terminalExecutable(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<string | null> {
  const paths = platform === 'win32' ? win32 : { join, isAbsolute };
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const directories = paths.isAbsolute(command) ? [''] : path.split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = directory ? paths.join(directory.replace(/^"(.*)"$/u, '$1'), command) : command;
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

/** The renderer names a session; only the service may supply its actual directory. */
export async function resolveTerminalCommand(session: TerminalSession, preference: string | null, options: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly findExecutable?: (command: string) => Promise<string | null>;
  readonly fallbackCwd?: string;
} = {}): Promise<TerminalCommand> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const preferred = preference ?? 'system';
  if (!TERMINALS[platform]?.includes(preferred)) throw new Error(`当前系统不支持首选终端“${preferred}”，请在设置中重新选择。`);
  const cwd = session.sessionCwd ?? session.workingDirectory ?? session.cwd;
  if (!cwd || /[\0\r\n]/u.test(cwd)) throw new Error('无法读取该会话的工作目录。');
  const wsl = platform === 'win32' && session.distribution !== undefined;
  if (!(wsl ? cwd.startsWith('/') : (platform === 'win32' ? win32.isAbsolute(cwd) : isAbsolute(cwd)))) {
    throw new Error('会话工作目录不是有效的绝对路径。');
  }
  const find = options.findExecutable ?? ((command: string) => terminalExecutable(command, platform, env));
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
    const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const choices = preferred === 'system' ? ['windows-terminal', 'powershell'] : [preferred];
    for (const terminal of choices) {
      const command = terminal === 'windows-terminal' ? 'wt.exe' : terminal === 'cmd' ? env.ComSpec ?? env.COMSPEC ?? 'cmd.exe' : powershell;
      const executable = await find(command);
      if (executable === null) continue;
      const launchCwd = wsl ? options.fallbackCwd ?? homedir() : cwd;
      const wslArgs = wsl ? ['--distribution', session.distribution!, '--cd', cwd] : [];
      // Encoded PowerShell literals carry even WSL paths containing quotes,
      // percent signs or shell operators without cmd interpreting them.
      const wslScript = `& wsl.exe ${wslArgs.map(psLiteral).join(' ')}`;
      const encoded = Buffer.from(wslScript, 'utf16le').toString('base64');
      const args = terminal === 'windows-terminal'
        ? ['-d', launchCwd, ...(wsl ? ['wsl.exe', ...wslArgs] : [])]
        : terminal === 'cmd'
          ? ['/d', '/k', ...(wsl ? [`powershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded}`] : [])]
          : ['-NoLogo', '-NoProfile', '-NoExit', ...(wsl ? ['-EncodedCommand', encoded] : [])];
      return { executable, args, cwd: launchCwd, terminal };
    }
  } else if (platform === 'darwin') {
    return { executable: '/usr/bin/open', args: ['-a', preferred === 'iterm' ? 'iTerm' : 'Terminal', cwd], cwd, terminal: preferred === 'system' ? 'terminal' : preferred };
  } else {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) throw new Error('当前会话没有图形桌面，无法打开终端窗口。');
    const choices = preferred === 'system' ? TERMINALS.linux.filter((entry) => entry !== 'system') : [preferred];
    for (const terminal of choices) {
      const executable = await find(terminal);
      if (executable === null) continue;
      const args = terminal === 'gnome-terminal' ? ['--working-directory', cwd] : terminal === 'konsole' ? ['--workdir', cwd] : [];
      return { executable, args, cwd, terminal };
    }
  }
  throw new Error(`未找到终端“${preferred}”。请安装该终端或在设置中选择其他终端。`);
}

export async function openSessionTerminal(sessionId: string, options: {
  readonly sessions: () => Promise<readonly TerminalSession[]>;
  readonly preference: () => Promise<string | null>;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly findExecutable?: (command: string) => Promise<string | null>;
  readonly spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}): Promise<TerminalResult> {
  try {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('会话编号无效。');
    const session = (await options.sessions()).find((entry) => entry.id === sessionId);
    if (session === undefined) throw new Error('该会话已不在运行。');
    const command = await resolveTerminalCommand(session, await options.preference(), options);
    if ((options.platform ?? process.platform) === 'win32' && options.spawnImpl === undefined) {
      await launchWindowsTerminal(command, options.env);
      return { ok: true, terminal: command.terminal };
    }
    const child = (options.spawnImpl ?? spawn)(command.executable, command.args, {
      cwd: command.cwd, env: options.env ?? process.env, detached: true, stdio: 'ignore', windowsHide: false,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    child.unref();
    return { ok: true, terminal: command.terminal };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
