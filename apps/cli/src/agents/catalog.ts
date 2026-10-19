import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, win32 } from 'node:path';
import { AgentSessionError, type AgentCatalog, type AgentTool } from './types.js';

export const AGENT_PRESETS: readonly { id: AgentTool; label: string; command?: string; packageName?: string }[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', packageName: '@anthropic-ai/claude-code' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', packageName: 'opencode-ai' },
  { id: 'codex', label: 'Codex', command: 'codex', packageName: '@openai/codex' },
  { id: 'dsh', label: 'DeepSeek Harness', command: 'dsh', packageName: '@deepseek-ai/dsh' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', packageName: '@google/gemini-cli' },
  { id: 'shell', label: '终端' },
  { id: 'custom', label: '自定义智能体' },
];

export function environmentPath(env: NodeJS.ProcessEnv): string {
  return Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
}

export function defaultShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  return platform === 'win32' ? 'powershell.exe' : env.SHELL || '/bin/bash';
}

export async function resolveExecutable(command: string, options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const paths = platform === 'win32' ? win32 : { isAbsolute, join, resolve };
  const extensions = platform === 'win32' && !/\.(exe|com|ps1|cmd|bat)$/iu.test(command)
    ? ['.exe', '.com', '.ps1', '.cmd', '.bat', ''] : [''];
  const explicit = paths.isAbsolute(command) || /[/\\]/u.test(command);
  const directories = explicit ? [options.cwd ?? process.cwd()]
    : environmentPath(env).split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  for (const directory of directories) {
    const base = explicit ? paths.resolve(directory, command) : paths.join(directory.replace(/^"(.*)"$/u, '$1'), command);
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

export async function agentCatalog(platform = process.platform, env = process.env, defaultCwd = homedir()): Promise<AgentCatalog> {
  const tools = await Promise.all(AGENT_PRESETS.map(async (preset) => {
    const command = preset.id === 'shell' ? defaultShell(platform, env) : preset.command;
    const resolved = command === undefined ? null : await resolveExecutable(command, { platform, env });
    return {
      id: preset.id,
      label: preset.label,
      command: resolved,
      available: preset.id === 'custom' || resolved !== null,
      ...(preset.packageName === undefined ? {} : { installCommand: `npm install -g ${preset.packageName}` }),
    };
  }));
  return { platform, defaultCwd, tools };
}

/** Native executables receive argv directly; PowerShell scripts receive literal, encoded arguments. */
export function terminalCommand(command: string, args: readonly string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv): {
  command: string; args: string[] | string;
} {
  if (platform !== 'win32') return { command, args: [...args] };
  if (/\.ps1$/iu.test(command)) {
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const script = `& ${literal(command)} ${args.map(literal).join(' ')}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
    const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
    return {
      command: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    };
  }
  if (/\.(cmd|bat)$/iu.test(command)) {
    // cmd expands %variables% even inside quotes. Refuse values it cannot carry literally.
    if ([command, ...args].some((value) => /["%!\r\n]/u.test(value))) {
      throw new AgentSessionError(400, 'Windows 批处理路径或参数包含无法原样传递的字符，请改用 .exe 或 .ps1 启动。');
    }
    return {
      command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
      args: `/d /s /c "${[command, ...args].map((value) => `"${value}"`).join(' ')}"`,
    };
  }
  return { command, args: [...args] };
}
