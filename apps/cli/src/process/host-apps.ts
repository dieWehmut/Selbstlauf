/**
 * Where a watched session actually runs.
 *
 * A monitored agent is a process tree, and the thing a person recognizes is not
 * the `node.exe` at the root but the application around it: the Tabby window it
 * was started from, the Codex desktop app that hosts its app server, the editor
 * that owns its terminal. This module turns the ancestor chain plus the
 * top-level windows on the desktop into one labelled location, and keeps the
 * handle needed to bring that window forward.
 *
 * Everything here is a pure function of observed data so the mapping is
 * testable; the PowerShell provider only reports what it sees.
 */

export type HostCategory =
  | 'terminal'
  | 'editor'
  | 'desktop-app'
  | 'browser'
  | 'console'
  | 'shell'
  | 'unknown';

export interface HostProcessRef {
  readonly pid: number;
  readonly name: string;
}

export interface HostWindowRef {
  readonly handle: number;
  readonly pid: number;
  /** Image name of the window's owning process, when known. */
  readonly processName: string | null;
  readonly title: string;
  readonly className: string;
  readonly visible: boolean;
}

export interface SessionHost {
  readonly processId: number;
  readonly executableName: string;
  readonly label: string;
  readonly category: HostCategory;
  readonly windowHandle: number | null;
  readonly windowTitle: string | null;
}

export interface HarnessHostHint {
  /** Window titles containing any of these markers belong to the harness WebUI. */
  readonly titleMarkers: readonly string[];
  /** Label used when the harness UI is served but no matching window is open. */
  readonly label: string;
}

export interface ClassifySessionHostInput {
  readonly rootPid: number;
  readonly rootName: string;
  /** Immediate parent first, walking outward. */
  readonly ancestors: readonly HostProcessRef[];
  readonly windows: readonly HostWindowRef[];
  readonly harness?: HarnessHostHint | null;
}

interface HostApp {
  readonly label: string;
  readonly category: HostCategory;
  /** Higher wins when several ancestors are recognized. */
  readonly rank: number;
}

const HOST_APPS: ReadonlyMap<string, HostApp> = new Map<string, HostApp>([
  // Terminals and editors are the most specific answer for an interactive CLI.
  ['tabby.exe', { label: 'Tabby', category: 'terminal', rank: 5 }],
  ['windowsterminal.exe', { label: 'Windows Terminal', category: 'terminal', rank: 5 }],
  ['wt.exe', { label: 'Windows Terminal', category: 'terminal', rank: 5 }],
  ['alacritty.exe', { label: 'Alacritty', category: 'terminal', rank: 5 }],
  ['wezterm-gui.exe', { label: 'WezTerm', category: 'terminal', rank: 5 }],
  ['code.exe', { label: 'Visual Studio Code', category: 'editor', rank: 5 }],
  ['code - insiders.exe', { label: 'VS Code Insiders', category: 'editor', rank: 5 }],
  ['cursor.exe', { label: 'Cursor', category: 'editor', rank: 5 }],
  ['windsurf.exe', { label: 'Windsurf', category: 'editor', rank: 5 }],
  // Desktop applications that host an agent runtime.
  ['chatgpt.exe', { label: 'Codex 应用', category: 'desktop-app', rank: 5 }],
  // Browsers, used mostly by the harness WebUI hint below.
  ['msedge.exe', { label: 'Microsoft Edge', category: 'browser', rank: 4 }],
  ['chrome.exe', { label: 'Google Chrome', category: 'browser', rank: 4 }],
  ['firefox.exe', { label: 'Mozilla Firefox', category: 'browser', rank: 4 }],
  ['brave.exe', { label: 'Brave', category: 'browser', rank: 4 }],
  // Plain consoles rank below a real terminal host but still beat the shell.
  ['openconsole.exe', { label: 'Console Host', category: 'console', rank: 3 }],
  ['conhost.exe', { label: '经典控制台', category: 'console', rank: 3 }],
  ['powershell.exe', { label: 'Windows PowerShell', category: 'console', rank: 3 }],
  ['pwsh.exe', { label: 'PowerShell', category: 'console', rank: 3 }],
  ['cmd.exe', { label: '命令提示符', category: 'console', rank: 3 }],
  // The shell is a last resort: every process on a desktop descends from it.
  ['explorer.exe', { label: 'Windows 桌面', category: 'shell', rank: 1 }],
]);

/**
 * Window classes Windows creates for input methods, hooks, and DWM plumbing.
 * They are titled and top-level, so they match a window search but never
 * represent an application a person can look at.
 */
const NOISE_WINDOW_CLASSES: ReadonlySet<string> = new Set([
  'ime',
  'msctfime ui',
  'default ime',
  'gdi+ hook window class',
  'dwm',
  'ms_webcheckmonitor',
  'windows.ui.core.corewindow',
  'microsoft.ui.content.popupwindowsitebridge',
  'progman',
  'shell_traywnd',
  'systemtray_main',
  'toplevelwindowforoverflowxamlisland',
  'xamlexplorerhostislandwindow',
  'uihubmousehiderwindowclass',
  'cicerouiwndframe',
  'tooltips_class32',
  'windows.ui.composition.desktopwindowcontentbridge',
]);

/**
 * Executables that must never be reported as where a session runs.
 *
 * This application's own process is the honest example. Its window is an ancestor of every CLI the
 * watchdog is asked to continue — the watchdog's own service and the sessions it spawns sit inside it —
 * so without this the process list filled with rows labelled 运行位置: Selbstlauf, at one point 20 of 25,
 * none of which is a place a person works. A session that descends from this app is running somewhere
 * else, or its host could not be identified; "inside Selbstlauf" is never the useful answer.
 */
const EXCLUDED_HOST_EXECUTABLES: ReadonlySet<string> = new Set([
  'selbstlauf.exe',
]);

export function hostAppFor(executableName: string): HostApp | null {
  const key = executableName.trim().toLocaleLowerCase();
  if (EXCLUDED_HOST_EXECUTABLES.has(key)) return null;
  return HOST_APPS.get(key) ?? null;
}

/** Whether a window is a plausible application window rather than OS plumbing. */
export function isRealWindow(window: HostWindowRef): boolean {
  if (window.title.trim().length === 0) return false;
  if (NOISE_WINDOW_CLASSES.has(window.className.toLocaleLowerCase())) return false;
  return window.title !== 'Program Manager';
}

/** Best window for a set of preferred owners, falling back to any real window. */
function pickWindow(
  windows: readonly HostWindowRef[],
  preferredPids: readonly number[],
): HostWindowRef | null {
  const real = windows.filter(isRealWindow);
  for (const pid of preferredPids) {
    const owned = real.filter((window) => window.pid === pid);
    const visible = owned.find((window) => window.visible);
    if (visible !== undefined) return visible;
    if (owned.length > 0) return owned[0] ?? null;
  }
  return real.find((window) => window.visible) ?? real[0] ?? null;
}

/** The browser (or other) window whose title shows the harness WebUI. */
export function findHarnessWindow(
  windows: readonly HostWindowRef[],
  hint: HarnessHostHint,
): HostWindowRef | null {
  const markers = hint.titleMarkers
    .map((marker) => marker.trim().toLocaleLowerCase())
    .filter((marker) => marker.length > 0);
  if (markers.length === 0) return null;
  const matches = windows.filter((window) =>
    isRealWindow(window)
    && markers.some((marker) => window.title.toLocaleLowerCase().includes(marker)));
  if (matches.length === 0) return null;
  // A browser tab is what actually shows the harness; any other window that
  // merely mentions the marker is a weaker signal.
  const browser = matches.filter((window) =>
    window.processName !== null && hostAppFor(window.processName)?.category === 'browser');
  const pool = browser.length > 0 ? browser : matches;
  return [...pool].sort((left, right) => Number(right.visible) - Number(left.visible))[0] ?? null;
}

/**
 * Resolve the application a session is running inside.
 *
 * The harness WebUI is served over loopback rather than hosted by a parent
 * process, so a harness session first looks for the browser window showing that
 * UI; only then does it fall back to the launch chain.
 */
export function classifySessionHost(input: ClassifySessionHostInput): SessionHost | null {
  const hint = input.harness ?? null;
  if (hint !== null) {
    const window = findHarnessWindow(input.windows, hint);
    if (window !== null) {
      const app = window.processName === null ? null : hostAppFor(window.processName);
      return {
        processId: window.pid,
        executableName: window.processName ?? '',
        label: app?.category === 'browser' ? app.label : hint.label,
        category: 'browser',
        windowHandle: window.handle,
        windowTitle: window.title,
      };
    }
  }

  // Highest rank wins; on equal rank the ancestor nearest the session wins.
  let best: { ancestor: HostProcessRef; app: HostApp; index: number } | null = null;
  for (let index = 0; index < input.ancestors.length; index += 1) {
    const ancestor = input.ancestors[index];
    if (ancestor === undefined) continue;
    const app = hostAppFor(ancestor.name);
    if (app === null) continue;
    const current = best;
    if (
      current === null ||
      app.rank > current.app.rank ||
      (app.rank === current.app.rank && index < current.index)
    ) {
      best = { ancestor, app, index };
    }
  }

  if (best === null) {
    if (hint !== null) {
      return harnessFallback(input, hint);
    }
    // No recognized host: fall back to whatever window the session itself owns.
    const own = pickWindow(input.windows, [input.rootPid]);
    if (own === null) return null;
    return {
      processId: own.pid,
      executableName: own.processName ?? '',
      label: own.title,
      category: 'unknown',
      windowHandle: own.handle,
      windowTitle: own.title,
    };
  }

  // A harness host started from a bare console is not where a person works:
  // the interface is the browser that shows the WebUI, so a console or shell
  // ancestor is reported as the harness interface instead.
  if (hint !== null && (best.app.category === 'console' || best.app.category === 'shell')) {
    return harnessFallback(input, hint);
  }

  const window = pickWindow(input.windows, [
    best.ancestor.pid,
    input.rootPid,
  ]);
  return {
    processId: best.ancestor.pid,
    executableName: best.ancestor.name,
    label: best.app.label,
    category: best.app.category,
    windowHandle: window?.handle ?? null,
    windowTitle: window?.title ?? null,
  };
}

function harnessFallback(
  input: ClassifySessionHostInput,
  hint: HarnessHostHint,
): SessionHost {
  return {
    processId: input.rootPid,
    executableName: input.rootName,
    label: hint.label,
    category: 'browser',
    windowHandle: null,
    windowTitle: null,
  };
}