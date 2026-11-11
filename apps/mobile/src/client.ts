import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { ToolName as MonitoredToolName } from "../../web/src/api/client";
import type { AgentTool as CatalogAgentTool } from "../../web/src/api/agents";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "needs_pairing";

export type ToolName = MonitoredToolName;

export interface RemoteInfo {
  name: string;
  version?: string;
  startedAtMs?: number;
}

export interface Health {
  ok: boolean;
  running: boolean;
  watchdogRunning?: boolean;
  dryRun: boolean;
  lastPollAtMs: number | null;
  nowMs?: number;
}

export interface Session {
  id: string;
  tool: ToolName;
  rootPid: number;
  childPids: number[];
  conversationId: string | null;
  conversationTitle?: string | null;
  goal: { status: string; updatedAtMs?: number } | null;
  transport: string;
  alive: boolean;
  enabled: boolean;
  paused: boolean;
  startedAtMs: number;
  lastActivityAtMs: number | null;
  quietForMs?: number | null;
  sessionCwd?: string | null;
  platform?: string;
  runningTurn?: boolean;
  distribution?: string;
  transportError?: string;
}

export interface SessionOutput {
  sessionId: string;
  state: "ready" | "unavailable";
  source: string | null;
  entries: {
    id: string;
    role: "user" | "assistant" | "tool";
    text: string;
    timestampMs: number | null;
  }[];
  truncated: boolean;
  reason?: string;
}

export type AgentTool = CatalogAgentTool;

export interface AgentCatalog {
  platform: string;
  defaultCwd: string;
  tools: {
    id: AgentTool;
    label: string;
    command: string | null;
    available: boolean;
    installCommand?: string;
    kind?: 'cli' | 'desktop' | 'extension' | 'shell' | 'custom';
    launchable?: boolean;
    installUrl?: string;
    docsUrl?: string;
    guideUrls?: string[];
  }[];
}

export interface AgentSession {
  id: string;
  tool: AgentTool;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  pid: number;
  status: "running" | "stopping" | "exited";
  startedAtMs: number;
  endedAtMs: number | null;
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
}

export interface AgentOutput {
  data: string;
  fromOffset: number;
  offset: number;
  reset: boolean;
  session: AgentSession;
}

export function normalizeAddress(input: string): string {
  const value = input.trim();
  const url = new URL(value.includes("://") ? value : `http://${value}`);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("请输入电脑 IP、主机名或完整 HTTP(S) 地址，不要包含路径或凭据");
  }
  const explicitPort = /^(?:\[[^\]]+\]|[^:/?#]+):\d+\/?$/u.test(value);
  if (!url.port && !value.includes("://") && !explicitPort) url.port = "48921";
  return url.origin;
}

export class RemoteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RemoteError";
  }
}

export interface PairingResult {
  token: string;
  device_id: string;
  expires_at: number;
}

export type RemoteFetch = typeof fetch;

export class RemoteClient {
  constructor(
    readonly address: string,
    private token = "",
    private readonly fetcher: RemoteFetch = fetch.bind(globalThis),
  ) {}

  setToken(token: string) {
    this.token = token;
  }

  async request<T>(path: string, method = "GET", data?: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const url = `${this.address}/remote/v1${path}`;
    let status: number;
    let body: unknown;
    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.request({
        url,
        method,
        headers,
        data,
        responseType: "json",
        connectTimeout: 10_000,
        readTimeout: 20_000,
        disableRedirects: true,
      });
      status = response.status;
      body = response.data;
    } else {
      const response = await this.fetcher(url, {
        method,
        headers,
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
        credentials: "omit",
      });
      status = response.status;
      const raw = await response.text();
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
    }
    if (status < 200 || status >= 300) {
      const serverMessage =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : null;
      let message = serverMessage || `请求失败 (${status})，请检查电脑服务和配对码`;
      if (status === 401) {
        message = path === "/pair"
          ? "配对码不正确或已失效，请在电脑生成新配对码"
          : "配对已过期，请输入新配对码重新配对";
      } else if (status === 429 && path === "/pair") {
        message = "配对尝试过多，请稍后在电脑生成新配对码";
      } else if (status === 404) {
        message = "目标会话或智能体窗口不存在，请刷新后重试";
      } else if (status === 409 && !serverMessage) {
        message = "当前状态不允许此操作，请刷新后重试";
      }
      throw new RemoteError(status, message);
    }
    if (status !== 204 && typeof body === "string") {
      throw new Error("电脑返回了无法识别的响应，请检查地址和服务端口");
    }
    return body as T;
  }

  async pair(code: string, deviceName: string): Promise<PairingResult> {
    const result = await this.request<PairingResult>("/pair", "POST", {
      code,
      device_name: deviceName,
    });
    if (
      !result ||
      typeof result.token !== "string" || !result.token ||
      typeof result.device_id !== "string" || !result.device_id ||
      !Number.isFinite(result.expires_at)
    ) {
      throw new Error("电脑返回了无效配对凭据，请检查地址和服务端口");
    }
    this.token = result.token;
    return result;
  }
}
