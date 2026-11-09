import { describe, expect, it, vi } from "vitest";
import { RemoteError, type RemoteClient, type SessionOutput, type AgentSession } from "../src/client";
import { useRemoteControl } from "../src/composables/use-remote-control";
import type { CredentialStore } from "../src/credentials";

class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

class MemoryCredentials implements CredentialStore {
  readonly data = new Map<string, string>();
  async get({ key }: { key: string }) { return { value: this.data.get(key) ?? null }; }
  async set({ key, value }: { key: string; value: string }) { this.data.set(key, value); }
  async remove({ key }: { key: string }) { this.data.delete(key); }
}

function fixture() {
  const calls: { path: string; method: string; data?: unknown }[] = [];
  const session = { id: "codex:1", tool: "codex", rootPid: 1, childPids: [], conversationId: "thread", goal: null, transport: "codex-app-server", alive: true, enabled: true, paused: false, startedAtMs: 1, lastActivityAtMs: 2, sessionCwd: "/work", runningTurn: false };
  const agent = { id: "agent-1", tool: "codex", title: "Codex", command: "codex", args: [], cwd: "/work", pid: 4, status: "running", startedAtMs: 1, endedAtMs: null, exitCode: null, signal: null, cols: 100, rows: 30 };
  const request = vi.fn(async (path: string, method = "GET", data?: unknown): Promise<unknown> => {
    calls.push({ path, method, data });
    if (path === "/info") return { name: "Workstation" };
    if (path === "/health") return { ok: true, running: true, dryRun: false, lastPollAtMs: 2 };
    if (path === "/sessions") return { sessions: [session] };
    if (path === "/agents/catalog") return { platform: "linux", defaultCwd: "/work", tools: [{ id: "codex", label: "Codex", command: "codex", available: true }] };
    if (path === "/agents") return method === "POST" ? agent : { sessions: [agent] };
    if (path.includes("/sessions/") && path.endsWith("/output")) return { sessionId: "codex:1", state: "ready", source: "codex-rollout", entries: [], truncated: false };
    if (path.includes("/agents/") && path.includes("/output")) return { data: "hello", fromOffset: 0, offset: 5, reset: false, session: agent };
    return { ok: true };
  });
  const pair = vi.fn(async () => ({ token: "paired-token", device_id: "phone", expires_at: 10 }));
  const client = { address: "http://host:48921", request, pair } as unknown as RemoteClient;
  return { calls, session, agent, request, pair, client };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function setup(first = fixture(), second = fixture()) {
  const storage = new MemoryStorage();
  const credentialStore = new MemoryCredentials();
  credentialStore.data.set("selbstlauf.token:http://host:48921", "first-token");
  credentialStore.data.set("selbstlauf.token:http://other:48921", "second-token");
  const scheduled: { work: () => void; delayMs: number }[] = [];
  const cancelSchedule = vi.fn();
  const control = useRemoteControl({
    storage, credentialStore,
    clientFactory: (host) => host === "http://host:48921" ? first.client : second.client,
    schedule: (work, delayMs) => { scheduled.push({ work, delayMs }); return scheduled.length as unknown as ReturnType<typeof setTimeout>; },
    cancelSchedule,
  });
  control.address.value = "host";
  return { control, storage, credentialStore, scheduled, cancelSchedule, first, second };
}

describe("useRemoteControl", () => {
  it("bounds replay memory without dropping live output or its cursor", async () => {
    const remoteFixture = fixture();
    const original = remoteFixture.request.getMockImplementation()!;
    const size = 2 * 1024 * 1024;
    let page = { data: "a".repeat(size), fromOffset: 0, offset: size, reset: false, session: remoteFixture.agent };
    remoteFixture.request.mockImplementation(async (path, method, data) => path.includes("/output?after=") ? page : original(path, method, data));
    const { control, scheduled } = setup(remoteFixture);
    expect(await control.connect()).toBe(true);
    await control.openAgent(remoteFixture.agent as AgentSession);
    const live = "😀" + "b".repeat(size - 1);
    page = { ...page, data: live, fromOffset: size, offset: size + live.length };
    scheduled.shift()!.work();
    await vi.waitFor(() => expect(control.agentOutputPage.value?.offset).toBe(page.offset));
    expect(control.agentOutput.value).toBe("b".repeat(size - 1));
    expect(control.agentOutputPage.value?.data).toBe(live);
    page = { ...page, data: "NEW", fromOffset: page.offset, offset: page.offset + 3, reset: true };
    scheduled.shift()!.work();
    await vi.waitFor(() => expect(control.agentOutput.value).toBe("NEW"));
    expect(remoteFixture.request).toHaveBeenLastCalledWith(`/agents/agent-1/output?after=${page.fromOffset}`);
    control.dispose();
  });

  it("pairs once, stores only the credential reference, and restores a full snapshot", async () => {
    const remoteFixture = fixture();
    const storage = new MemoryStorage();
    const credentialStore = new MemoryCredentials();
    const control = useRemoteControl({
      storage,
      credentialStore,
      clientFactory: () => remoteFixture.client,
    });
    control.address.value = "host";
    control.code.value = "123456";
    expect(await control.connect()).toBe(true);
    expect(remoteFixture.pair).toHaveBeenCalledWith("123456", "我的手机");
    expect(credentialStore.data.get("selbstlauf.token:http://host:48921")).toBe("paired-token");
    expect(storage.getItem("selbstlauf.devices")).not.toContain("paired-token");
    expect(control.hostName.value).toBe("Workstation");
    expect(control.sessions.value).toHaveLength(1);
    expect(control.catalog.value?.defaultCwd).toBe("/work");
    expect(control.connectionStatus.value).toBe("connected");
  });

  it("reconnects a saved device without asking for another pairing code", async () => {
    const remoteFixture = fixture();
    const storage = new MemoryStorage();
    storage.setItem("selbstlauf.devices", JSON.stringify([{ address: "http://host:48921", name: "Workstation" }]));
    const credentialStore = new MemoryCredentials();
    credentialStore.data.set("selbstlauf.token:http://host:48921", "saved-token");
    const control = useRemoteControl({ storage, credentialStore, clientFactory: () => remoteFixture.client });
    expect(await control.restore()).toBe(true);
    expect(remoteFixture.pair).not.toHaveBeenCalled();
    expect(control.connected.value).toBe("http://host:48921");
  });

  it("routes session actions and terminal operations to their exact resources", async () => {
    const remoteFixture = fixture();
    const credentials = new MemoryCredentials();
    credentials.data.set("selbstlauf.token:http://host:48921", "token");
    const scheduled: (() => void)[] = [];
    const control = useRemoteControl({
      storage: new MemoryStorage(),
      credentialStore: credentials,
      clientFactory: () => remoteFixture.client,
      schedule: (work) => { scheduled.push(work); return 1 as unknown as ReturnType<typeof setTimeout>; },
      cancelSchedule: () => undefined,
    });
    control.address.value = "host";
    await control.connect({ address: "http://host:48921", name: "Workstation" });
    await control.openSession(remoteFixture.session as never);
    await control.pauseSession();
    await control.inject("继续");
    await control.focusSession();
    await control.openAgent(remoteFixture.agent as never);
    await control.resizeAgent(72, 24);
    await control.sendAgentInput("answer\r");
    await control.interruptAgent();
    await control.terminateAgent();
    expect(remoteFixture.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/sessions/codex%3A1/pause", method: "POST" }),
      expect.objectContaining({ path: "/sessions/codex%3A1/inject", data: { prompt: "继续" } }),
      expect.objectContaining({ path: "/sessions/codex%3A1/focus", method: "POST" }),
      expect.objectContaining({ path: "/agents/agent-1/output?after=0" }),
      expect.objectContaining({ path: "/agents/agent-1/resize", method: "POST", data: { cols: 72, rows: 24 } }),
      expect.objectContaining({ path: "/agents/agent-1/input", data: { data: "answer\r" } }),
      expect.objectContaining({ path: "/agents/agent-1/interrupt", method: "POST" }),
      expect.objectContaining({ path: "/agents/agent-1/terminate", method: "POST" }),
    ]));
    expect(control.agentOutput.value).toBe("hello");
    expect(control.agentOutputPage.value).toMatchObject({ fromOffset: 0, offset: 5, reset: false, data: "hello" });
    expect(scheduled).toHaveLength(1);
    control.dispose();
  });

  it("forgets both the server device and encrypted local credential", async () => {
    const remoteFixture = fixture();
    const credentials = new MemoryCredentials();
    credentials.data.set("selbstlauf.token:http://host:48921", "token");
    const storage = new MemoryStorage();
    const control = useRemoteControl({ storage, credentialStore: credentials, clientFactory: () => remoteFixture.client });
    const device = { address: "http://host:48921", name: "Workstation" };
    await control.connect(device);
    await control.forget(device);
    expect(remoteFixture.calls).toContainEqual({ path: "/device", method: "DELETE", data: undefined });
    expect(credentials.data.has("selbstlauf.token:http://host:48921")).toBe(false);
    expect(control.devices.value).toEqual([]);
    expect(control.connectionStatus.value).toBe("disconnected");
  });

  it("keeps unreadable credentials recoverable by explicitly pairing with a new code", async () => {
    const { control, credentialStore, first } = setup();
    const get = vi.spyOn(credentialStore, "get").mockRejectedValue(new Error("Keystore decryption failed"));
    expect(await control.connect()).toBe(false);
    expect(control.connectionStatus.value).toBe("needs_pairing");
    expect(control.error.value).toContain("重新配对");
    control.code.value = "654321";
    expect(await control.connect()).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(first.pair).toHaveBeenCalledWith("654321", "我的手机");
    expect(credentialStore.data.get("selbstlauf.token:http://host:48921")).toBe("paired-token");
    control.dispose();
  });

  it("revokes a newly paired token if encrypted storage fails and asks for a fresh code", async () => {
    const { control, credentialStore, first, storage } = setup();
    vi.spyOn(credentialStore, "set").mockRejectedValue(new Error("Storage unavailable"));
    control.code.value = "123456";
    expect(await control.connect()).toBe(false);
    expect(control.connectionStatus.value).toBe("needs_pairing");
    expect(control.connected.value).toBe("");
    expect(control.code.value).toBe("");
    expect(control.error.value).toContain("无法安全保存");
    expect(first.calls).toContainEqual({ path: "/device", method: "DELETE", data: undefined });
    expect(storage.getItem("selbstlauf.devices")).toBeNull();
    control.dispose();
  });

  it("does not expose an incomplete connection or overwrite a newer computer with a delayed snapshot", async () => {
    const { control, first, second } = setup();
    const original = first.request.getMockImplementation()!;
    const pending = deferred<unknown>();
    first.request.mockImplementation((path, method, data) => path === "/health" ? pending.promise : original(path, method, data));
    second.request.mockImplementation(async (path, method, data) => path === "/info" ? { name: "Second computer" } : original(path, method, data));
    const connecting = control.connect();
    await vi.waitFor(() => expect(first.request).toHaveBeenCalledWith("/health"));
    expect(control.connected.value).toBe("");
    expect(await control.connect({ address: "http://other:48921", name: "Other" })).toBe(true);
    pending.resolve({ ok: true, running: false, dryRun: false, lastPollAtMs: 0 });
    expect(await connecting).toBe(false);
    expect(control.connected.value).toBe("http://other:48921");
    expect(control.hostName.value).toBe("Second computer");
    expect(control.health.value?.running).toBe(true);
    control.dispose();
  });

  it("keeps the latest selected conversation when output reads finish out of order", async () => {
    const { control, first } = setup();
    await control.connect();
    const original = first.request.getMockImplementation()!;
    const pending = deferred<SessionOutput>();
    first.request.mockImplementation((path, method, data) => path === "/sessions/codex%3A1/output" ? pending.promise : original(path, method, data));
    const firstRead = control.openSession(first.session as never);
    const other = { ...first.session, id: "codex:2" };
    first.request.mockImplementation((path, method, data) => {
      if (path === "/sessions/codex%3A1/output") return pending.promise;
      if (path === "/sessions/codex%3A2/output") return Promise.resolve({ sessionId: other.id, state: "ready", source: "codex-rollout", entries: [], truncated: false });
      return original(path, method, data);
    });
    await control.openSession(other as never);
    expect(control.busy.value).toBe(true);
    pending.resolve({ sessionId: first.session.id, state: "ready", source: "codex-rollout", entries: [], truncated: false });
    await firstRead;
    expect(control.selectedSession.value?.id).toBe(other.id);
    expect(control.sessionOutput.value?.sessionId).toBe(other.id);
    expect(control.busy.value).toBe(false);
    control.dispose();
  });

  it("discards pending outputs and mutation responses after switching computers", async () => {
    const { control, first, second } = setup();
    await control.connect();
    const original = first.request.getMockImplementation()!;
    const output = deferred<unknown>();
    const watchdog = deferred<unknown>();
    const launched = deferred<unknown>();
    const removed = deferred<unknown>();
    first.request.mockImplementation((path, method, data) => {
      if (path === "/sessions/codex%3A1/output") return output.promise;
      if (path === "/health") return watchdog.promise;
      if (path === "/agents" && method === "POST") return launched.promise;
      if (path === "/agents/agent-1" && method === "DELETE") return removed.promise;
      return original(path, method, data);
    });
    const read = control.openSession(first.session as never);
    const toggle = control.setWatchdog(false);
    const launch = control.launchAgent({ tool: "codex", cwd: "/first" });
    const remove = control.removeAgent(first.agent as never);
    await vi.waitFor(() => expect(first.request).toHaveBeenCalledWith("/health"));
    await control.connect({ address: "http://other:48921", name: "Other" });
    await control.openAgent(second.agent as never);
    output.resolve({ sessionId: first.session.id, state: "ready", entries: [], truncated: false });
    watchdog.resolve({ ok: true, running: false });
    launched.resolve({ ...first.agent, id: "first-only" });
    removed.resolve({ ok: true });
    await read;
    expect(await toggle).toBe(false);
    expect(await launch).toBeNull();
    expect(await remove).toBe(false);
    expect(control.health.value?.running).toBe(true);
    expect(control.sessionOutput.value).toBeNull();
    expect(control.agents.value.map((agent) => agent.id)).toEqual([second.agent.id]);
    expect(control.selectedAgent.value?.id).toBe(second.agent.id);
    expect(control.agentOutput.value).toBe("hello");
    control.dispose();
  });

  it("stops heartbeat reads, terminal polling and control actions after a 401", async () => {
    const { control, first, scheduled, cancelSchedule } = setup();
    await control.connect();
    await control.openAgent(first.agent as never);
    first.request.mockRejectedValue(new RemoteError(401, "请重新配对"));
    await control.refresh();
    expect(control.connectionStatus.value).toBe("needs_pairing");
    expect(cancelSchedule).toHaveBeenCalled();
    const count = first.request.mock.calls.length;
    scheduled.shift()?.work();
    await control.refresh();
    expect(await control.sendAgentInput("answer\r")).toBe(false);
    await Promise.resolve();
    expect(first.request).toHaveBeenCalledTimes(count);
    expect(control.connectionStatus.value).toBe("needs_pairing");
    control.dispose();
  });

  it("preserves terminal cursors across a network interruption and replaces truncated output", async () => {
    const { control, first, scheduled } = setup();
    await control.connect();
    await control.openAgent(first.agent as never);
    const original = first.request.getMockImplementation()!;
    const pages = vi.fn()
      .mockRejectedValueOnce(new Error("Network lost"))
      .mockResolvedValueOnce({ data: " world", fromOffset: 5, offset: 11, reset: false, session: first.agent })
      .mockResolvedValueOnce({ data: "new tail", fromOffset: 100, offset: 108, reset: true, session: { ...first.agent, status: "exited" } });
    first.request.mockImplementation((path, method, data) => path.includes("/output?after=") ? pages() : original(path, method, data));
    scheduled.shift()?.work();
    await vi.waitFor(() => expect(control.connectionStatus.value).toBe("reconnecting"));
    expect(scheduled[0]?.delayMs).toBe(3000);
    scheduled.shift()?.work();
    await vi.waitFor(() => expect(control.agentOutput.value).toBe("hello world"));
    expect(first.request.mock.calls.filter(([path]) => path.endsWith("after=5"))).toHaveLength(2);
    expect(control.connectionStatus.value).toBe("connected");
    scheduled.shift()?.work();
    await vi.waitFor(() => expect(control.agentOutput.value).toBe("new tail"));
    expect(first.request).toHaveBeenCalledWith("/agents/agent-1/output?after=11");
    expect(scheduled).toHaveLength(0);
    control.dispose();
  });

  it("clears externally removed selections and stops retrying missing terminal resources", async () => {
    const { control, first, scheduled } = setup();
    await control.connect();
    await control.openSession(first.session as never);
    await control.openAgent(first.agent as never);
    const original = first.request.getMockImplementation()!;
    first.request.mockImplementation((path, method, data) => {
      if (path === "/sessions") return Promise.resolve({ sessions: [] });
      if (path.includes("/agents/") && path.includes("/output")) return Promise.reject(new RemoteError(404, "目标窗口不存在"));
      return original(path, method, data);
    });
    await control.refresh();
    expect(control.selectedSession.value).toBeNull();
    expect(control.sessionOutput.value).toBeNull();
    scheduled.shift()?.work();
    await vi.waitFor(() => expect(control.selectedAgent.value).toBeNull());
    expect(control.agents.value).toEqual([]);
    expect(control.connectionStatus.value).toBe("connected");
    expect(control.pollError.value).toContain("不存在");
    expect(scheduled).toHaveLength(0);
    control.dispose();
  });

  it("keeps a failed action visible across a successful heartbeat and clears stale active preferences on forgetting", async () => {
    const { control, first, storage } = setup();
    await control.connect();
    const original = first.request.getMockImplementation()!;
    first.request.mockImplementation((path, method, data) => path.endsWith("/pause") ? Promise.reject(new RemoteError(409, "会话无法暂停")) : original(path, method, data));
    expect(await control.pauseSession(first.session as never)).toBe(false);
    await control.refresh();
    expect(control.actionError.value).toBe("会话无法暂停");
    await control.forget({ address: "http://host:48921", name: "Workstation" });
    expect(storage.getItem("selbstlauf.active-device")).toBeNull();
    expect(control.address.value).toBe("");
    control.dispose();
  });

  it("shares a slow snapshot among overlapping heartbeat refreshes", async () => {
    const { control, first } = setup();
    await control.connect();
    const original = first.request.getMockImplementation()!;
    const pending = deferred<unknown>();
    first.request.mockImplementation((path, method, data) => path === "/health" ? pending.promise : original(path, method, data));
    const count = first.request.mock.calls.length;
    const refreshes = [control.refresh(), control.refresh(), control.refresh()];
    expect(first.request.mock.calls.length - count).toBe(5);
    pending.resolve({ ok: true, running: false, dryRun: false, lastPollAtMs: 7 });
    await Promise.all(refreshes);
    expect(control.health.value?.running).toBe(false);
    expect(control.health.value?.lastPollAtMs).toBe(7);
    control.dispose();
  });

  it("does not let an older heartbeat hide an accepted new agent", async () => {
    const { control, first } = setup();
    await control.connect();
    const original = first.request.getMockImplementation()!;
    const pending = deferred<unknown>();
    first.request.mockImplementation((path, method, data) => {
      if (path === "/agents" && method === "GET") return pending.promise;
      if (path === "/agents" && method === "POST") return Promise.resolve({ ...first.agent, id: "new-agent" });
      return original(path, method, data);
    });
    const refresh = control.refresh();
    expect((await control.launchAgent({ tool: "codex", cwd: "/work" }))?.id).toBe("new-agent");
    pending.resolve({ sessions: [first.agent] });
    await refresh;
    expect(control.agents.value.some((agent) => agent.id === "new-agent")).toBe(true);
    control.dispose();
  });

  it("treats a prompt as sent even if its follow-up output read fails", async () => {
    const { control, first } = setup();
    await control.connect();
    await control.openSession(first.session as never);
    const original = first.request.getMockImplementation()!;
    first.request.mockImplementation((path, method, data) => path.endsWith("/output") ? Promise.reject(new Error("Output unavailable")) : original(path, method, data));
    expect(await control.inject("继续")).toBe(true);
    expect(first.calls.filter((call) => call.path.endsWith("/inject"))).toHaveLength(1);
    expect(control.actionError.value).toBe("Output unavailable");
    control.dispose();
  });
});
