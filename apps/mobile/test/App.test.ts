// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, type App as VueApp } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App.vue";
import { RemoteError, type AgentSession, type RemoteClient, type Session } from "../src/client";
import { useRemoteControl } from "../src/composables/use-remote-control";

vi.mock("../src/composables/use-remote-control", () => ({ useRemoteControl: vi.fn() }));
vi.mock("../src/components/TerminalView.vue", () => ({
  default: defineComponent({
    props: ["history"],
    setup: (props) => () => h("section", { "aria-label": "终端输出" }, props.history),
  }),
}));

let app: VueApp | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function mountConnectedApp() {
  const session: Session = {
    id: "codex:1", tool: "codex", rootPid: 1, childPids: [], conversationId: "thread-1",
    conversationTitle: "Monitored task", goal: null, transport: "codex-app-server", alive: true,
    enabled: true, paused: false, startedAtMs: 1, lastActivityAtMs: 2, sessionCwd: "/work",
  };
  const agent: AgentSession = {
    id: "agent-1", tool: "codex", title: "Hosted task", command: "codex", args: [], cwd: "/work",
    pid: 4, status: "running", startedAtMs: 1, endedAtMs: null, exitCode: null, signal: null, cols: 100, rows: 30,
  };
  const state = { sessions: [session], agents: [agent], missingOutput: false };
  const request = vi.fn(async (path: string): Promise<unknown> => {
    if (path === "/info") return { name: "Workstation" };
    if (path === "/health") return { ok: true, running: true, dryRun: false, lastPollAtMs: 2 };
    if (path === "/sessions") return { sessions: state.sessions };
    if (path === "/agents") return { sessions: state.agents };
    if (path === "/agents/catalog") return { platform: "linux", defaultCwd: "/work", tools: [] };
    if (path === "/sessions/codex%3A1/output") return {
      sessionId: session.id, state: "ready", source: "codex-rollout", truncated: false,
      entries: [{ id: "message-1", role: "assistant", text: "Monitored output", timestampMs: 2 }],
    };
    if (path.startsWith("/agents/agent-1/output?")) {
      if (state.missingOutput) throw new RemoteError(404, "目标窗口不存在");
      return { data: "Hosted output", fromOffset: 0, offset: 13, reset: false, session: agent };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const scheduled: (() => void)[] = [];
  const { useRemoteControl: createRemoteControl } = await vi.importActual<typeof import("../src/composables/use-remote-control")>("../src/composables/use-remote-control");
  const control = createRemoteControl({
    clientFactory: () => ({ address: "http://host:48921", request }) as unknown as RemoteClient,
    credentialStore: {
      get: async () => ({ value: "saved-token" }),
      set: async () => undefined,
      remove: async () => undefined,
    },
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    schedule: (work) => { scheduled.push(work); return scheduled.length as unknown as ReturnType<typeof setTimeout>; },
    cancelSchedule: () => undefined,
  });
  expect(await control.connect({ address: "http://host:48921", name: "Workstation" })).toBe(true);
  vi.spyOn(control, "restore").mockResolvedValue(true);
  vi.mocked(useRemoteControl).mockReturnValue(control);
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  vi.spyOn(history, "back").mockImplementation(() => undefined);
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(App);
  app.mount(root);
  await nextTick();
  return { control, root, state, scheduled };
}

async function clickButton(root: HTMLElement, text: string) {
  const button = [...root.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  expect(button, `Button not found: ${text}`).toBeDefined();
  button!.click();
  await nextTick();
}

describe("detail screen recovery", () => {
  it("explains a vanished monitored session and returns to the session list", async () => {
    const { control, root, state } = await mountConnectedApp();
    await clickButton(root, "会话");
    root.querySelector<HTMLButtonElement>(".session-row")!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Monitored output"));

    state.sessions = [];
    await control.refresh();
    await nextTick();

    expect(root.querySelector('[role="status"]')?.textContent ?? "").toContain("会话已不可用");
    expect(root.textContent).not.toContain("Monitored output");
    expect(root.querySelector("textarea")).toBeNull();
    await clickButton(root, "返回会话列表");
    expect(root.querySelector("h1")?.textContent).toBe("会话");
    expect(root.textContent).toContain("没有发现会话");
  });

  it.each(["snapshot", "output 404"] as const)("explains a vanished terminal after %s and returns to the agent list", async (source) => {
    const { control, root, state, scheduled } = await mountConnectedApp();
    await clickButton(root, "智能体");
    root.querySelector<HTMLButtonElement>(".list-panel .list-row")!.click();
    await vi.waitFor(() => expect(root.textContent).toContain("Hosted output"));

    state.agents = [];
    if (source === "snapshot") {
      await control.refresh();
    } else {
      state.missingOutput = true;
      scheduled.shift()!();
      await vi.waitFor(() => expect(control.selectedAgent.value).toBeNull());
    }
    await nextTick();

    expect(root.querySelector('[role="status"]')?.textContent ?? "").toContain("终端已不可用");
    expect(root.textContent).not.toContain("Hosted output");
    expect(root.querySelector('textarea[aria-label="终端输入"]')).toBeNull();
    await clickButton(root, "返回智能体列表");
    expect(root.querySelector("h1")?.textContent).toBe("智能体");
    expect(root.textContent).toContain("没有托管窗口");
  });
});
