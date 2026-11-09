<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import type { AgentSession, AgentTool, Session } from "./client";
import AppIcon from "./components/AppIcon.vue";
import AppearancePage from "./components/AppearancePage.vue";
import TerminalView from "./components/TerminalView.vue";
import { useAppearance } from "./composables/use-appearance";
import { useRemoteControl, type SavedDevice } from "./composables/use-remote-control";

const remote = useRemoteControl();
const {
  devices, address, code, deviceName, connected, hostName, health, sessions,
  selectedSession, sessionOutput, catalog, agents, selectedAgent, agentOutput, agentOutputPage,
  connectionStatus, busy, error, actionError, pollError, runningSessions,
  runningAgents,
} = remote;
const { theme, themes, setTheme } = useAppearance();

type Tab = "dashboard" | "sessions" | "agents" | "settings";
type Screen = Tab | "devices" | "session" | "terminal" | "appearance" | "about";
const tab = ref<Tab>("dashboard");
const screen = ref<Screen>("dashboard");
const heading = ref<HTMLElement>();
const prompt = ref("");
const terminalInput = ref("");
const terminalView = ref<InstanceType<typeof TerminalView>>();
const launchTool = ref<AgentTool>("codex");
const launchCwd = ref("");
const launchTitle = ref("");

const navigation: { id: Tab; name: string; icon: string }[] = [
  { id: "dashboard", name: "控制台", icon: "dashboard" },
  { id: "sessions", name: "会话", icon: "sessions" },
  { id: "agents", name: "智能体", icon: "agent" },
  { id: "settings", name: "设置", icon: "settings" },
];
const titles: Record<Screen, string> = {
  dashboard: "控制台",
  sessions: "会话",
  agents: "智能体",
  settings: "设置",
  devices: "电脑设备",
  session: "会话详情",
  terminal: "智能体终端",
  appearance: "主题",
  about: "关于",
};
const statusLabels: Record<string, string> = {
  disconnected: "未连接",
  connecting: "正在连接",
  connected: "已连接",
  reconnecting: "正在重连",
  needs_pairing: "需要配对",
};

interface ProjectGroup {
  key: string;
  name: string;
  path: string;
  sessions: Session[];
}
interface EnvironmentGroup {
  key: string;
  name: string;
  projects: ProjectGroup[];
}

const sessionGroups = computed<EnvironmentGroup[]>(() => {
  const environments = new Map<string, { name: string; projects: Map<string, ProjectGroup> }>();
  for (const session of sessions.value) {
    const environmentKey = session.distribution ? `wsl:${session.distribution}` : (session.platform === "win32" ? "windows" : "local");
    const environmentName = session.distribution ? `WSL · ${session.distribution}` : (session.platform === "win32" ? "Windows" : "本机");
    const path = session.sessionCwd?.trim() || "未识别目录";
    const name = path === "未识别目录" ? path : path.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || path;
    const environment = environments.get(environmentKey) ?? { name: environmentName, projects: new Map() };
    const project = environment.projects.get(path) ?? { key: `${environmentKey}:${path}`, name, path, sessions: [] };
    project.sessions.push(session);
    environment.projects.set(path, project);
    environments.set(environmentKey, environment);
  }
  return [...environments.entries()].map(([key, value]) => ({
    key,
    name: value.name,
    projects: [...value.projects.values()].map((project) => ({
      ...project,
      sessions: project.sessions.sort((a, b) => (b.lastActivityAtMs ?? b.startedAtMs) - (a.lastActivityAtMs ?? a.startedAtMs)),
    })),
  }));
});

const availableTools = computed(() => catalog.value?.tools.filter((tool) => tool.available) ?? []);
const controlsAvailable = computed(() => connectionStatus.value === "connected");
let pendingTab: Tab | undefined;
let handlingHistory = false;

function historyState(next: Screen) {
  return { selbstlaufScreen: next, selbstlaufTab: tab.value };
}

function navigate(next: Tab) {
  if (screen.value !== tab.value && history.state?.selbstlaufScreen === screen.value) {
    pendingTab = next;
    history.back();
    return;
  }
  tab.value = next;
  screen.value = next;
}
function back() {
  if (screen.value !== tab.value && history.state?.selbstlaufScreen === screen.value) history.back();
  else screen.value = tab.value;
}
function onHistoryBack(event: PopStateEvent) {
  const savedTab = event.state?.selbstlaufTab;
  const next = pendingTab ?? (navigation.some((item) => item.id === savedTab) ? savedTab as Tab : tab.value);
  pendingTab = undefined;
  handlingHistory = true;
  tab.value = next;
  screen.value = next;
  history.replaceState(historyState(next), "");
  void nextTick(() => { handlingHistory = false; });
}
function toolName(tool: string) {
  return ({ claude: "Claude", codex: "Codex", dsh: "DeepSeek", opencode: "OpenCode", gemini: "Gemini", shell: "Shell" } as Record<string, string>)[tool] ?? tool;
}
function sessionTitle(session: Session) {
  return session.conversationTitle || session.conversationId || `${toolName(session.tool)} · PID ${session.rootPid}`;
}
function sessionState(session: Session) {
  if (!session.alive) return "已结束";
  if (session.paused) return "已暂停";
  if (session.runningTurn === true) return "运行中";
  if (session.runningTurn === false) return "空闲";
  return session.enabled ? "监控中" : "已禁用";
}
function relativeTime(timestamp?: number | null) {
  if (!timestamp) return "无活动记录";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}
async function connect(device?: SavedDevice) {
  if (await remote.connect(device)) navigate("dashboard");
}
async function openSession(session: Session) {
  screen.value = "session";
  await remote.openSession(session);
}
async function submitPrompt() {
  const text = prompt.value.trim();
  if (!text || !await remote.inject(text)) return;
  if (prompt.value.trim() === text) prompt.value = "";
}
async function launch() {
  const launched = await remote.launchAgent({
    tool: launchTool.value,
    cwd: launchCwd.value,
    title: launchTitle.value,
  });
  if (launched) screen.value = "terminal";
}
async function openAgent(agent: AgentSession) {
  screen.value = "terminal";
  await remote.openAgent(agent);
}
async function sendTerminal() {
  const text = terminalInput.value;
  if (!text || !await terminalView.value?.send(text)) return;
  if (terminalInput.value === text) terminalInput.value = "";
}
async function removeSelectedAgent() {
  if (await remote.removeAgent()) back();
}

watch(catalog, (value) => {
  if (!value) return;
  if (!launchCwd.value) launchCwd.value = value.defaultCwd;
  if (!value.tools.some((tool) => tool.id === launchTool.value && tool.available)) {
    launchTool.value = value.tools.find((tool) => tool.available)?.id ?? "shell";
  }
}, { immediate: true });
let draftHost = "";
watch(connected, (host) => {
  if (!host) return;
  if (draftHost && host !== draftHost) {
    launchCwd.value = "";
    launchTitle.value = "";
    prompt.value = "";
    terminalInput.value = "";
  }
  draftHost = host;
});
watch(screen, async (next, previous) => {
  if (!handlingHistory) {
    if (navigation.some((item) => item.id === next)) history.replaceState(historyState(next), "");
    else if (navigation.some((item) => item.id === previous)) history.pushState(historyState(next), "");
    else history.replaceState(historyState(next), "");
  }
  await nextTick();
  window.scrollTo(0, 0);
  heading.value?.focus({ preventScroll: true });
});

let heartbeat: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  history.replaceState(historyState(screen.value), "");
  window.addEventListener("popstate", onHistoryBack);
  await remote.restore();
  heartbeat = setInterval(() => { if (connected.value) void remote.refresh(); }, 5_000);
});
onUnmounted(() => {
  window.removeEventListener("popstate", onHistoryBack);
  if (heartbeat !== undefined) clearInterval(heartbeat);
  remote.dispose();
});
</script>

<template>
  <div class="app-shell" :class="{ 'wide-shell': screen === 'agents' || screen === 'terminal' }">
    <main class="page-content">
      <header class="page-header">
        <button v-if="!navigation.some((item) => item.id === screen)" class="back-button" type="button" aria-label="返回" @click="back">
          <AppIcon name="back" />
        </button>
        <h1 ref="heading" tabindex="-1">{{ titles[screen] }}</h1>
        <span class="connection-badge" :data-status="connectionStatus">
          <i />{{ statusLabels[connectionStatus] }}
        </span>
      </header>
      <div v-if="actionError" class="error-banner" role="alert">
        <p>{{ actionError }}</p>
        <button class="text-button" type="button" aria-label="关闭提示" @click="actionError = ''"><AppIcon name="close" /></button>
      </div>
      <p v-if="pollError && screen !== 'terminal'" class="error-note" role="status">{{ pollError }}</p>
      <div v-if="connectionStatus === 'needs_pairing' && screen !== 'devices'" class="panel connection-panel">
        <span class="row-copy"><strong>需要重新配对</strong><small>在电脑生成新配对码后恢复连接。</small></span>
        <button class="tonal-button" type="button" @click="screen = 'devices'">连接电脑</button>
      </div>

      <template v-if="screen === 'dashboard'">
        <button class="panel connection-panel" type="button" @click="screen = 'devices'">
          <span class="icon-disc"><AppIcon name="computer" /></span>
          <span class="row-copy">
            <strong>{{ hostName || '连接电脑' }}</strong>
            <small>{{ connected || '输入电脑地址与一次性配对码' }}</small>
          </span>
          <AppIcon class="chevron" name="chevron" />
        </button>

        <section class="panel overview-panel">
          <h2>发现会话</h2>
          <strong class="large-number">{{ sessions.length }}</strong>
          <p class="hint">其中 {{ runningSessions }} 个智能体正在处理任务</p>
        </section>
        <div class="two-columns stats-grid">
          <section class="panel">
            <h2>托管窗口</h2>
            <strong class="stat-number">{{ agents.length }}</strong>
            <p class="hint">{{ runningAgents }} 个运行中</p>
          </section>
          <section class="panel">
            <h2>看门狗</h2>
            <strong class="stat-word" :data-active="health?.running">{{ health?.running ? '运行中' : '已停止' }}</strong>
            <button v-if="connected" class="text-button" type="button" :disabled="busy || !controlsAvailable" @click="remote.setWatchdog(!health?.running)">
              {{ health?.running ? '停止' : '启动' }}
            </button>
          </section>
        </div>
        <div class="two-columns">
          <button class="panel feature-tile" type="button" @click="navigate('sessions')">
            <span class="icon-disc secondary"><AppIcon name="sessions" /></span>
            <strong>管理会话</strong><span class="hint">暂停、继续或发送提示</span>
          </button>
          <button class="panel feature-tile" type="button" @click="navigate('agents')">
            <span class="icon-disc tertiary"><AppIcon name="agent" /></span>
            <strong>打开智能体</strong><span class="hint">在电脑项目中启动终端</span>
          </button>
        </div>
        <p v-if="error" class="error-note" role="alert">{{ error }}</p>
      </template>

      <template v-else-if="screen === 'sessions'">
        <div v-if="!connected" class="panel empty-state">
          <AppIcon name="computer" /><h2>尚未连接电脑</h2><p class="hint">输入电脑地址和配对码后读取会话。</p>
          <button class="primary-button" type="button" @click="screen = 'devices'">连接电脑</button>
        </div>
        <div v-else-if="sessions.length === 0" class="panel empty-state">
          <AppIcon name="sessions" /><h2>没有发现会话</h2><p class="hint">电脑上的 Claude、Codex 或 DeepSeek 会话会显示在这里。</p>
          <button class="tonal-button" type="button" :disabled="busy" @click="remote.refresh"><AppIcon name="refresh" />刷新</button>
        </div>
        <section v-for="environment in sessionGroups" v-else :key="environment.key" class="environment-section">
          <h2 class="subheading">{{ environment.name }}</h2>
          <article v-for="project in environment.projects" :key="project.key" class="project-card">
            <header><strong>{{ project.name }}</strong><small>{{ project.path }}</small></header>
            <button v-for="session in project.sessions" :key="session.id" class="list-row session-row" type="button" @click="openSession(session)">
              <span class="icon-disc"><AppIcon name="agent" /></span>
              <span class="row-copy">
                <strong>{{ sessionTitle(session) }}</strong>
                <small>{{ toolName(session.tool) }} · PID {{ session.rootPid }} · {{ relativeTime(session.lastActivityAtMs) }}</small>
              </span>
              <span class="state-label" :data-running="session.runningTurn">{{ sessionState(session) }}</span>
            </button>
          </article>
        </section>
      </template>

      <template v-else-if="screen === 'session' && selectedSession">
        <section class="panel session-summary">
          <span class="agent-label"><AppIcon name="agent" />{{ toolName(selectedSession.tool) }}</span>
          <h2>{{ sessionTitle(selectedSession) }}</h2>
          <p class="path-copy">{{ selectedSession.sessionCwd || '目录未知' }}</p>
          <div class="chip-row">
            <span>{{ sessionState(selectedSession) }}</span>
            <span>{{ selectedSession.transport }}</span>
            <span v-if="selectedSession.goal">Goal · {{ selectedSession.goal.status }}</span>
          </div>
        </section>
        <section class="panel action-grid">
          <button class="tonal-button" type="button" :disabled="busy || !controlsAvailable || selectedSession.paused" @click="remote.pauseSession()"><AppIcon name="pause" />暂停</button>
          <button class="tonal-button" type="button" :disabled="busy || !controlsAvailable || !selectedSession.paused" @click="remote.resumeSession()"><AppIcon name="play" />继续</button>
          <button class="tonal-button" type="button" :disabled="busy || !controlsAvailable" @click="remote.focusSession()"><AppIcon name="focus" />电脑显示</button>
          <button class="tonal-button" type="button" :disabled="busy || !controlsAvailable" @click="remote.openSession(selectedSession)"><AppIcon name="refresh" />刷新输出</button>
        </section>
        <section class="panel output-panel">
          <h2>会话输出</h2>
          <p v-if="sessionOutput?.state === 'unavailable'" class="hint">{{ sessionOutput.reason || '当前没有可读取的输出' }}</p>
          <div v-else-if="sessionOutput?.entries.length" class="message-list">
            <article v-for="entry in sessionOutput.entries" :key="entry.id" class="message" :data-role="entry.role">
              <strong>{{ entry.role === 'assistant' ? '智能体' : entry.role === 'user' ? '你' : '工具' }}</strong>
              <pre>{{ entry.text }}</pre>
            </article>
          </div>
          <p v-else class="hint">{{ actionError ? '会话记录未能读取，可重新刷新输出。' : '正在读取电脑上的会话记录…' }}</p>
        </section>
        <form class="panel form-panel" @submit.prevent="submitPrompt">
          <label>发送提示<textarea v-model="prompt" placeholder="例如：继续完成当前任务" maxlength="4096" /></label>
          <button class="primary-button full-width" type="submit" :disabled="busy || !controlsAvailable || !prompt.trim()"><AppIcon name="send" />发送到电脑</button>
        </form>
      </template>

      <template v-else-if="screen === 'agents'">
        <form class="panel form-panel" @submit.prevent="launch">
          <h2>打开智能体窗口</h2>
          <label>智能体
            <select v-model="launchTool" :disabled="!controlsAvailable">
              <option v-for="tool in availableTools" :key="tool.id" :value="tool.id">{{ tool.label }}</option>
            </select>
          </label>
          <label>电脑工作目录<input v-model="launchCwd" placeholder="C:\project 或 /home/user/project" /></label>
          <label>窗口名称（可选）<input v-model="launchTitle" placeholder="新任务" /></label>
          <button class="primary-button full-width" type="submit" :disabled="busy || !controlsAvailable || !launchCwd.trim() || availableTools.length === 0"><AppIcon name="play" />启动</button>
        </form>
        <h2 class="subheading">已打开窗口</h2>
        <div v-if="agents.length" class="list-panel">
          <button v-for="agent in agents" :key="agent.id" class="list-row" type="button" @click="openAgent(agent)">
            <span class="icon-disc secondary"><AppIcon name="terminal" /></span>
            <span class="row-copy"><strong>{{ agent.title }}</strong><small>{{ toolName(agent.tool) }} · {{ agent.cwd }} · PID {{ agent.pid }}</small></span>
            <span class="state-label" :data-running="agent.status === 'running'">{{ agent.status === 'running' ? '运行中' : agent.status === 'stopping' ? '正在结束' : '已结束' }}</span>
          </button>
        </div>
        <div v-else class="panel empty-state"><AppIcon name="terminal" /><h2>没有托管窗口</h2><p class="hint">从上面的表单在电脑目录中启动一个智能体。</p></div>
      </template>

      <template v-else-if="screen === 'terminal' && selectedAgent">
        <section class="panel session-summary">
          <span class="agent-label"><AppIcon name="terminal" />{{ toolName(selectedAgent.tool) }}</span>
          <h2>{{ selectedAgent.title }}</h2>
          <p class="path-copy">{{ selectedAgent.cwd }}</p>
          <div class="chip-row"><span>{{ selectedAgent.status }}</span><span>PID {{ selectedAgent.pid }}</span></div>
        </section>
        <TerminalView
          :key="`${connected}:${selectedAgent.id}`"
          ref="terminalView"
          :session="selectedAgent"
          :output="agentOutputPage"
          :history="agentOutput"
          :enabled="controlsAvailable"
          :write="remote.sendAgentInput"
          :resize="remote.resizeAgent"
        />
        <p v-if="pollError" class="error-note">{{ pollError }}</p>
        <form v-if="selectedAgent.status === 'running'" class="panel terminal-composer" @submit.prevent="sendTerminal">
          <textarea v-model="terminalInput" aria-label="终端输入" placeholder="输入命令或回复" rows="3" />
          <button class="primary-button" type="submit" :disabled="busy || !controlsAvailable || !terminalInput"><AppIcon name="send" />发送</button>
        </form>
        <section class="panel action-grid">
          <button class="tonal-button" type="button" :disabled="busy || !controlsAvailable || selectedAgent.status !== 'running'" @click="remote.interruptAgent()"><AppIcon name="stop" />中断</button>
          <button class="tonal-button" type="button" :disabled="busy || !controlsAvailable || selectedAgent.status === 'exited'" @click="remote.terminateAgent()"><AppIcon name="close" />结束</button>
          <button class="tonal-button" type="button" :disabled="busy || !controlsAvailable || selectedAgent.status !== 'exited'" @click="removeSelectedAgent"><AppIcon name="trash" />删除</button>
        </section>
      </template>

      <template v-else-if="screen === 'settings'">
        <p class="page-intro">按你的方式使用 Selbstlauf</p>
        <div class="list-panel">
          <button class="list-row" type="button" @click="screen = 'devices'">
            <span class="icon-disc secondary"><AppIcon name="computer" /></span><span class="row-copy"><strong>电脑设备</strong><small>连接、配对与管理电脑</small></span><AppIcon class="chevron" name="chevron" />
          </button>
          <button class="list-row" type="button" @click="screen = 'appearance'">
            <span class="icon-disc"><AppIcon name="palette" /></span><span class="row-copy"><strong>主题</strong><small>选择你的配色</small></span><AppIcon class="chevron" name="chevron" />
          </button>
        </div>
        <div class="list-panel">
          <button class="list-row" type="button" @click="screen = 'about'">
            <span class="icon-disc tertiary"><AppIcon name="info" /></span><span class="row-copy"><strong>关于 Selbstlauf</strong><small>远程控制与连接说明</small></span><AppIcon class="chevron" name="chevron" />
          </button>
        </div>
      </template>

      <template v-else-if="screen === 'devices'">
        <h2 class="subheading">连接电脑</h2>
        <form class="panel form-panel" @submit.prevent="connect()">
          <label>电脑地址<input v-model="address" inputmode="url" placeholder="192.168.1.20:48921" autocomplete="url" /></label>
          <label>手机名称<input v-model="deviceName" maxlength="80" autocomplete="name" /></label>
          <label>一次性配对码<input v-model="code" inputmode="numeric" autocomplete="one-time-code" placeholder="电脑显示的配对码" /></label>
          <button class="primary-button full-width" type="submit" :disabled="busy || !address.trim()"><AppIcon name="computer" />{{ code.trim() ? '配对并连接' : '连接' }}</button>
          <p v-if="error" class="error-note inline-error" role="alert">{{ error }}</p>
        </form>
        <div v-if="devices.length" class="list-panel">
          <div v-for="device in devices" :key="device.address" class="saved-device">
            <button class="list-row" type="button" :aria-pressed="device.address === connected" @click="connect(device)">
              <span class="icon-disc secondary"><AppIcon name="computer" /></span>
              <span class="row-copy"><strong>{{ device.name }}</strong><small>{{ device.address }}</small></span>
              <AppIcon class="chevron" name="chevron" />
            </button>
            <button class="text-button remove-device" type="button" :disabled="busy" @click="remote.forget(device)">从本机移除</button>
          </div>
        </div>
      </template>

      <AppearancePage v-else-if="screen === 'appearance'" :theme="theme" :themes="themes" @select="setTheme" />

      <template v-else-if="screen === 'about'">
        <section class="panel about-panel">
          <span class="icon-disc"><AppIcon name="tool" /></span>
          <h2>Selbstlauf Remote</h2>
          <p>在 Android 上查看电脑中的智能体会话、发送继续提示，并管理由 Selbstlauf 托管的终端窗口。</p>
          <p>访问令牌保存在 Android Keystore 中。HTTP 仅用于可信局域网或 VPN，请勿直接暴露到公网。</p>
        </section>
      </template>
    </main>

    <nav class="bottom-navigation" aria-label="主导航">
      <button v-for="item in navigation" :key="item.id" type="button" :aria-current="tab === item.id ? 'page' : undefined" @click="navigate(item.id)">
        <span class="nav-indicator"><AppIcon :name="item.icon" /></span><span>{{ item.name }}</span>
      </button>
    </nav>
  </div>
</template>
