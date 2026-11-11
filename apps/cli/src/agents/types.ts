import type { AgentKind } from './registry.js';

export const AGENT_TOOLS = [
  'claude', 'opencode', 'codex', 'dsh', 'gemini', 'grok', 'qwen', 'openclaw', 'hermes', 'pi', 'crush',
  'cline', 'roo', 'kilo', 'claude-app', 'trae', 'zcode', 'workbuddy', 'workbuddy-intl', 'craft-agents', 'antigravity', 'cursor', 'shell', 'custom',
] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

/** Kept independent of node-pty so the desktop can supply its Electron-compatible build. */
export interface AgentPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface AgentPtyBackend {
  /** True only for a real local PTY backend whose PID owns the spawned process group. */
  readonly native?: boolean;
  spawn(command: string, args: string[] | string, options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  }): AgentPty;
}

export interface AgentLaunchRequest {
  tool: AgentTool;
  cwd?: string;
  command?: string;
  args?: string[];
  title?: string;
  cols?: number;
  rows?: number;
}

export interface AgentSessionView {
  id: string;
  tool: AgentTool;
  title: string;
  command: string;
  args: readonly string[];
  cwd: string;
  pid: number;
  status: 'running' | 'stopping' | 'exited';
  startedAtMs: number;
  endedAtMs: number | null;
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
}

export interface AgentCatalog {
  platform: NodeJS.Platform;
  defaultCwd: string;
  tools: {
    id: AgentTool;
    label: string;
    command: string | null;
    available: boolean;
    kind: AgentKind;
    launchable: boolean;
    defaultArgs: readonly string[];
    installCommand?: string;
    installUrl?: string;
    docsUrl?: string;
    guideUrls?: readonly string[];
  }[];
}

/** Offsets count UTF-16 code units, matching terminal strings and browser EventSource cursors. */
export interface AgentOutput {
  data: string;
  fromOffset: number;
  offset: number;
  reset: boolean;
  session: AgentSessionView;
}

export class AgentSessionError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'AgentSessionError';
  }
}
