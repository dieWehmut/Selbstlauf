import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AGENT_PRESETS, agentCatalog, defaultShell, resolveExecutable, terminalCommand } from './catalog.js';
import {
  AGENT_TOOLS, AgentSessionError,
  type AgentCatalog, type AgentLaunchRequest, type AgentOutput,
  type AgentPty, type AgentPtyBackend, type AgentSessionView,
} from './types.js';

interface ManagedSession {
  view: AgentSessionView;
  pty: AgentPty;
  output: string;
  baseOffset: number;
  offset: number;
  listeners: Set<() => void>;
  exit: Promise<void>;
}

export interface ManagedAgentOptions {
  backend?: AgentPtyBackend;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  defaultCwd?: string;
  maxOutputChars?: number;
  maxSessions?: number;
  onSessionsChanged?: () => void;
}

/** Owns real PTYs; browser disconnects never terminate their processes or redirect their input. */
export class ManagedAgentSessions {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly defaultCwd: string;
  private readonly maxOutputChars: number;
  private readonly maxSessions: number;
  private backend: Promise<AgentPtyBackend> | null;
  private closed = false;
  private launching = 0;

  constructor(private readonly options: ManagedAgentOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.defaultCwd = options.defaultCwd ?? homedir();
    this.maxOutputChars = options.maxOutputChars ?? 2 * 1024 * 1024;
    this.maxSessions = options.maxSessions ?? 32;
    this.backend = options.backend === undefined ? null : Promise.resolve(options.backend);
    if (!Number.isSafeInteger(this.maxOutputChars) || this.maxOutputChars < 1 ||
        !Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1) {
      throw new RangeError('Terminal output and session limits must be positive integers.');
    }
  }

  catalog(): Promise<AgentCatalog> {
    return agentCatalog(this.platform, this.env, this.defaultCwd);
  }

  list(): AgentSessionView[] {
    return [...this.sessions.values()].map((session) => this.copyView(session));
  }

  async launch(value: unknown): Promise<AgentSessionView> {
    const request = parseLaunch(value);
    if (this.closed) throw new AgentSessionError(503, '终端服务正在关闭。');
    if (this.sessions.size + this.launching >= this.maxSessions) {
      throw new AgentSessionError(409, `最多保留 ${this.maxSessions} 个窗口，请先关闭已结束的窗口。`);
    }
    this.launching += 1;
    try {
      const cwd = resolve(request.cwd?.trim() || this.defaultCwd);
      try {
        if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory');
      } catch {
        throw new AgentSessionError(400, `工作目录不存在或无法访问：${cwd}`);
      }
      const preset = AGENT_PRESETS.find((entry) => entry.id === request.tool)!;
      const name = request.command ?? (request.tool === 'shell' ? defaultShell(this.platform, this.env) : preset.command);
      if (name === undefined) throw new AgentSessionError(400, '请填写智能体的可执行命令。');
      const executable = await resolveExecutable(name, { platform: this.platform, env: this.env, cwd });
      if (executable === null) throw new AgentSessionError(400, `找不到命令 ${name}，请安装该工具或填写可执行文件的完整路径。`);
      const args = request.args ?? (request.tool === 'shell' && this.platform === 'win32' ? ['-NoLogo'] : []);
      const command = terminalCommand(executable, args, this.platform, this.env);
      const backend = await this.loadBackend();
      if (this.closed) throw new AgentSessionError(503, '终端服务正在关闭。');
      const cols = request.cols ?? 100;
      const rows = request.rows ?? 30;
      const env = Object.fromEntries(Object.entries(this.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      // Sessions started here must not inherit the enclosing Claude/Codex agent's nesting marker.
      delete env.CLAUDECODE;
      env.TERM = 'xterm-256color';
      env.COLORTERM = 'truecolor';
      let pty: AgentPty;
      try {
        pty = backend.spawn(command.command, command.args, { name: 'xterm-256color', cwd, cols, rows, env });
      } catch (error) {
        throw new AgentSessionError(409, `启动失败：${error instanceof Error ? error.message : String(error)}`);
      }
      let finish!: () => void;
      const session: ManagedSession = {
        view: {
          id: `agent-${randomUUID()}`, tool: request.tool, title: request.title ?? preset.label,
          command: executable, args: [...args], cwd, pid: pty.pid, status: 'running',
          startedAtMs: Date.now(), endedAtMs: null, exitCode: null, signal: null, cols, rows,
        },
        pty, output: '', baseOffset: 0, offset: 0, listeners: new Set(),
        exit: new Promise<void>((done) => { finish = done; }),
      };
      this.sessions.set(session.view.id, session);
      const dataListener = pty.onData((data) => {
        session.output += data;
        session.offset += data.length;
        if (session.output.length > this.maxOutputChars) {
          let start = session.output.length - this.maxOutputChars;
          // Preserve Unicode pairs at the replay boundary.
          if (start > 0 && /[\uDC00-\uDFFF]/u.test(session.output[start])) start += 1;
          session.output = session.output.slice(start);
          session.baseOffset = session.offset - session.output.length;
        }
        for (const listener of session.listeners) listener();
      });
      const exitListener = pty.onExit((event) => {
        session.view = { ...session.view, status: 'exited', endedAtMs: Date.now(), exitCode: event.exitCode, signal: event.signal ?? null };
        for (const listener of session.listeners) listener();
        this.options.onSessionsChanged?.();
        dataListener.dispose();
        exitListener.dispose();
        finish();
      });
      this.options.onSessionsChanged?.();
      return this.copyView(session);
    } finally { this.launching -= 1; }
  }

  output(id: string, after = 0): AgentOutput {
    const session = this.get(id);
    if (!Number.isSafeInteger(after) || after < 0) throw new AgentSessionError(400, '输出游标必须是非负整数。');
    const reset = after < session.baseOffset || after > session.offset;
    const fromOffset = reset ? session.baseOffset : after;
    return {
      data: session.output.slice(fromOffset - session.baseOffset), fromOffset,
      offset: session.offset, reset, session: this.copyView(session),
    };
  }

  subscribe(id: string, listener: () => void): () => void {
    const session = this.get(id);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  input(id: string, data: unknown): void {
    if (typeof data !== 'string' || data.length === 0 || data.length > 16384) {
      throw new AgentSessionError(400, '终端输入必须是 1–16384 个字符。');
    }
    this.running(id).pty.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown): AgentSessionView {
    validateDimensions(cols, rows);
    const session = this.running(id);
    session.pty.resize(cols as number, rows as number);
    session.view = { ...session.view, cols: cols as number, rows: rows as number };
    return this.copyView(session);
  }

  interrupt(id: string): void { this.input(id, '\x03'); }

  async terminate(id: string): Promise<AgentSessionView> {
    const session = this.get(id);
    if (session.view.status === 'exited') return this.copyView(session);
    if (session.view.status === 'running') {
      session.view = { ...session.view, status: 'stopping' };
      this.options.onSessionsChanged?.();
      for (const listener of session.listeners) listener();
      this.kill(session);
    }
    const timer = setTimeout(() => {
      if (session.view.status !== 'exited') {
        try { this.kill(session, 'SIGKILL'); } catch { /* Exit may be in flight. */ }
      }
    }, 1000);
    let timeout!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([session.exit, new Promise<never>((_done, reject) => {
        timeout = setTimeout(() => reject(new AgentSessionError(409, '进程还未确认退出，请稍后重试结束。')), 5000);
      })]);
    } finally { clearTimeout(timer); clearTimeout(timeout); }
    return this.copyView(session);
  }

  remove(id: string): void {
    const session = this.get(id);
    if (session.view.status !== 'exited') throw new AgentSessionError(409, '请先结束进程，再关闭这个窗口。');
    this.sessions.delete(id);
    this.options.onSessionsChanged?.();
  }

  async stop(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.keys()].map((id) => this.terminate(id)));
  }

  private get(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (session === undefined) throw new AgentSessionError(404, '智能体窗口不存在。');
    return session;
  }

  private running(id: string): ManagedSession {
    const session = this.get(id);
    if (session.view.status !== 'running') throw new AgentSessionError(409, '该进程已结束或正在退出，不能再输入。');
    return session;
  }

  private copyView(session: ManagedSession): AgentSessionView {
    return { ...session.view, args: [...session.view.args] };
  }

  private kill(session: ManagedSession, signal = 'SIGHUP'): void {
    if (this.platform !== 'win32' && (this.options.backend === undefined || this.options.backend.native === true)) {
      try { process.kill(-session.pty.pid, signal as NodeJS.Signals); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    session.pty.kill(this.platform === 'win32' ? undefined : signal);
  }

  private async loadBackend(): Promise<AgentPtyBackend> {
    this.backend ??= import('node-pty').then((module) => module);
    try { return await this.backend; } catch (error) {
      this.backend = null;
      throw new AgentSessionError(503, `无法加载本机终端组件：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function parseLaunch(value: unknown): AgentLaunchRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AgentSessionError(400, '启动参数必须是对象。');
  const request = value as Record<string, unknown>;
  if (!AGENT_TOOLS.includes(request.tool as AgentLaunchRequest['tool'])) throw new AgentSessionError(400, '请选择支持的智能体，或使用自定义命令。');
  for (const key of ['cwd', 'command', 'title'] as const) {
    if (request[key] !== undefined && (typeof request[key] !== 'string' || (request[key] as string).trim().length === 0 ||
        (request[key] as string).length > (key === 'title' ? 120 : 4096) || /[\0\r\n]/u.test(request[key] as string))) {
      throw new AgentSessionError(400, `${key} 必须是非空的单行文字。`);
    }
  }
  if (request.args !== undefined && (!Array.isArray(request.args) || request.args.length > 128 ||
      request.args.some((arg: unknown) => typeof arg !== 'string' || arg.length > 16384 || arg.includes('\0')) ||
      request.args.reduce((size: number, arg: string) => size + arg.length, 0) > 32768)) {
    throw new AgentSessionError(400, '启动参数必须是字符串数组，总长度不超过 32768。');
  }
  if (request.cols !== undefined || request.rows !== undefined) validateDimensions(request.cols ?? 100, request.rows ?? 30);
  return request as unknown as AgentLaunchRequest;
}

function validateDimensions(cols: unknown, rows: unknown): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 2 || (cols as number) > 500 ||
      (rows as number) < 1 || (rows as number) > 300) {
    throw new AgentSessionError(400, '终端尺寸应为 2–500 列、1–300 行。');
  }
}
