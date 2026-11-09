import { computed, ref, shallowRef } from "vue";
import {
  RemoteClient,
  RemoteError,
  normalizeAddress,
  type AgentCatalog,
  type AgentOutput,
  type AgentSession,
  type AgentTool,
  type ConnectionStatus,
  type Health,
  type RemoteInfo,
  type Session,
  type SessionOutput,
} from "../client";
import { credentials, type CredentialStore } from "../credentials";

export interface SavedDevice {
  address: string;
  name: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface RemoteControlOptions {
  clientFactory?: (address: string, token: string) => RemoteClient;
  credentialStore?: CredentialStore;
  storage?: StorageLike;
  schedule?: (work: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

const DEVICES_KEY = "selbstlauf.devices";
const ACTIVE_DEVICE_KEY = "selbstlauf.active-device";

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readDevices(storage: StorageLike | undefined): SavedDevice[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(DEVICES_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    const unique = new Map<string, SavedDevice>();
    for (const entry of value) {
      if (!entry || typeof entry.address !== "string" || typeof entry.name !== "string") continue;
      try {
        const address = normalizeAddress(entry.address);
        unique.set(address, { address, name: entry.name.trim() || address });
      } catch {
        // Invalid stale device records are ignored.
      }
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

function readActiveDevice(storage: StorageLike | undefined): string {
  try {
    const address = storage?.getItem(ACTIVE_DEVICE_KEY);
    return address ? normalizeAddress(address) : "";
  } catch {
    return "";
  }
}

export function useRemoteControl(options: RemoteControlOptions = {}) {
  const store = options.storage ?? browserStorage();
  const credentialStore = options.credentialStore ?? credentials;
  const schedule = options.schedule ?? ((work, delay) => setTimeout(work, delay));
  const cancelSchedule = options.cancelSchedule ?? clearTimeout;
  const makeClient = options.clientFactory ?? ((host, token) => new RemoteClient(host, token));

  const devices = ref<SavedDevice[]>(readDevices(store));
  const address = ref(readActiveDevice(store) || devices.value[0]?.address || "");
  const code = ref("");
  const deviceName = ref("我的手机");
  const connected = ref("");
  const hostName = ref("");
  const info = ref<RemoteInfo | null>(null);
  const health = ref<Health | null>(null);
  const sessions = ref<Session[]>([]);
  const selectedSession = shallowRef<Session | null>(null);
  const sessionOutput = ref<SessionOutput | null>(null);
  const catalog = ref<AgentCatalog | null>(null);
  const agents = ref<AgentSession[]>([]);
  const selectedAgent = shallowRef<AgentSession | null>(null);
  const agentOutput = ref("");
  const agentOutputPage = shallowRef<AgentOutput | null>(null);
  const connectionStatus = ref<ConnectionStatus>("disconnected");
  const busy = ref(false);
  const error = ref("");
  const actionError = ref("");
  const pollError = ref("");

  let client: RemoteClient | null = null;
  let connection = 0;
  let operation = 0;
  let pendingActions = 0;
  let snapshotRequest = 0;
  let refreshPending: { version: number; work: Promise<void> } | null = null;
  let sessionRequest = 0;
  let generation = 0;
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const activeDevice = computed(() => devices.value.find((item) => item.address === connected.value) ?? null);
  const runningSessions = computed(() => sessions.value.filter((session) => session.runningTurn === true).length);
  const runningAgents = computed(() => agents.value.filter((agent) => agent.status === "running").length);
  const credentialKey = (host: string) => `selbstlauf.token:${host}`;

  function persistDevices(next = devices.value) {
    devices.value = next;
    try {
      store?.setItem(DEVICES_KEY, JSON.stringify(next));
    } catch {
      // The current connection remains usable if preference storage is full.
    }
  }

  function rememberDevice(device: SavedDevice) {
    persistDevices([
      ...devices.value.filter((entry) => entry.address !== device.address),
      device,
    ]);
    try {
      store?.setItem(ACTIVE_DEVICE_KEY, device.address);
    } catch {
      // Non-critical preference.
    }
  }

  function clearPolling() {
    generation += 1;
    if (timer !== undefined) cancelSchedule(timer);
    timer = undefined;
  }

  function invalidateSnapshot() {
    snapshotRequest += 1;
    refreshPending = null;
  }

  function resetRemoteState() {
    connection += 1;
    invalidateSnapshot();
    sessionRequest += 1;
    pendingActions = 0;
    clearPolling();
    client = null;
    connected.value = "";
    hostName.value = "";
    info.value = null;
    health.value = null;
    sessions.value = [];
    selectedSession.value = null;
    sessionOutput.value = null;
    catalog.value = null;
    agents.value = [];
    selectedAgent.value = null;
    agentOutput.value = "";
    agentOutputPage.value = null;
    cursor = 0;
    pollError.value = "";
  }

  function recordError(cause: unknown, target = actionError) {
    target.value = cause instanceof Error ? cause.message : "连接失败，请检查电脑地址和网络";
    if (cause instanceof RemoteError && cause.status === 401) {
      connectionStatus.value = "needs_pairing";
      clearPolling();
      // Invalidate in-flight reads and stop the app heartbeat until re-pairing.
      client = null;
    }
  }

  function isCurrent(next: RemoteClient, version: number) {
    return !disposed && next === client && version === connection;
  }

  async function action(work: () => Promise<void>): Promise<boolean> {
    if (disposed || !client) return false;
    const version = connection;
    const id = ++operation;
    pendingActions += 1;
    busy.value = true;
    actionError.value = "";
    try {
      await work();
      return !disposed && version === connection && client !== null;
    } catch (cause) {
      if (!disposed && version === connection && (id === operation || (cause instanceof RemoteError && cause.status === 401))) recordError(cause);
      return false;
    } finally {
      if (!disposed && version === connection) {
        pendingActions -= 1;
        busy.value = pendingActions > 0;
      }
    }
  }

  async function loadSnapshot(next: RemoteClient, version: number, revision: number) {
    const [nextInfo, nextHealth, sessionPage, nextCatalog, agentPage] = await Promise.all([
      next.request<RemoteInfo>("/info"),
      next.request<Health>("/health"),
      next.request<{ sessions: Session[] }>("/sessions"),
      next.request<AgentCatalog>("/agents/catalog"),
      next.request<{ sessions: AgentSession[] }>("/agents"),
    ]);
    if (!isCurrent(next, version) || revision !== snapshotRequest) return false;
    info.value = nextInfo;
    hostName.value = nextInfo.name || next.address;
    health.value = nextHealth;
    sessions.value = sessionPage.sessions;
    catalog.value = nextCatalog;
    agents.value = agentPage.sessions;
    const nextSession = sessionPage.sessions.find((item) => item.id === selectedSession.value?.id) ?? null;
    if (selectedSession.value && !nextSession) {
      sessionRequest += 1;
      sessionOutput.value = null;
    }
    selectedSession.value = nextSession;
    const nextAgent = agentPage.sessions.find((item) => item.id === selectedAgent.value?.id) ?? null;
    if (selectedAgent.value && !nextAgent) {
      clearPolling();
      agentOutput.value = "";
      agentOutputPage.value = null;
      cursor = 0;
    }
    selectedAgent.value = nextAgent;
    return true;
  }

  async function connect(device?: SavedDevice): Promise<boolean> {
    if (disposed) return false;
    const id = ++operation;
    busy.value = true;
    error.value = "";
    actionError.value = "";
    resetRemoteState();
    const version = connection;
    connectionStatus.value = "connecting";
    try {
      const host = normalizeAddress(device?.address ?? address.value);
      address.value = host;
      if (device) code.value = "";
      // Explicit re-pairing must also work after a Keystore key was lost or
      // encrypted preferences became unreadable.
      const pairingCode = device ? "" : code.value.trim();
      let savedToken: string | null = null;
      if (!pairingCode) {
        try {
          savedToken = (await credentialStore.get({ key: credentialKey(host) })).value;
        } catch {
          if (version === connection && !disposed) connectionStatus.value = "needs_pairing";
          throw new Error("无法读取已保存的凭据，请输入电脑新生成的配对码重新配对");
        }
      }
      if (version !== connection || disposed) return false;
      const next = makeClient(host, savedToken ?? "");
      if (pairingCode || !savedToken) {
        if (!pairingCode) {
          connectionStatus.value = "needs_pairing";
          throw new Error("请输入电脑显示的一次性配对码");
        }
        const paired = await next.pair(pairingCode, deviceName.value.trim() || "Android");
        if (version !== connection || disposed) return false;
        try {
          await credentialStore.set({ key: credentialKey(host), value: paired.token });
        } catch {
          if (version === connection && !disposed) {
            connectionStatus.value = "needs_pairing";
            code.value = "";
          }
          // A token which cannot be kept safely should not remain authorized.
          try { await next.request<void>("/device", "DELETE"); } catch { /* Best effort while offline. */ }
          throw new Error("无法安全保存配对凭据，请检查手机存储后生成新配对码重试");
        }
        if (version !== connection || disposed) return false;
        code.value = "";
      }
      client = next;
      const loaded = await loadSnapshot(next, version, ++snapshotRequest);
      if (!loaded || !isCurrent(next, version)) return false;
      connected.value = host;
      connectionStatus.value = "connected";
      rememberDevice({ address: host, name: hostName.value || device?.name || host });
      return true;
    } catch (cause) {
      if (version === connection && !disposed) {
        client = null;
        recordError(cause, error);
        if (connectionStatus.value !== "needs_pairing") connectionStatus.value = "disconnected";
      }
      return false;
    } finally {
      if (version === connection && !disposed && id === operation) busy.value = false;
    }
  }

  async function restore(): Promise<boolean> {
    const active = devices.value.find((entry) => entry.address === address.value) ?? devices.value[0];
    return active ? connect(active) : false;
  }

  async function refresh(): Promise<void> {
    const current = client;
    if (!current || disposed || connectionStatus.value === "connecting") return;
    const version = connection;
    if (refreshPending?.version === version) return refreshPending.work;
    const revision = ++snapshotRequest;
    const work = (async () => {
      try {
        if (!await loadSnapshot(current, version, revision)) return;
        if (connectionStatus.value === "reconnecting") connectionStatus.value = "connected";
        pollError.value = "";
      } catch (cause) {
        if (!isCurrent(current, version) || revision !== snapshotRequest) return;
        if (cause instanceof RemoteError && cause.status === 401) {
          recordError(cause);
        } else {
          connectionStatus.value = "reconnecting";
          pollError.value = "连接中断，电脑上的任务仍会继续运行";
        }
      }
    })();
    refreshPending = { version, work };
    try { await work; } finally {
      if (refreshPending?.work === work) refreshPending = null;
    }
  }

  async function forget(device: SavedDevice): Promise<void> {
    if (disposed) return;
    const version = connection;
    const current = client;
    try {
      if (device.address === connected.value && current) {
        try {
          await current.request<void>("/device", "DELETE");
        } catch (cause) {
          if (!(cause instanceof RemoteError && cause.status === 401)) throw cause;
        }
      }
      if (version !== connection || disposed) return;
      await credentialStore.remove({ key: credentialKey(device.address) });
      if (version !== connection || disposed) return;
      persistDevices(devices.value.filter((entry) => entry.address !== device.address));
      if (address.value === device.address) {
        address.value = devices.value[0]?.address ?? "";
        try {
          if (address.value) store?.setItem(ACTIVE_DEVICE_KEY, address.value);
          else store?.removeItem(ACTIVE_DEVICE_KEY);
        } catch {
          // Preference cleanup does not affect credential removal.
        }
      }
      if (device.address === connected.value) {
        resetRemoteState();
        busy.value = false;
        connectionStatus.value = "disconnected";
      }
    } catch (cause) {
      if (version === connection && !disposed) recordError(cause);
    }
  }

  async function readSession(current: RemoteClient, session: Session, version: number) {
    const revision = ++sessionRequest;
    const output = await current.request<SessionOutput>(`/sessions/${encodeURIComponent(session.id)}/output`);
    if (isCurrent(current, version) && revision === sessionRequest && selectedSession.value?.id === session.id) {
      sessionOutput.value = output;
    }
  }

  async function openSession(session: Session): Promise<void> {
    const current = client;
    if (!current) return;
    const version = connection;
    selectedSession.value = session;
    sessionOutput.value = null;
    await action(() => readSession(current, session, version));
  }

  async function sessionAction(kind: "pause" | "resume" | "focus", session = selectedSession.value) {
    const current = client;
    if (!current || !session) return false;
    const version = connection;
    return action(async () => {
      await current.request(`/sessions/${encodeURIComponent(session.id)}/${kind}`, "POST");
      if (!isCurrent(current, version)) return;
      invalidateSnapshot();
      await refresh();
      const updated = sessions.value.find((item) => item.id === session.id);
      if (isCurrent(current, version) && updated && selectedSession.value?.id === session.id) selectedSession.value = updated;
    });
  }

  async function inject(prompt: string, session = selectedSession.value) {
    const current = client;
    if (!current || !session || !prompt.trim()) return false;
    const version = connection;
    const sent = await action(async () => {
      await current.request(`/sessions/${encodeURIComponent(session.id)}/inject`, "POST", { prompt: prompt.trim() });
    });
    if (!sent) return false;
    if (isCurrent(current, version) && selectedSession.value?.id === session.id) {
      await action(() => readSession(current, session, version));
    }
    // A failed output refresh must not turn an accepted prompt into a retry.
    return !disposed && version === connection;
  }

  async function setWatchdog(running: boolean) {
    const current = client;
    if (!current) return false;
    const version = connection;
    return action(async () => {
      await current.request(`/watchdog/${running ? "start" : "stop"}`, "POST");
      if (!isCurrent(current, version)) return;
      invalidateSnapshot();
      const nextHealth = await current.request<Health>("/health");
      if (isCurrent(current, version)) health.value = nextHealth;
    });
  }

  async function launchAgent(form: { tool: AgentTool; cwd: string; title?: string }): Promise<AgentSession | null> {
    const current = client;
    if (!current) return null;
    const version = connection;
    let launched: AgentSession | null = null;
    await action(async () => {
      const nextAgent = await current.request<AgentSession>("/agents", "POST", {
        tool: form.tool,
        cwd: form.cwd.trim(),
        ...(form.title?.trim() ? { title: form.title.trim() } : {}),
        cols: 100,
        rows: 30,
      });
      if (!isCurrent(current, version)) return;
      invalidateSnapshot();
      launched = nextAgent;
      agents.value = [launched, ...agents.value.filter((entry) => entry.id !== launched!.id)];
      await openAgent(launched);
    });
    return isCurrent(current, version) ? launched : null;
  }

  async function openAgent(agent: AgentSession | null) {
    if (disposed || (agent && !client)) return;
    clearPolling();
    selectedAgent.value = agent;
    agentOutput.value = "";
    agentOutputPage.value = null;
    cursor = 0;
    pollError.value = "";
    if (!agent || !client) return;
    const version = generation;
    await pollAgent(version);
  }

  async function pollAgent(version: number) {
    const current = client;
    const agent = selectedAgent.value;
    if (!current || !agent || version !== generation || disposed) return;
    try {
      const page = await current.request<AgentOutput>(
        `/agents/${encodeURIComponent(agent.id)}/output?after=${cursor}`,
      );
      if (current !== client || version !== generation || disposed) return;
      agentOutput.value = page.reset ? page.data : agentOutput.value + page.data;
      agentOutputPage.value = page;
      cursor = page.offset;
      selectedAgent.value = page.session;
      agents.value = agents.value.map((entry) => entry.id === page.session.id ? page.session : entry);
      pollError.value = "";
      if (connectionStatus.value === "reconnecting") connectionStatus.value = "connected";
      if (page.session.status !== "exited") timer = schedule(() => void pollAgent(version), page.data ? 80 : 900);
    } catch (cause) {
      if (current !== client || version !== generation || disposed) return;
      if (cause instanceof RemoteError && cause.status === 401) {
        recordError(cause, pollError);
        return;
      }
      if (cause instanceof RemoteError && cause.status === 404) {
        clearPolling();
        invalidateSnapshot();
        selectedAgent.value = null;
        agents.value = agents.value.filter((item) => item.id !== agent.id);
        pollError.value = cause.message;
        if (connectionStatus.value === "reconnecting") connectionStatus.value = "connected";
        return;
      }
      connectionStatus.value = "reconnecting";
      pollError.value = "连接中断，智能体仍在电脑上运行；正在重试";
      timer = schedule(() => void pollAgent(version), 3_000);
    }
  }

  async function sendAgentInput(data: string) {
    const current = client;
    const agent = selectedAgent.value;
    if (!current || !agent || !data) return false;
    return action(async () => {
      await current.request(`/agents/${encodeURIComponent(agent.id)}/input`, "POST", { data });
    });
  }

  async function resizeAgent(cols: number, rows: number): Promise<boolean> {
    const current = client;
    const agent = selectedAgent.value;
    if (!current || !agent || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return false;
    const version = connection;
    return action(async () => {
      const resized = await current.request<AgentSession>(`/agents/${encodeURIComponent(agent.id)}/resize`, "POST", { cols, rows });
      if (!isCurrent(current, version)) return;
      if (resized?.id === agent.id) {
        agents.value = agents.value.map((entry) => entry.id === agent.id ? resized : entry);
        if (selectedAgent.value?.id === agent.id) selectedAgent.value = resized;
      }
    });
  }

  async function agentAction(kind: "interrupt" | "terminate", agent = selectedAgent.value) {
    const current = client;
    if (!current || !agent) return false;
    const version = connection;
    return action(async () => {
      await current.request(`/agents/${encodeURIComponent(agent.id)}/${kind}`, "POST");
      if (isCurrent(current, version)) {
        invalidateSnapshot();
        await refresh();
      }
    });
  }

  async function removeAgent(agent = selectedAgent.value) {
    const current = client;
    if (!current || !agent) return false;
    const version = connection;
    return action(async () => {
      await current.request(`/agents/${encodeURIComponent(agent.id)}`, "DELETE");
      if (!isCurrent(current, version)) return;
      invalidateSnapshot();
      agents.value = agents.value.filter((entry) => entry.id !== agent.id);
      if (selectedAgent.value?.id === agent.id) {
        clearPolling();
        selectedAgent.value = null;
        agentOutput.value = "";
        agentOutputPage.value = null;
        cursor = 0;
      }
    });
  }

  function dispose() {
    disposed = true;
    operation += 1;
    clearPolling();
  }

  return {
    devices,
    address,
    code,
    deviceName,
    connected,
    hostName,
    info,
    health,
    sessions,
    selectedSession,
    sessionOutput,
    catalog,
    agents,
    selectedAgent,
    agentOutput,
    agentOutputPage,
    connectionStatus,
    busy,
    error,
    actionError,
    pollError,
    activeDevice,
    runningSessions,
    runningAgents,
    connect,
    restore,
    refresh,
    forget,
    openSession,
    pauseSession: (session?: Session) => sessionAction("pause", session),
    resumeSession: (session?: Session) => sessionAction("resume", session),
    focusSession: (session?: Session) => sessionAction("focus", session),
    inject,
    setWatchdog,
    launchAgent,
    openAgent,
    sendAgentInput,
    resizeAgent,
    interruptAgent: (agent?: AgentSession) => agentAction("interrupt", agent),
    terminateAgent: (agent?: AgentSession) => agentAction("terminate", agent),
    removeAgent,
    dispose,
  };
}
