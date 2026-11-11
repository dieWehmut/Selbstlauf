import { subscribeLiveEvent, subscribeLiveOutput } from './live-socket';

export type AgentTool = 'claude' | 'opencode' | 'codex' | 'dsh' | 'gemini' | 'grok' |
  'qwen' | 'openclaw' | 'hermes' | 'pi' | 'crush' | 'cline' | 'roo' | 'kilo' |
  'claude-app' | 'trae' | 'zcode' | 'workbuddy' | 'workbuddy-intl' | 'craft-agents' | 'antigravity' | 'cursor' | 'shell' | 'custom';

export interface AgentSession {
  id: string;
  tool: AgentTool;
  title: string;
  command: string;
  args: string[];
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
  platform: string;
  defaultCwd: string;
  tools: {
    id: AgentTool;
    label: string;
    command: string | null;
    available: boolean;
    kind?: 'cli' | 'desktop' | 'extension' | 'shell' | 'custom';
    launchable?: boolean;
    installCommand?: string;
    installUrl?: string;
    docsUrl?: string;
    guideUrls?: string[];
    defaultArgs?: string[];
  }[];
}

export interface AgentLaunch {
  tool: AgentTool;
  cwd: string;
  command?: string;
  args?: string[];
  title?: string;
  cols?: number;
  rows?: number;
}

export interface AgentOutput {
  data: string;
  fromOffset: number;
  offset: number;
  reset: boolean;
  session: AgentSession;
}

export interface AgentApi {
  catalog(): Promise<AgentCatalog>;
  list(): Promise<AgentSession[]>;
  launch(request: AgentLaunch): Promise<AgentSession>;
  output(id: string, after?: number): Promise<AgentOutput>;
  input(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<AgentSession>;
  interrupt(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  subscribeSessions(onChange: () => void): () => void;
  subscribeOutput(id: string, onOutput: (output: AgentOutput) => void, onConnection: (connected: boolean) => void): () => void;
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/agents${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof failure?.error === 'string' ? failure.error : `智能体服务请求失败（${response.status}）`);
  }
  return await response.json() as T;
}

export function createAgentApi(): AgentApi {
  const route = (id: string) => `/${encodeURIComponent(id)}`;
  return {
    catalog: () => request('/catalog'),
    list: async () => (await request<{ sessions: AgentSession[] }>('')).sessions,
    launch: (value) => request('', 'POST', value),
    output: (id, after = 0) => request(`${route(id)}/output?after=${after}`),
    input: async (id, data) => { await request(`${route(id)}/input`, 'POST', { data }); },
    resize: (id, cols, rows) => request(`${route(id)}/resize`, 'POST', { cols, rows }),
    interrupt: async (id) => { await request(`${route(id)}/interrupt`, 'POST'); },
    terminate: async (id) => { await request(`${route(id)}/terminate`, 'POST'); },
    remove: async (id) => { await request(route(id), 'DELETE'); },
    subscribeSessions: (onChange) => {
      if (typeof WebSocket !== 'undefined') {
        const stop = [subscribeLiveEvent('agents', onChange), subscribeLiveEvent('ready', onChange)];
        return () => stop.forEach((unsubscribe) => unsubscribe());
      }
      if (typeof EventSource === 'undefined') return () => undefined;
      const source = new EventSource('/api/events');
      source.addEventListener('agents', onChange);
      source.addEventListener('ready', onChange);
      return () => source.close();
    },
    subscribeOutput: (id, onOutput, onConnection) => {
      const receive = (data: unknown) => {
        if (!validOutput(data, id)) { onConnection(false); return; }
        onOutput(data);
      };
      if (typeof WebSocket !== 'undefined') return subscribeLiveOutput(id, receive, onConnection);
      if (typeof EventSource === 'undefined') {
        onConnection(false);
        return () => undefined;
      }
      const source = new EventSource(`/api/agents${route(id)}/events`);
      source.onopen = () => onConnection(true);
      source.onerror = () => onConnection(false);
      source.addEventListener('output', (message) => {
        try {
          receive(JSON.parse((message as MessageEvent<string>).data));
        } catch { onConnection(false); }
      });
      return () => source.close();
    },
  };
}

function validOutput(value: unknown, id: string): value is AgentOutput {
  if (value === null || typeof value !== 'object') return false;
  const output = value as AgentOutput;
  return typeof output.data === 'string' && Number.isSafeInteger(output.offset) && Number.isSafeInteger(output.fromOffset) &&
    output.fromOffset >= 0 && output.offset >= output.fromOffset && output.offset - output.fromOffset === output.data.length &&
    typeof output.reset === 'boolean' && output.session?.id === id && ['running', 'stopping', 'exited'].includes(output.session.status);
}
