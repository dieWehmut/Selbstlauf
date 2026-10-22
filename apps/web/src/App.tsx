import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  CircleAlert,
  CircleArrowUp,
  CirclePause,
  CirclePlay,
  Copy,
  Gauge,
  LayoutDashboard,
  ListTree,
  Menu,
  Monitor,
  Moon,
  Network,
  ChevronUp,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PawPrint,
  Plug,
  Power,
  RefreshCw,
  Save,
  Send,
  Settings2,
  ShieldAlert,
  SquareArrowOutUpRight,
  Sun,
  Terminal,
  Trash2,
  Unplug,
  UserCheck,
  Webhook,
  X,
} from 'lucide-react';
/** Bundled with the app so the Pages sub-path rewrites it like any other asset. */
import brandIcon from './assets/brand.png';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { getLocale, translate, useI18n, type Locale, type MessageParams } from './i18n';
import { LanguageSection } from './i18n/LanguageSection';
import {
  createApi,
  type AuditEvent,
  type ClaudeHookStatusView,
  type CodexProfileEditView,
  type CodexProfilesView,
  type EnvironmentToolView,
  type EnvironmentView,
  type ToolState,
  type HealthView,
  type SessionView,
  type WatchdogApi,
  type WatchdogEvent,
  type WatchdogConfig,
} from './api/client';
import { SettingsRail, SETTINGS_SECTION_IDS } from './settings/SettingsRail';
import { SessionWindowPreview } from './process/SessionWindowPreview';
import { WindowTypePanel } from './process/WindowTypePanel';
import { ToolIcon } from './sidebar/ToolIcon';
import { canWriteSession, writeEligibility } from './session/write-eligibility';
import { isLight, mix, paletteSurfaces, readableText } from './theme/palette';
import { SessionPromptComposer } from './process/SessionPromptComposer';
import { SessionOutputPanel } from './process/SessionOutputPanel';
import type { SessionOutputView } from './api/client';
import { SidebarProcessList } from './sidebar/SidebarProcessList';
import { sessionTone, sessionToneLabel, conversationLabel, formatDuration, quietMs, togglePinnedId, toolLabel } from './sidebar/session-groups';
import { describeAuditDetails } from './timeline/audit-details';
import { createAgentApi, type AgentApi } from './api/agents';
import { AgentLauncher } from './agents/AgentLauncher';
import { AgentWindows } from './agents/AgentWindows';
import {
  AccountSection,
  BrowserSection,
  ComputerControlSection,
  ImportSection,
  NotificationsSection,
  PetSection,
  PluginsSection,
  ProfileSection,
  ShortcutsSection,
  StartupSection,
  describeTrustedContact,
} from './settings/sections';
import {
  NOTIFICATIONS_DEFAULTS,
  PARENTAL_DEFAULTS,
  PERSONALIZATION_DEFAULTS,
  PET_DEFAULTS,
  PINNED_SESSIONS_DEFAULTS,
  PLUGINS_DEFAULTS,
  PREF_KEYS,
  PROFILE_DEFAULTS,
  TIMELINE_LIMIT_MAX,
  TRUSTED_CONTACT_DEFAULTS,
  hashPin,
  isNotificationsPref,
  isParentalPref,
  isPersonalizationPref,
  isPetPref,
  isPinnedSessionsPref,
  isPluginsPref,
  isProfilePref,
  isTrustedContactPref,
  readPref,
  subscribePref,
  writePref,
  type Density,
  type NotificationsPref,
  type PetPref,
  type ProfilePref,
} from './settings/desktop-prefs';

/**
 * The version the 关于 section shows.
 *
 * Shown only there — this comment used to say "and the sidebar", which never displayed it. `app-version.test.ts`
 * compares it with `apps/web/package.json`, so a release that bumps the manifest and forgets this line fails a test
 * rather than displaying a number that is not the build's.
 */
export const APP_VERSION = '0.9.5';

type LocalizedMessage = string | { readonly source: string; readonly params: MessageParams };
const message = (source: string, params: MessageParams): LocalizedMessage => ({ source, params });
const messageText = (value: LocalizedMessage, locale: Locale): string => typeof value === 'string'
  ? translate(value, {}, locale) : translate(value.source, value.params, locale);
class LocalizedError extends Error {
  readonly localized: LocalizedMessage;
  constructor(source: string, params: MessageParams) {
    super(translate(source, params));
    this.localized = message(source, params);
  }
}

/** 电脑操控's single switch. */
function isRevealPref(value: unknown): value is { allowReveal: boolean } {
  return typeof value === 'object' && value !== null
    && typeof (value as { allowReveal?: unknown }).allowReveal === 'boolean';
}

/**
 * The 续写插件 prompts, joined into the single line the service accepts.
 *
 * The 续写插件 section tells the user that "这些提示词会依次拼接，作为手动续写时使用的提示" — and nothing
 * read them: the one-click 立即续写 called `inject` with no prompt, so the list was a notebook. They are
 * joined with a space because the service refuses anything but a non-empty single line
 * (`apps/cli/src/server/http-server.ts`), and a join longer than that service's 4096-character limit is
 * refused rather than truncated: quietly dropping the end of a prompt is worse than not sending it.
 */
const PLUGIN_PROMPT_LIMIT = 4096;
function pluginPromptLine(): string | undefined {
  const prompts = readPref(PREF_KEYS.plugins, PLUGINS_DEFAULTS, isPluginsPref).prompts
    .map((prompt) => prompt.trim())
    .filter((prompt) => prompt.length > 0);
  if (prompts.length === 0) return undefined;
  const line = prompts.join(' ');
  if (line.length > PLUGIN_PROMPT_LIMIT) {
    throw new LocalizedError('续写插件提示词拼接后共 {count} 字符，超过 {limit} 字符上限，未发送', { count: line.length, limit: PLUGIN_PROMPT_LIMIT });
  }
  return line;
}

/**
 * A number field's value, held inside the range the control states.
 *
 * The service refuses anything else — `requirePositiveNumber` and `requirePositiveInteger` in
 * `apps/cli/src/domain/config.ts` — so a field holding `0`, a negative or a fraction can only fail when
 * 保存 is pressed, after the user has left the field. The inputs declare `min` attributes that nothing
 * enforced; this enforces them, and truncates, because every one of these settings is a whole count of
 * milliseconds or seconds. `Number('')` is 0, which is why clearing a field yields its minimum rather
 * than a rejected save.
 */
function clampNumber(raw: string | number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

type Page = 'overview' | 'process' | 'agents' | 'timeline' | 'settings';
/** What the person chose; 'system' resolves against the OS preference. */
type ThemePreference = 'light' | 'dark' | 'system';
type Theme = 'light' | 'dark';

/**
 * The desktop shell bridge, when the page is running inside Electron.
 *
 * The renderer draws its own `文件 编辑 视图 帮助` row because the native menu
 * bar is hidden behind the custom title bar, so these are the window operations
 * those menus drive. Everything is optional: in a plain browser (the Vite dev
 * server, the static Pages demo) the object is absent and the corresponding
 * menu items render disabled rather than throwing.
 */
interface DesktopShellBridge {
  reload(): void;
  toggleFullScreen(): void;
  /** +1 zooms in, -1 zooms out, 0 returns to 100%. */
  zoom(delta: number): void;
  quit(): void;
  /**
   * The 编辑 commands, which the shell performs on the window's web contents.
   *
   * Optional because an older shell build may not expose them: the items then render disabled, which is what a
   * plain browser sees as well, rather than offering a click that cannot do anything.
   */
  undo?(): void;
  redo?(): void;
  cut?(): void;
  copy?(): void;
  paste?(): void;
  selectAll?(): void;
  openExternal(url: string): Promise<void>;
  /**
   * Repaint the native window-button strip.
   *
   * The title bar is painted from the live palette, so it changes with the
   * theme, the contrast slider and the accent. Reporting the colour actually
   * used keeps the OS-drawn buttons on the same surface instead of leaving the
   * top row split into two strips.
   */
  setTitleBarOverlay?(colors: { color: string; symbolColor?: string }): void;
  /**
   * A still of the window a watched session runs in.
   *
   * Takes a session id rather than a window handle: the desktop shell resolves the window
   * through the service's own session list, so the renderer cannot ask for a picture of an
   * arbitrary window on the machine.
   */
  windowPreview?(sessionId: string): Promise<WindowPreviewResult>;
  /**
   * Type a line into the window a watched session runs in.
   *
   * Takes a session id for the same reason the preview does. The desktop shell refuses a session with no window,
   * and a window shared by several sessions — measured on this machine, two Tabby Codex sessions share one window,
   * and text typed into it would reach whichever pane holds the focus inside it rather than the one chosen here.
   *
   * This takes the foreground briefly, because there is no route that both delivers synthesized input and leaves
   * focus alone. The user chose that trade knowingly.
   */
  windowType?(sessionId: string, text: string, submit: boolean): Promise<WindowTypeResult>;
  openAgentWindow?(sessionId: string): Promise<void>;
  openTerminal?(sessionId: string): Promise<{ ok: boolean; reason?: string; terminal?: string }>;
}

/** The outcome of typing into a session's window. */
export type WindowTypeResult =
  | { readonly ok: true; readonly title?: string; readonly typed?: number; readonly submitted?: boolean; readonly focusRestored?: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * The outcome of a preview request.
 *
 * `unavailable` states are normal, not errors: a session may run in no window at all (DeepSeek
 * Harness is a web UI), and a minimized window is not offered by the OS capture layer at all.
 * Naming which case applies is the difference between an honest panel and a blank frame.
 */
export type WindowPreviewResult =
  | {
    readonly state: 'captured';
    readonly dataUrl: string;
    readonly width: number;
    readonly height: number;
    /** How many watched sessions share this window. Two Codex sessions can share one Tabby. */
    readonly sharedBy: number;
    /**
     * True when the window had to be shown briefly because it was minimized.
     *
     * Optional because a shell that cannot restore windows never sets it; absent and false mean the same
     * thing to the UI.
     */
    readonly restoredFromMinimized?: boolean;
  }
  | { readonly state: 'no-window' }
  | { readonly state: 'minimized' }
  | { readonly state: 'unsupported'; readonly reason?: string };

interface DesktopBridge {
  readonly platform?: string;
  readonly shell?: Partial<DesktopShellBridge>;
  readonly settings?: {
    get(): Promise<{ closeToTray?: boolean; preferredTerminal?: string | null; locale?: Locale }>;
    set(patch: { closeToTray?: boolean; preferredTerminal?: string; locale?: Locale }): Promise<unknown>;
    onChange?(listener: (prefs: { closeToTray: boolean; preferredTerminal: string | null; locale?: Locale }) => void): () => void;
  };
  /** Named commands from the menu bar and the tray. */
  onCommand?(listener: (payload: { command?: string; section?: string }) => void): () => void;
}

function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as { selbstlaufDesktop?: unknown }).selbstlaufDesktop;
  return bridge !== null && typeof bridge === 'object' ? (bridge as DesktopBridge) : null;
}

/**
 * The settings navigation.
 *
 * The reference console groups its settings into two labelled categories, so the
 * rail replaces the earlier flat three-tab strip. Section content lives in
 * `./settings/sections`; this file only decides which section is in view and
 * hands each one its live data.
 */
export const DEFAULT_SETTINGS_SECTION = 'general';

const THEME_QUERY = '(prefers-color-scheme: light)';

/** Resolve a stored preference to the colour scheme actually applied. */
function resolveTheme(preference: ThemePreference, prefersLight: boolean): Theme {
  if (preference === 'system') return prefersLight ? 'light' : 'dark';
  return preference;
}

/** Font stacks the appearance section can switch between. */
type FontChoice = 'system' | 'mono' | 'serif';

/** What the body text renders in, and how heavy it sits. */
interface TypeSetting {
  readonly family: FontChoice;
  /** 400 or 500; the reference pairs the family pick with a weight pick. */
  readonly weight: 400 | 500;
}

/** A per-theme palette chosen in the appearance section. */
interface ThemePalette {
  readonly accent: string;
  readonly background: string;
  readonly foreground: string;
  /** 0-100 slider; feeds the surface and border mixes below. */
  readonly contrast: number;
  /** Draw the sidebar as a translucent layer over the page background. */
  readonly translucentSidebar: boolean;
  /** The interface chrome's type. */
  readonly uiType: TypeSetting;
  /** The reading surfaces' type; "same" reuses the interface stack. */
  readonly contentType: TypeSetting & { readonly sameAsUi: boolean };
}

/** The palette each theme starts from; also what reset returns to. */
const DEFAULT_PALETTES: Record<Theme, ThemePalette> = {
  dark: {
    // Pure black: the dark theme's page background, which every surface
    // (`--panel*`) and border (`--line`) is then mixed up from in the palette
    // effect below. Keep the `:root` fallback in index.css and the desktop
    // window's own colours in step with it.
    accent: '#e6b65b', background: '#000000', foreground: '#e9eef0', contrast: 68,
    translucentSidebar: false,
    uiType: { family: 'system', weight: 400 },
    contentType: { family: 'system', weight: 400, sameAsUi: true },
  },
  light: {
    accent: '#a56a08', background: '#eef2f1', foreground: '#1c262b', contrast: 68,
    translucentSidebar: false,
    uiType: { family: 'system', weight: 400 },
    contentType: { family: 'system', weight: 400, sameAsUi: true },
  },
};

const FONT_CHOICES: readonly FontChoice[] = ['system', 'mono', 'serif'];

/**
 * The semantic colours each theme starts from: green is "writable" or "online", red is a failure,
 * blue is an editor window, amber is a session that can be watched but not written to. They are the app's
 * own colours rather than the user's, so they are not part of the palette — but they are *solved against*
 * it, because the appearance section accepts any background and a status word that cannot be read is worse
 * than a wrong hue. The values here are the ones the stylesheet ships as first-paint literals, unchanged; the
 * effect only moves them when the chosen palette leaves them below AA (see `readableText`).
 *
 * Amber joined this list late, and the reason is the defect this list prevents: it was written at its three
 * use sites as `var(--amber, #e6b65b)` and defined nowhere, so no palette could move it. Measured on the
 * light theme, that literal left the monitor dot at **1.50:1** against the sidebar — very nearly invisible —
 * and with a near-white custom palette on the dark theme it did the same.
 */
const STATUS_COLOURS: Record<Theme, { readonly green: string; readonly red: string; readonly blue: string; readonly amber: string }> = {
  dark: { green: '#74c69d', red: '#e98b81', blue: '#83b9d4', amber: '#e6b65b' },
  light: { green: '#206f50', red: '#a74339', blue: '#2b6983', amber: '#8a5a00' },
};

function normalizeType(value: unknown, fallback: TypeSetting): TypeSetting {
  if (value === null || typeof value !== 'object') return fallback;
  const entry = value as { family?: unknown; weight?: unknown };
  return {
    family: FONT_CHOICES.includes(entry.family as FontChoice) ? (entry.family as FontChoice) : fallback.family,
    weight: entry.weight === 500 ? 500 : fallback.weight,
  };
}

/**
 * The shape a saved palette must have.
 *
 * Saves from an earlier build lack the type and layout fields, so each missing
 * field falls back rather than discarding the whole palette.
 */
function normalizePalette(value: unknown, fallback: ThemePalette): ThemePalette {
  if (value === null || typeof value !== 'object') return fallback;
  const entry = value as Partial<Record<keyof ThemePalette, unknown>>;
  const colour = (key: 'accent' | 'background' | 'foreground') =>
    typeof entry[key] === 'string' && HEX_COLOR.test(entry[key] as string) ? (entry[key] as string) : fallback[key];
  const contentType = value as { contentType?: unknown };
  const content = normalizeType(contentType.contentType, fallback.contentType);
  return {
    accent: colour('accent'),
    background: colour('background'),
    foreground: colour('foreground'),
    contrast: typeof entry.contrast === 'number' && Number.isFinite(entry.contrast)
      ? Math.min(100, Math.max(0, Math.round(entry.contrast)))
      : fallback.contrast,
    translucentSidebar: typeof entry.translucentSidebar === 'boolean' ? entry.translucentSidebar : fallback.translucentSidebar,
    uiType: normalizeType(entry.uiType, fallback.uiType),
    contentType: {
      ...content,
      sameAsUi: (contentType.contentType as { sameAsUi?: unknown } | undefined)?.sameAsUi !== false,
    },
  };
}

/** Ready-made accents, so the common pick needs no colour wheel. */
const ACCENT_PRESETS: readonly { readonly label: string; readonly value: string }[] = [
  { label: '粉色', value: '#e05c93' },
  { label: '天蓝', value: '#4c9cd4' },
  { label: '翠绿', value: '#5aa97c' },
  { label: '石墨', value: '#8a949b' },
];

const PALETTE_STORAGE_KEY = 'watchdog-palette';
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

/** Accept only the required #rrggbb fields, so a bad import cannot half-apply. */
function isThemePalette(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<Record<keyof ThemePalette, unknown>>;
  return (['accent', 'background', 'foreground'] as const).every((key) =>
    typeof entry[key] === 'string' && HEX_COLOR.test(entry[key] as string));
}

/** The CSS font stack behind each choice. */
function fontStack(choice: FontChoice): string {
  if (choice === 'mono') return "var(--mono)";
  if (choice === 'serif') return "Georgia, 'Times New Roman', serif";
  return "'Segoe UI Variable', 'Segoe UI', sans-serif";
}

/** Load the saved overrides; a missing or corrupt entry just means "default". */
function loadPaletteOverrides(): Partial<Record<Theme, ThemePalette>> {
  try {
    const stored = globalThis.localStorage.getItem(PALETTE_STORAGE_KEY);
    if (stored === null) return {};
    const parsed = JSON.parse(stored) as Partial<Record<Theme, unknown>>;
    const overrides: Partial<Record<Theme, ThemePalette>> = {};
    for (const theme of ['light', 'dark'] as const) {
      if (isThemePalette(parsed[theme])) overrides[theme] = normalizePalette(parsed[theme], DEFAULT_PALETTES[theme]);
    }
    return overrides;
  } catch {
    return {};
  }
}



const fallbackConfig: WatchdogConfig = {
  enabled: true,
  dryRun: true,
  pollIntervalMs: 2_000,
  defaultIdleTimeoutMs: 120_000,
  defaultCooldownMs: 300_000,
  maxAttemptsPerQuietPeriod: 1,
  wslDistribution: '',
  tools: {
    claude: {
      enabled: true,
      normalPrompt: '继续',
      stopHook: { enabled: false, leaseTtlMs: 15_000, commandTimeoutMs: 1_500 },
    },
    codex: {
      enabled: true,
      normalPrompt: '继续',
      goalPrompt: '/goal resume',
      goalStatuses: ['active', 'paused'],
    },
    dsh: {
      enabled: true,
      normalPrompt: '继续',
      sessionWindowMs: 3_600_000,
      allowApiInput: true,
    },
  },
  processFilters: { sameUserOnly: true, include: [], exclude: [] },
};

const fallbackHookStatus: ClaudeHookStatusView = {
  installed: false,
  enabled: false,
  restartRequired: false,
  manualReviewRequired: false,
};

/**
 * A config with every field the app reads, whatever the service sent.
 *
 * The client casts the config response rather than validating it, and the app reads that response field by field:
 * the prompt column's `config.tools[tool].normalPrompt` and `tools.codex.goalStatuses`, the process filters, and nine
 * paths across the settings editor. A response missing one of them threw *while rendering* — measured with a
 * hostile-response sweep: `Cannot read properties of undefined (reading 'normalPrompt')`, `(reading 'goalStatuses')`
 * and `(reading 'include')` — and with no error boundary above it, React unmounts the tree and the console blanks.
 *
 * The service validates its own config before storing it (`apps/cli/src/domain/config.ts`), so an incomplete one
 * means version skew rather than a normal state. Filling the gaps from this app's own defaults keeps the console
 * usable, and it leaves the settings editor able to write a complete config back — which is the way out of the skew.
 */
function mergeConfig(raw: WatchdogConfig): WatchdogConfig {
  const tools = raw.tools ?? ({} as Partial<WatchdogConfig['tools']>);
  const claude = tools.claude ?? ({} as Partial<WatchdogConfig['tools']['claude']>);
  const codex = tools.codex ?? ({} as Partial<WatchdogConfig['tools']['codex']>);
  const dsh = tools.dsh ?? ({} as Partial<WatchdogConfig['tools']['dsh']>);
  return {
    ...fallbackConfig,
    ...raw,
    processFilters: { ...fallbackConfig.processFilters, ...raw.processFilters },
    tools: {
      claude: {
        ...fallbackConfig.tools.claude,
        ...claude,
        stopHook: { ...fallbackConfig.tools.claude.stopHook, ...claude.stopHook },
      },
      codex: {
        ...fallbackConfig.tools.codex,
        ...codex,
        // A list the service did not send (or sent as something else) would throw at `.includes` on the first render.
        goalStatuses: Array.isArray(codex.goalStatuses) ? codex.goalStatuses : fallbackConfig.tools.codex.goalStatuses,
      },
      dsh: { ...fallbackConfig.tools.dsh, ...dsh },
    },
  };
}

const now = Date.now();
const fallbackSessions: SessionView[] = [
  {
    id: 'codex:336756',
    tool: 'codex',
    rootPid: 336_756,
    childPids: [327_660],
    conversationId: '01a01a5d',
    goal: { status: 'active', updatedAtMs: now - 26_000 },
    transport: 'codex-app-server',
    alive: true,
    enabled: true,
    paused: false,
    startedAtMs: now - 3_420_000,
    lastActivityAtMs: now - 74_000,
    quietForMs: 74_000,
    pendingPrompt: '/goal resume',
    lastDecision: 'awaiting-quiet-period',
  },
  {
    id: 'claude:214052',
    tool: 'claude',
    rootPid: 214_052,
    childPids: [],
    conversationId: 'project-main',
    goal: null,
    transport: 'classic-console',
    alive: true,
    enabled: true,
    paused: false,
    startedAtMs: now - 1_680_000,
    lastActivityAtMs: now - 18_000,
    quietForMs: 18_000,
    pendingPrompt: '继续',
    lastDecision: 'output-observed',
  },
  {
    id: 'codex:333616',
    tool: 'codex',
    rootPid: 333_616,
    childPids: [177_240],
    conversationId: null,
    goal: null,
    transport: 'monitor-only',
    alive: true,
    enabled: true,
    paused: false,
    startedAtMs: now - 840_000,
    lastActivityAtMs: now - 132_000,
    quietForMs: 132_000,
    pendingPrompt: '继续',
    lastDecision: 'cannot-inject',
    transportError: 'no-cwd-match',
  },
  {
    id: 'dsh:session-4f21c0a8',
    tool: 'dsh',
    rootPid: 973_680,
    childPids: [973_681],
    conversationId: 'session-4f21c0a8-0e75-4f7a-9f0b-2a63b91d0f52',
    goal: null,
    transport: 'monitor-only',
    alive: true,
    enabled: true,
    paused: false,
    startedAtMs: now - 1_260_000,
    lastActivityAtMs: now - 42_000,
    quietForMs: 42_000,
    pendingPrompt: '继续',
    lastDecision: 'awaiting-quiet-period',
    transportError: 'dry run keeps DeepSeek Harness input disabled',
    sessionCwd: 'D:\\project\\ai-cli-bypass',
    runningTurn: false,
  },
];

const fallbackEvents: AuditEvent[] = [
  { id: 'sample-1', timestampMs: now - 18_000, type: 'activity', sessionId: 'claude:214052', tool: 'claude' },
  { id: 'sample-2', timestampMs: now - 74_000, type: 'decision', sessionId: 'codex:336756', tool: 'codex', details: { decision: 'awaiting-quiet-period' } },
  { id: 'sample-3', timestampMs: now - 132_000, type: 'skip', sessionId: 'codex:333616', tool: 'codex', details: { reason: 'monitor-only' } },
  { id: 'sample-4', timestampMs: now - 42_000, type: 'activity', sessionId: 'dsh:session-4f21c0a8', tool: 'dsh', details: { source: 'dsh-session' } },
];

function time(timestampMs: number): string {
  return new Intl.DateTimeFormat(getLocale(), {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(timestampMs);
}

function transportLabel(transport: SessionView['transport']): string {
  const labels: Record<SessionView['transport'], string> = {
    'classic-console': 'Console',
    pty: 'PTY',
    'codex-app-server': 'App Server',
    'claude-stop-hook': 'Stop Hook',
    'dsh-web': 'Harness API',
    'monitor-only': translate("仅监控"),
    'cannot-inject': translate("不可写入"),
    unknown: translate("待识别"),
  };
  // The Record is closed but the response is not validated, so a transport this build has never heard of reaches
  // here as an undefined lookup — and a badge whose only text is `undefined` renders as an empty pill beside its
  // dot. Printing the transport's own name is what `toolLabel` does with the same problem.
  return translate(labels[transport] ?? transport);
}

/**
 * The label for the engine's last decision.
 *
 * Every decision the engine can emit has a label here. The `default` branch used to print the raw value, so a
 * decision with no case — `disabled`, which is what every session reports while the master switch is off — showed
 * the English word to a Chinese-speaking user. Worse, "disabled" reads as "this session cannot be written to",
 * which is exactly the wrong impression: that switch governs automatic continuation only.
 */
export function decisionLabel(decision: string | undefined): { label: string; tone: 'ready' | 'waiting' | 'limited' | 'error' } {
  switch (decision) {
    case 'awaiting-quiet-period': return { label: translate("等待静默"), tone: 'waiting' };
    case 'output-observed': return { label: translate("输出活跃"), tone: 'ready' };
    case 'cannot-inject': return { label: translate("仅监控"), tone: 'limited' };
    case 'transport-error': return { label: translate("传输错误"), tone: 'error' };
    case 'injected': return { label: translate("已写入"), tone: 'ready' };
    case 'activity': return { label: translate("活动"), tone: 'ready' };
    case 'decision': return { label: translate("决策"), tone: 'waiting' };
    case 'skip': return { label: translate("跳过"), tone: 'limited' };
    case 'injection': return { label: translate("已写入"), tone: 'ready' };
    case 'output-recovery': return { label: translate("输出恢复"), tone: 'ready' };
    // The states the engine reports that had no label, so they fell through to the raw string.
    case 'disabled': return { label: translate("自动续写已关闭"), tone: 'limited' };
    case 'cooldown': return { label: translate("冷却中"), tone: 'waiting' };
    case 'max-attempts': return { label: translate("已达本轮上限"), tone: 'limited' };
    case 'paused': return { label: translate("已暂停"), tone: 'limited' };
    case 'new': return { label: translate("新发现"), tone: 'waiting' };
    case 'process-exited': return { label: translate("进程已退出"), tone: 'error' };
    // The rest of the engine's union. Labelling every reachable state keeps each one meaningful: a fallthrough to
    // 未知状态 is honest about an unknown value but says nothing useful about a known one.
    case 'injection-pending': return { label: translate("写入中"), tone: 'waiting' };
    case 'resumed': return { label: translate("已恢复"), tone: 'ready' };
    case 'enabled': return { label: translate("自动续写已开启"), tone: 'ready' };
    case 'clock-rollback': return { label: translate("时钟回退"), tone: 'error' };
    // A decision this build does not know is still reported as an unknown state rather than shown raw, because a
    // bare English identifier in a Chinese interface reads as a fault.
    default: return { label: decision === undefined ? translate("等待活动") : translate("未知状态"), tone: 'waiting' };
  }
}

/**
 * Whether a session can be written to by hand, and the reason when it cannot.
 *
 * Both come from the shared rule in `session/write-eligibility`, so the dot in the sidebar and this page can never
 * disagree — which they did, on a real session, when each kept its own copy.
 *
 * `session.enabled` is deliberately not part of it: that flag is the master switch for *automatic* continuation,
 * and the service never consults it for a manual write. Verified against the running service — a session reporting
 * `enabled=false` answered 200 to a manual inject — so requiring it here made every row claim "会话无法写入"
 * while the write would in fact have worked.
 */
function canInject(session: SessionView): boolean {
  return canWriteSession(session);
}

/** Why a manual write is refused, or null when it is allowed. */
function injectRefusal(session: SessionView): string | null {
  return writeEligibility(session).reason;
}

/* `conversationLabel` lives in ./sidebar/session-groups so the sidebar list and this
   table describe a session's conversation identically rather than duplicating the rule. */

function transportReason(error: string | undefined): string | null {
  if (!error) return null;
  const reasons: Record<string, string> = {
    'no-cwd-match': translate("未找到同目录 Codex 线程"),
    'no-thread-index': translate("未找到 Codex 线程索引"),
    'resume-id-not-found': translate("Codex 恢复线程不存在"),
    'multiple-explicit-matches': translate("Codex 线程关联不唯一"),
    'equally-recent-threads': translate("Codex 线程关联不唯一"),
    'process working directory is unknown': translate("无法读取进程目录"),
    'no unique recent Claude session was found': translate("未找到唯一 Claude 会话"),
    'ambiguous Claude resume session association': translate("Claude 会话关联不唯一"),
    'shared classic Console contains multiple discovered CLI sessions': translate("多个 CLI 共用同一 Console"),
    'Codex state database was not found': translate("未找到 Codex 状态库"),
    'DeepSeek Harness exposes no local input transport': translate("DeepSeek Harness 暂无本机写入通道"),
    'DeepSeek Harness input is disabled in the watchdog settings': translate("已关闭 Harness 写入"),
    'dry run keeps DeepSeek Harness input disabled': translate("Dry Run 期间不写入 Harness"),
    'the local DeepSeek Harness session API is unavailable': translate("未找到可认证的 Harness 本机接口"),
    'harness rejected the local session credential': translate("Harness 拒绝了本机会话凭据"),
    'The harness session still has an unfinished step.': translate("Harness 仍在执行步骤，不打断"),
    'DeepSeek Harness host has no live session': translate("Harness 宿主机没有活动会话"),
    'DeepSeek Harness session is no longer live': translate("Harness 会话已结束"),
    'DeepSeek Harness session disappeared during discovery': translate("Harness 会话在扫描中结束"),
  };
  if (error.startsWith('ambiguous Claude session association')) return translate("Claude 会话关联不唯一");
  return reasons[error] ?? error;
}

/**
 * How the timeline says an audit payload.
 *
 * Each vocabulary comes from the owner that already has it: this app's time format, the status chip's decision
 * labels, and the capability badge's transport reasons — so a reason reads the same wherever it appears. The
 * payload's shape and its own vocabularies live in `./timeline/audit-details`.
 */
const AUDIT_DETAIL_LABELS = {
  time,
  decision: (decision: string) => decisionLabel(decision).label,
  reason: (reason: string) => transportReason(reason) ?? reason,
  tool: toolLabel,
} as const;

function nextPrompt(session: SessionView, config: WatchdogConfig): string {
  if (session.pendingPrompt) return session.pendingPrompt;
  if (session.tool === 'codex' && session.goal && config.tools.codex.goalStatuses.includes(session.goal.status)) {
    return config.tools.codex.goalPrompt;
  }
  /*
    `config.tools` describes claude, codex and dsh, and the sessions response is not validated (the client casts it),
    so a tool outside that set reaches this lookup with no entry. Measured, that threw `Cannot read properties of
    undefined (reading 'normalPrompt')` *while the table rendered* — and with no error boundary above it, React
    unmounts the tree and the whole console goes blank. A stated absence is what the column shows instead.
  */
  return config.tools[session.tool]?.normalPrompt ?? '—';
}

function parseFilterList(value: string): string[] {
  return value.split(/[\r\n,]+/u).map((entry) => entry.trim()).filter(Boolean);
}

function CapabilityBadge({ session }: { session: SessionView }) {
  const { t, locale } = useI18n();
  const actionable = canInject(session);
  const reason = transportReason(session.transportError);
  return (
    <div className="capability-view">
      <span className={`capability ${actionable ? 'capability--ready' : 'capability--limited'}`}>
        <span className="capability__dot" />
        {transportLabel(session.transport)}
      </span>
      {reason && <span className="capability-detail" title={session.transportError}>{reason}</span>}
    </div>
  );
}

function DecisionChip({ decision }: { decision: string | undefined }) {
  const { t, locale } = useI18n();
  const state = decisionLabel(decision);
  return <span className={`state-chip state-chip--${state.tone}`}><span className="state-chip__dot" />{state.label}</span>;
}

function ToolMark({ tool }: { tool: SessionView['tool'] }) {
  const { t, locale } = useI18n();
  // One shared component, so the process table and the sidebar can never drift apart on which art they show.
  return (
    <span className={`tool-mark tool-mark--${tool}`} aria-hidden="true">
      <ToolIcon tool={tool} size={18} />
    </span>
  );
}

interface SessionActionsProps {
  session: SessionView;
  busy: string | null;
  onPause: (session: SessionView) => void;
  onInject: (session: SessionView) => void;
  onFocus: (session: SessionView) => void;
  /** 电脑操控 can switch the reveal action off for the whole app. */
  allowReveal?: boolean;
  onOpenTerminal?: (session: SessionView) => void;
}

function SessionActions({ session, busy, onPause, onInject, onFocus, allowReveal = true, onOpenTerminal }: SessionActionsProps) {
  const { t, locale } = useI18n();
  const waiting = busy === session.id;
  return (
    <div className="row-actions">
      <button
        className="icon-button"
        type="button"
        title={t("打开运行位置")}
        aria-label={t('打开运行位置 PID {pid}', { pid: session.rootPid })}
        disabled={waiting || !allowReveal || !session.alive || session.host === null || session.host === undefined}
        onClick={() => onFocus(session)}
      >
        <SquareArrowOutUpRight size={17} />
      </button>
      {onOpenTerminal !== undefined && <button className="icon-button" type="button" title={t("在首选终端中打开工作目录")} aria-label={t('打开终端 PID {pid}', { pid: session.rootPid })} disabled={waiting || !allowReveal || !session.alive || !session.sessionCwd} onClick={() => onOpenTerminal(session)}><Terminal size={17} /></button>}
      <button
        className="icon-button"
        type="button"
        title={session.paused ? t("恢复监控") : t("暂停监控")}
        aria-label={t(session.paused ? '恢复 PID {pid}' : '暂停 PID {pid}', { pid: session.rootPid })}
        disabled={waiting || !session.alive}
        onClick={() => onPause(session)}
      >
        {session.paused ? <CirclePlay size={17} /> : <CirclePause size={17} />}
      </button>
      <button
        className="icon-button icon-button--accent"
        type="button"
        title={t("立即续写")}
        aria-label={t('立即续写 PID {pid}', { pid: session.rootPid })}
        disabled={waiting || !canInject(session)}
        onClick={() => onInject(session)}
      >
        {waiting ? <RefreshCw className="spin" size={17} /> : <Send size={17} />}
      </button>
    </div>
  );
}

function HostCell({ session }: { session: SessionView }) {
  const { t, locale } = useI18n();
  const host = session.host ?? null;
  /**
   * A WSL session shows both facts: the terminal it was launched from, and that it runs inside a distribution.
   *
   * Measured, the terminal is discoverable — the interop socket pairs the session with the `wsl.exe` under
   * Tabby — so the session is grouped under Tabby like any other. But it still has no window of its own, and
   * saying only "Tabby" would imply one exists, so the distribution is named alongside it.
   */
  if (session.distribution) {
    const distribution = session.distribution;
    const label = host?.label ?? 'WSL';
    return (
      <div className="host-cell">
        {/* The pill truncates a long host name, so the full one stays reachable in a title. */}
        <span className={`host-badge host-badge--${host?.category ?? 'terminal'}`} title={label}>{label}</span>
        <span className="subtle" title={distribution}>WSL · {distribution}</span>
      </div>
    );
  }
  if (host === null) return <span className="subtle">{t("未识别宿主")}</span>;
  return (
    <div className="host-cell">
      <span className={`host-badge host-badge--${host.category}`} title={host.label}>{host.label}</span>
      <span className="subtle" title={host.windowTitle ?? undefined}>
        {host.windowTitle ?? (host.windowHandle === null ? t("网页界面") : `PID ${host.processId}`)}
      </span>
    </div>
  );
}

function ProcessTable(props: {
  sessions: SessionView[];
  config: WatchdogConfig;
  busy: string | null;
  onPause: (session: SessionView) => void;
  onInject: (session: SessionView) => void;
  onFocus: (session: SessionView) => void;
  allowReveal?: boolean;
  onOpenTerminal?: (session: SessionView) => void;
}) {
  const { t, locale } = useI18n();
  /**
   * With nothing discovered, there is nothing to tabulate.
   *
   * The overview is the first screen on every launch, and while the first poll is in flight it
   * legitimately has no sessions; on a machine where nothing is running it stays that way. It
   * rendered the table's header row and an empty card list — six column titles, no rows, and no
   * explanation — and an empty `<table>` is announced as a table with no data, which reads as a
   * broken render rather than as a state. The sidebar list and the 事件 page already explain their
   * empty state; this was the panel that did not.
   */
  if (props.sessions.length === 0) {
    return (
      <div className="empty-state">
        <p>{t("尚未发现进程")}</p>
        <p className="subtle">{t("进程出现后会自动出现在这里，同时列在左侧列表。")}</p>
      </div>
    );
  }

  return (
    <>
      <div className="process-table-wrap">
        <table className="process-table">
          <thead>
            <tr><th>{t("进程")}</th><th>{t("运行位置")}</th><th>{t("能力")}</th><th>{t("对话")}</th><th>{t("静默")}</th><th>{t("下一输入")}</th><th><span className="sr-only">{t("操作")}</span></th></tr>
          </thead>
          <tbody>
            {props.sessions.map((session) => (
              <tr key={session.id} className={!session.alive ? 'is-muted' : undefined}>
                <td>
                  <div className="process-id"><ToolMark tool={session.tool} /><div><strong>{toolLabel(session.tool)}</strong><span>PID {session.rootPid}{session.childPids.length > 0 ? ` + ${session.childPids.length}` : ''}{session.sessionCwd ? ` · ${session.sessionCwd}` : ''}</span></div></div>
                </td>
                <td><HostCell session={session} /></td>
                <td><CapabilityBadge session={session} /></td>
                <td><strong className="conversation">{conversationLabel(session)}</strong><span className="subtle conversation-id">{session.conversationId ?? t("未关联")}</span></td>
                <td><strong>{formatDuration(quietMs(session))}</strong><DecisionChip decision={session.lastDecision} /></td>
                <td><code className="prompt-code">{nextPrompt(session, props.config)}</code></td>
                <td><SessionActions session={session} busy={props.busy} onPause={props.onPause} onInject={props.onInject} onFocus={props.onFocus} allowReveal={props.allowReveal} onOpenTerminal={props.onOpenTerminal} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="session-cards">
        {props.sessions.map((session) => (
          <article className="session-card" key={session.id}>
            <header><div className="process-id"><ToolMark tool={session.tool} /><div><strong>{toolLabel(session.tool)}</strong><span>PID {session.rootPid}{session.sessionCwd ? ` · ${session.sessionCwd}` : ''}</span></div></div><CapabilityBadge session={session} /></header>
            <dl>
              <div className="session-card__host"><dt>{t("运行位置")}</dt><dd><HostCell session={session} /></dd></div>
              <div><dt>{t("对话")}</dt><dd>{conversationLabel(session)}</dd></div>
              <div><dt>{t("静默")}</dt><dd>{formatDuration(quietMs(session))}</dd></div>
              <div className="session-card__prompt"><dt>{t("下一输入")}</dt><dd><code>{nextPrompt(session, props.config)}</code></dd></div>
            </dl>
            <footer><DecisionChip decision={session.lastDecision} /><SessionActions session={session} busy={props.busy} onPause={props.onPause} onInject={props.onInject} onFocus={props.onFocus} allowReveal={props.allowReveal} onOpenTerminal={props.onOpenTerminal} /></footer>
          </article>
        ))}
      </div>
    </>
  );
}

/**
 * One process in full, reached by selecting it in the sidebar list.
 *
 * It reuses the process table's own fields and helpers rather than introducing a
 * second vocabulary, so a value here always means the same thing it does in the table.
 * Actions are the same session actions as the table row, including the reveal gate.
 */
function ProcessDetail(props: {
  readonly session: SessionView | null;
  readonly config: WatchdogConfig;
  readonly busy: string | null;
  readonly sessions: readonly SessionView[];
  readonly onBack: () => void;
  readonly onSelect: (session: SessionView) => void;
  readonly onPause: (session: SessionView) => void;
  readonly onInject: (session: SessionView) => void;
  readonly onFocus: (session: SessionView) => void;
  readonly allowReveal: boolean;
  readonly onOpenTerminal?: (session: SessionView) => void;
  /** Absent outside the desktop shell, where no window can be captured. */
  readonly requestPreview?: (sessionId: string) => Promise<WindowPreviewResult>;
  readonly requestOutput?: (sessionId: string) => Promise<SessionOutputView>;
  /** Write a typed line into the session, reporting whether it was really written. */
  readonly onSendPrompt?: (session: SessionView, prompt: string) => Promise<{ readonly dryRun: boolean }> | { readonly dryRun: boolean };
  /** Type a line into the session's window. Absent outside the desktop shell. */
  readonly onTypeIntoWindow?: (sessionId: string, text: string, submit: boolean) => Promise<WindowTypeResult>;
  /** How many watched sessions share this session's window; more than one refuses typing. */
  readonly windowSharedBy?: number;
}) {
  const { t, locale } = useI18n();
  const session = props.session;
  if (session === null) {
    return (
      <div className="empty-state">
        <p>{t("请选择一个进程")}</p>
        <p className="subtle">
          {props.sessions.length === 0
            ? t("尚未发现进程。进程出现后会自动出现在左侧列表。")
            : t("在左侧列表中选择一个进程即可查看它的详情。")}
        </p>
      </div>
    );
  }

  const quiet = quietMs(session);
  const tone = sessionTone(session);

  return (
    <section className="process-detail">
      <header className="process-detail__header">
        <button className="button button--ghost" type="button" onClick={props.onBack}>
          <ArrowLeft size={17} />{t("返回列表")}</button>
        <div className="process-id">
          <ToolMark tool={session.tool} />
          <div>
            <strong>{toolLabel(session.tool)}</strong>
            <span>PID {session.rootPid}{session.childPids.length > 0 ? ` + ${session.childPids.length}` : ''}</span>
          </div>
        </div>
        <span className={`process-dot process-dot--${tone}`} aria-hidden="true" />
        <span className="subtle">{sessionToneLabel(tone)}</span>
      </header>

      <dl className="process-detail__grid">
        <div><dt>{t("运行位置")}</dt><dd><HostCell session={session} /></dd></div>
        <div><dt>{t("能力")}</dt><dd><CapabilityBadge session={session} /></dd></div>
        <div><dt>{t("对话")}</dt><dd>{conversationLabel(session)}</dd></div>
        <div><dt>{t("静默")}</dt><dd>{formatDuration(quiet)}</dd></div>
        <div><dt>{t("状态")}</dt><dd><DecisionChip decision={session.lastDecision} /></dd></div>
        <div><dt>{t("启动于")}</dt><dd>{time(session.startedAtMs)}</dd></div>
        {session.sessionCwd ? <div className="process-detail__wide"><dt>{t("工作目录")}</dt><dd><code>{session.sessionCwd}</code></dd></div> : null}
        <div className="process-detail__wide"><dt>{t("下一输入")}</dt><dd><code className="prompt-code">{nextPrompt(session, props.config)}</code></dd></div>
        {session.transportError ? <div className="process-detail__wide"><dt>{t("传输错误")}</dt><dd className="process-detail__error">{transportReason(session.transportError) ?? session.transportError}</dd></div> : null}
      </dl>

      {/* The window the process runs in. Placed before the actions because it answers the
          question the detail page exists for — "what is actually happening in there" — and the
          actions at the bottom are then the things you do about it. */}
      <SessionWindowPreview
        session={session}
        onOpenWindow={props.onFocus}
        busy={props.busy === session.id}
        {...(props.requestPreview === undefined ? {} : { requestPreview: props.requestPreview })}
      />

      <SessionOutputPanel sessionId={session.id} {...(props.requestOutput === undefined ? {} : { requestOutput: props.requestOutput })} />

      {/* Writing a line into the session, next to the window it will appear in. */}
      <SessionPromptComposer
        session={session}
        canSend={canInject(session)}
        blockedReason={injectRefusal(session)}
        busy={props.busy === session.id}
        {...(props.onSendPrompt === undefined ? {} : { onSend: props.onSendPrompt })}
      />

      {/*
          Driving the window itself, which is a **different mechanism** from the composer above.

          The two used to appear together as two identical "Input" rows and read as a duplicate; they are not
          duplicates. The composer writes through the session's own transport and costs nothing, while this types
          real keystrokes and must take the foreground. So the composer is strictly better wherever it works, and
          this is kept for the cases it cannot serve — but collapsed behind a disclosure, so the page no longer
          presents two equal-looking input boxes.
        */}
        {props.onTypeIntoWindow === undefined ? null : (
          <WindowTypePanel
            session={session}
            onType={props.onTypeIntoWindow}
            sharedBy={props.windowSharedBy}
            /* Expanded by default only when nothing else can write, which is when it is the only way in. */
            defaultOpen={!canInject(session)}
          />
        )}

      <footer className="process-detail__actions">
        <SessionActions
          session={session}
          busy={props.busy}
          onPause={props.onPause}
          onInject={props.onInject}
          onFocus={props.onFocus}
          allowReveal={props.allowReveal}
          onOpenTerminal={props.onOpenTerminal}
        />
      </footer>

      {props.sessions.length > 1 && (
        <nav className="process-detail__siblings" aria-label={t("其他进程")}>
          {props.sessions.filter((other) => other.id !== session.id).map((other) => (
            <button
              key={other.id}
              type="button"
              className="process-detail__sibling"
              onClick={() => props.onSelect(other)}
            >
              <span className={`process-dot process-dot--${sessionTone(other)}`} aria-hidden="true" />
              {toolLabel(other.tool)}
              <span className="subtle">PID {other.rootPid}</span>
            </button>
          ))}
        </nav>
      )}
    </section>
  );
}

/** A server snapshot and arrivals may contain the same audit event. */
function mergeAuditEvents(history: readonly AuditEvent[], arrivals: readonly AuditEvent[]): AuditEvent[] {
  const byId = new Map(history.map((event) => [event.id, event]));
  for (const event of arrivals) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => right.timestampMs - left.timestampMs).slice(0, TIMELINE_LIMIT_MAX);
}

function Timeline({ events }: { events: AuditEvent[] }) {
  const { t, locale } = useI18n();
  return (
    <div className="timeline">
      {events.length === 0 && <div className="empty-state">{t("暂无事件")}</div>}
      {events.map((event) => {
        const details = describeAuditDetails(event.details, AUDIT_DETAIL_LABELS);
        return (
          <div className="timeline__item" key={event.id}>
            <span className={`timeline__icon timeline__icon--${event.type}`}><Activity size={15} /></span>
            <div><div className="timeline__title"><DecisionChip decision={event.type} /><span>{time(event.timestampMs)}</span></div><p>{event.sessionId ?? 'watchdog'}{details.length > 0 ? ` · ${details}` : ''}</p></div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The local environment panel.
 *
 * Mirrors what CC Switch shows for a Windows install: one card per agent CLI
 * with the installed and published version, a state badge, and a one-press
 * upgrade. The install runs on the service, which serializes global npm runs;
 * the manual-command block stays for anyone who prefers to run it themselves.
 */

const ENVIRONMENT_STATE_LABEL: Record<ToolState, string> = {
  outdated: '可升级',
  current: '已就绪',
  missing: '未安装',
  unknown: '未知',
};

function EnvironmentToolCard({ tool, upgrading, busy, onUpgrade }: {
  tool: EnvironmentToolView;
  /** True while this exact tool is the one npm is installing. */
  upgrading: boolean;
  /** True while any install is running; the service serializes them anyway. */
  busy: boolean;
  onUpgrade: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <article className={`tool-card tool-card--${tool.state}`} data-testid={`tool-${tool.id}`}>
      <header>
        <div className="tool-card__id">
          <strong>{tool.label}</strong>
          <span className="tool-card__package">{tool.packageName}</span>
        </div>
        <span className={`state-chip state-chip--${tool.state === 'current' ? 'ready' : tool.state === 'outdated' ? 'waiting' : tool.state === 'missing' ? 'limited' : 'error'}`}>
          <span className="state-chip__dot" />
          {t(ENVIRONMENT_STATE_LABEL[tool.state])}
        </span>
      </header>
      <dl className="tool-card__versions">
        <div><dt>{t("当前版本")}</dt><dd>{tool.installed ?? t("未安装")}</dd></div>
        <div><dt>{t("最新版本")}</dt><dd>{tool.latest ?? '--'}</dd></div>
      </dl>
      {tool.state === 'outdated' && <code className="tool-card__command">{tool.installCommand}</code>}
      {tool.state === 'outdated' && (
        <div className="tool-card__actions">
          <button
            className="button button--primary"
            type="button"
            aria-label={t('升级 {tool}', { tool: tool.label })}
            disabled={busy}
            onClick={onUpgrade}
          >
            {upgrading ? <RefreshCw className="spin" size={15} /> : <CircleArrowUp size={15} />}
            {upgrading ? t("升级中") : t("升级")}
          </button>
        </div>
      )}
    </article>
  );
}

function EnvironmentPanel(props: {
  environment: EnvironmentView | null;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  /** Id of the tool npm is installing right now, or 'all' for a bulk run. */
  upgrading: string | null;
  onUpgrade: (id: string) => Promise<void>;
  onUpgradeAll: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [manualOpen, setManualOpen] = useState(false);
  const [copyState, setCopyState] = useState<{ readonly status: 'idle' | 'done' | 'failed'; readonly reason: string }>({ status: 'idle', reason: '' });
  /**
   * Copy the whole block as one runnable script.
   *
   * The clipboard is not always available — an insecure context, a denied permission, or a browser
   * that is not on the loopback address, where `navigator.clipboard` is not defined at all — so the
   * confirmation only appears after the write resolves, and a *failure* says so. It used to fall back
   * to "not copied" with no message, which is indistinguishable from a click that never registered;
   * the import section reports 导入失败 with the reason and the appearance panel shows 复制失败, so
   * this one names the reason too.
   */
  const copyManualCommands = async (commands: readonly string[]) => {
    setCopyState({ status: 'idle', reason: '' });
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        throw new Error('当前环境不支持剪贴板');
      }
      await clipboard.writeText(commands.join('\n'));
      setCopyState({ status: 'done', reason: '' });
      window.setTimeout(() => setCopyState({ status: 'idle', reason: '' }), 2_000);
    } catch (error) {
      setCopyState({ status: 'failed', reason: error instanceof Error ? error.message : '未知错误' });
    }
  };
  if (props.environment === null) return null;
  const report = props.environment;
  return (
    <section className="settings-section settings-section--wide environment-panel">
      <div className="section-title">
        <div><span className="eyebrow">{t("Environment")}</span><h2>{t("本地环境检查")}</h2></div>
        <div className="section-title__actions">
          {report.upgrades.length > 0 && (
            <button
              className="button button--primary"
              type="button"
              aria-label={t("全部升级")}
              disabled={props.upgrading !== null || props.refreshing}
              onClick={() => void props.onUpgradeAll()}
            >
              {props.upgrading === 'all' ? <RefreshCw className="spin" size={16} /> : <CircleArrowUp size={16} />}
              {t('全部升级 ({count})', { count: report.upgrades.length })}
            </button>
          )}
          <button
            className="button button--secondary"
            type="button"
            aria-label={t("刷新本地环境")}
            disabled={props.refreshing || props.upgrading !== null}
            onClick={() => void props.onRefresh()}
          >
            {props.refreshing ? <RefreshCw className="spin" size={16} /> : <RefreshCw size={16} />}
            {t("刷新")}</button>
        </div>
      </div>
      <div className="environment-panel__body">
        <div className="tool-grid">
          {report.tools.map((tool) => (
            <EnvironmentToolCard
              key={tool.id}
              tool={tool}
              upgrading={props.upgrading === tool.id}
              busy={props.upgrading !== null}
              onUpgrade={() => void props.onUpgrade(tool.id)}
            />
          ))}
        </div>
        <div className="manual-commands">
          <button
            className="manual-commands__toggle"
            type="button"
            aria-expanded={manualOpen}
            onClick={() => setManualOpen((current) => !current)}
          >
            <Terminal size={16} />
            {t("手动安装命令")}<span className="manual-commands__chevron">{manualOpen ? t("收起") : t("展开")}</span>
          </button>
          {manualOpen && (
            <div className="manual-commands__body">
              <div className="manual-commands__actions">
                <button
                  className="button button--secondary"
                  type="button"
                  aria-label={t("复制安装命令")}
                  /* The name stays constant, so the outcome is announced as a live region rather than
                     relying on the accessible name — which never changes for a labelled button. */
                  aria-live="polite"
                  title={copyState.status === 'failed' ? t('复制失败：{detail}', { detail: t(copyState.reason) }) : undefined}
                  onClick={() => { void copyManualCommands(report.manualCommands); }}
                >
                  <Copy size={15} />
                  {copyState.status === 'done' ? t("已复制") : copyState.status === 'failed' ? t("复制失败") : t("复制")}
                </button>
              </div>
              <pre data-testid="manual-commands">{report.manualCommands.map((command) => `# ${command.split(' ').at(-1)?.replace('@latest', '') ?? ''}\n${command}`).join('\n')}</pre>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
function CodexEndpointsPanel(props: {
  profiles: CodexProfilesView | null;
  onApply: (fields: CodexProfileEditView[]) => Promise<void>;
  applying: boolean;
}) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current += 1; }, []);
  if (props.profiles === null) return null;
  const profiles = props.profiles;
  const activeByKey = profiles.active;
  const busy = props.applying || pending;
  const valueOf = (key: string) => draft[key] ?? activeByKey[key] ?? '';
  const edits = (values: Readonly<Record<string, string>>): CodexProfileEditView[] => Object.entries(values).flatMap<CodexProfileEditView>(([key, value]) => {
    if (value.trim().length === 0) return Object.hasOwn(activeByKey, key) ? [{ key, value: null }] : [];
    if (value === activeByKey[key]) return [];
    return [{ key, value }];
  });
  const apply = async (values: Readonly<Record<string, string>> = draft) => {
    if (busy) return;
    const fields = edits(values);
    if (fields.length === 0) return;
    const mine = ++sequence.current;
    setPending(true);
    setError(null);
    try {
      await props.onApply(fields);
      if (mine === sequence.current) setDraft({});
    } catch (cause) {
      if (mine === sequence.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (mine === sequence.current) setPending(false); }
  };
  const switchTo = async (key: string, value: string) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    await apply(next);
  };
  return (
    <section className="settings-section settings-section--wide codex-endpoints">
      <div className="section-title"><div><span className="eyebrow">Codex</span><h2>{t("端点配置")}</h2></div><Plug size={20} /></div>
      <div className="codex-endpoints__body">
        <p className="hook-disclosure"><CircleAlert size={17} /><span>{t('切换会直接改写 {path}，并把旧值保留为注释；每次写入前都会生成 .bak 备份。清空字段并应用会移除该设置，旧值仍保留为注释。', { path: profiles.path })}</span></p>
        <div className="field-grid codex-endpoints__fields">
          {[
            { key: 'model', label: t("模型") },
            { key: 'review_model', label: t("评审模型") },
            { key: 'model_reasoning_effort', label: t("推理强度") },
          ].map((entry) => (
            <label key={entry.key}><span>{entry.label}</span><input aria-label={entry.label} disabled={busy} value={valueOf(entry.key)} onChange={(event) => setDraft((current) => ({ ...current, [entry.key]: event.target.value }))} /></label>
          ))}
        </div>
        {(['base_url', 'experimental_bearer_token'] as const).map((key) => {
          const alternatives = profiles.alternatives[key] ?? [];
          const current = valueOf(key);
          return (
            <div className="field-grid codex-endpoints__fields" key={key}>
              <label><span>{key === 'base_url' ? t("接口地址") : t("访问令牌")}</span><input aria-label={key === 'base_url' ? t("接口地址") : t("访问令牌")} disabled={busy} value={current} onChange={(event) => setDraft((values) => ({ ...values, [key]: event.target.value }))} /></label>
              {alternatives.length > 0 && (
                <div className="codex-endpoints__alternatives">
                  <span>{t("已注释的备选")}</span>
                  <div className="codex-endpoints__chips">
                    {[...new Set([...alternatives, activeByKey[key]].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))].map((alternative) => (
                      <button key={alternative} className={alternative === current ? 'chip is-active' : 'chip'} type="button" disabled={busy} onClick={() => void switchTo(key, alternative)}>{alternative}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div className="settings-actions"><button className="button button--primary" type="button" disabled={busy || edits(draft).length === 0} onClick={() => void apply()}>{busy ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}{t("应用端点配置")}</button></div>
        {error && <p className="hook-error" role="alert">{t('端点保存失败：{detail}', { detail: t(error) })}</p>}
      </div>
    </section>
  );
}

/**
 * The appearance section.
 *
 * Mirrors the reference's appearance page: three theme previews on a light
 * card, a diff of the values each theme resolves to, then one row per setting
 * (accent, background, foreground, type, contrast) so the page reads as a list
 * of choices rather than a wall of cards.
 */
const THEME_OPTIONS: readonly { readonly id: ThemePreference; readonly label: string; readonly ariaLabel: string }[] = [
  { id: 'system', label: '系统', ariaLabel: '跟随系统' },
  { id: 'light', label: '浅色', ariaLabel: '浅色' },
  { id: 'dark', label: '深色', ariaLabel: '深色' },
];

function ThemePreviewCard(props: {
  readonly id: ThemePreference;
  readonly label: string;
  /** Fuller name for assistive tech; the visible caption stays short. */
  readonly ariaLabel: string;
  readonly scheme: Theme;
  readonly selected: boolean;
  readonly palette: ThemePalette;
  /** For the system card: the light and dark palettes it shows side by side. */
  readonly systems?: readonly [ThemePalette, ThemePalette];
  readonly onSelect: () => void;
}) {
  const { t, locale } = useI18n();
  // A system card shows both schemes at once, split down the middle.
  const [left, right] = props.systems ?? [props.palette, props.palette];
  /**
   * The swatch is the palette the effect would paint, through the effect's own derivation.
   *
   * This used to mix toward the *foreground* at fixed 0.1/0.16 for the dark scheme and never read
   * `contrast`, so the dark card's rail showed `rgb(23, 24, 24)` where the app painted `#0d0d0d`, its
   * sheet `rgb(37, 38, 38)` where the app painted `#0f0f0f`, and moving the contrast slider moved the
   * app while the swatches sat still.
   */
  const card = (scheme: Theme, palette: ThemePalette) => {
    const swatch = paletteSurfaces(palette);
    return (
      <span className="theme-preview__half" data-scheme={scheme} style={{ background: palette.background }}>
        <span className="theme-preview__shell">
          <span className="theme-preview__rail" style={{ background: swatch.rail }} />
          <span className="theme-preview__sheet" style={{ background: swatch.panel }}>
            <span className="theme-preview__bar" style={{ background: palette.accent }} />
            <span className="theme-preview__line" style={{ background: palette.foreground, opacity: .5 }} />
            <span className="theme-preview__line theme-preview__line--short" style={{ background: palette.foreground, opacity: .3 }} />
          </span>
        </span>
      </span>
    );
  };
  return (
    <button
      className={props.selected ? 'theme-preview is-active' : 'theme-preview'}
      type="button"
      role="radio"
      aria-checked={props.selected}
      aria-label={t(props.ariaLabel)}
      onClick={props.onSelect}
    >
      <span className="theme-preview__canvas">
        {props.id === 'system'
          ? <>{card('light', left)}{card('dark', right)}</>
          : card(props.scheme, props.palette)}
      </span>
      <span className="theme-preview__label">{t(props.label)}</span>
    </button>
  );
}

/**
 * The side-by-side code sample.
 *
 * The left pane keeps the stock values so the comparison reads as a diff: what the theme ships with
 * against what the current choices resolve to.
 *
 * `THEME_DIFF_FIELDS` lists what that comparison covers, in the order the appearance list offers
 * them. `surface` is a name rather than a colour because the palette really does hold a *toggle*
 * (`translucentSidebar`); everything else is a value the user can set.
 */
const THEME_DIFF_FIELDS: readonly { readonly field: string; readonly quoted: boolean }[] = [
  { field: 'surface', quoted: true },
  { field: 'background', quoted: true },
  { field: 'foreground', quoted: true },
  { field: 'accent', quoted: true },
  { field: 'contrast', quoted: false },
];

function ThemeDiffPreview(props: {
  readonly palette: ThemePalette;
  readonly activeTheme: Theme;
}) {
  const { t, locale } = useI18n();
  const before = DEFAULT_PALETTES[props.activeTheme];
  const after = props.palette;
  /**
   * Every field the palette holds, so the diff is the difference the user is making.
   *
   * It used to show `surface` (a token *name*), `accent` and `contrast` only, while the list directly
   * above it offers colour pickers for 背景 and 前景. Measured: setting the background to `#fdf6e3`
   * repainted the app (`--bg #fdf6e3`) and left this pane byte-identical, so it read as a diff of
   * choices as though two of the five had not been made.
   */
  const rows: readonly { readonly from: string; readonly to: string }[] = [
    { from: before.translucentSidebar ? 'sidebar-elevated' : 'sidebar', to: after.translucentSidebar ? 'sidebar-elevated' : 'sidebar' },
    { from: before.background, to: after.background },
    { from: before.foreground, to: after.foreground },
    { from: before.accent, to: after.accent },
    { from: String(before.contrast), to: String(after.contrast) },
  ];
  const pane = (values: readonly string[], isAfter: boolean) => (
    <div className={isAfter ? 'theme-diff__pane theme-diff__pane--after' : 'theme-diff__pane'}>
      <span className="theme-diff__gutter" aria-hidden="true" />
      <span className="theme-diff__code">
        <span className="theme-diff__title">const themePreview: ThemeConfig = {'{'}</span>
        {values.map((value, index) => (
          <span className="theme-diff__line" key={THEME_DIFF_FIELDS[index]!.field}>
            <span className="theme-diff__num">{index + 2}</span>
            {THEME_DIFF_FIELDS[index]!.field}: {THEME_DIFF_FIELDS[index]!.quoted ? `"${value}"` : value},
          </span>
        ))}
        <span className="theme-diff__title">{'}'};</span>
      </span>
    </div>
  );
  return (
    <div className="theme-diff" data-testid="theme-diff">
      {pane(rows.map((row) => row.from), false)}
      {pane(rows.map((row) => row.to), true)}
    </div>
  );
}

/** One labelled row in the settings list. */
function AppearanceRow(props: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="appearance-row">
      <span className="appearance-row__label">{t(props.label)}</span>
      <div className="appearance-row__control">{props.children}</div>
    </div>
  );
}

function AppearancePanel(props: {
  readonly preference: ThemePreference;
  readonly activeTheme: Theme;
  readonly palette: ThemePalette;
  readonly palettes: Record<Theme, ThemePalette>;
  readonly customized: boolean;
  readonly onPreferenceChange: (theme: ThemePreference) => void;
  readonly onPaletteChange: (patch: Partial<ThemePalette>) => void;
  readonly onPaletteReset: () => void;
  readonly onImport: () => Promise<void>;
  readonly onCopy: () => Promise<void>;
  /** Comfortable or compact spacing; not part of the palette, so it survives a theme switch. */
  readonly density: Density;
  readonly onDensityChange: (next: Density) => void;
}) {
  const { t, locale } = useI18n();
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');
  const copy = async () => {
    setCopyState('idle');
    try {
      await props.onCopy();
      setCopyState('done');
      window.setTimeout(() => setCopyState('idle'), 2_000);
    } catch {
      setCopyState('failed');
    }
  };
  const ui = props.palette.uiType;
  const content = props.palette.contentType;
  const setUi = (patch: Partial<TypeSetting>) => props.onPaletteChange({ uiType: { ...ui, ...patch } });
  const setContent = (patch: Partial<TypeSetting & { sameAsUi: boolean }>) =>
    props.onPaletteChange({ contentType: { ...content, ...patch } });
  return (
    <section className="settings-section settings-section--wide appearance-panel">
      <div className="section-title">
        <div><span className="eyebrow">{t("Appearance")}</span><h2>{t("外观")}</h2></div>
        <div className="appearance-panel__actions">
          <button className="text-button" type="button" onClick={() => void props.onImport()}>
            <Copy size={14} /> {t("导入")}</button>
          <button className="text-button" type="button" onClick={() => void copy()}>
            <Copy size={14} /> {copyState === 'done' ? t("已复制") : copyState === 'failed' ? t("复制失败") : t("复制主题")}
          </button>
        </div>
      </div>
      <p className="section-hint">{t("选择应用的外观主题与排版，立即生效。")}</p>
      <div className="theme-previews" role="radiogroup" aria-label={t("外观主题")}>
        {THEME_OPTIONS.map((option) => (
          <ThemePreviewCard
            key={option.id}
            id={option.id}
            label={option.label}
            ariaLabel={option.ariaLabel}
            scheme={option.id === 'system' ? props.activeTheme : option.id}
            selected={props.preference === option.id}
            palette={option.id === 'system' ? props.palettes[props.activeTheme] : props.palettes[option.id as Theme]}
            systems={[props.palettes.light, props.palettes.dark]}
            onSelect={() => props.onPreferenceChange(option.id)}
          />
        ))}
      </div>
      <ThemeDiffPreview palette={props.palette} activeTheme={props.activeTheme} />
      <div className="appearance-list">
        <AppearanceRow label={t("强调色")}>
          <select
            aria-label={t("强调色")}
            value={props.palette.accent}
            onChange={(event) => props.onPaletteChange({ accent: event.target.value })}
          >
            {[...new Set([props.palette.accent, ...ACCENT_PRESETS.map((preset) => preset.value)])].map((value) => (
              <option key={value} value={value}>
                {t(ACCENT_PRESETS.find((preset) => preset.value === value)?.label ?? '当前')}
              </option>
            ))}
          </select>
        </AppearanceRow>
        <AppearanceRow label={t("背景")}>
          <span className="appearance-swatch">
            <input
              type="color"
              aria-label={t("背景")}
              value={props.palette.background}
              onChange={(event) => props.onPaletteChange({ background: event.target.value })}
            />
            <code>{props.palette.background.toUpperCase()}</code>
          </span>
        </AppearanceRow>
        <AppearanceRow label={t("前景")}>
          <span className="appearance-swatch">
            <input
              type="color"
              aria-label={t("前景")}
              value={props.palette.foreground}
              onChange={(event) => props.onPaletteChange({ foreground: event.target.value })}
            />
            <code>{props.palette.foreground.toUpperCase()}</code>
          </span>
        </AppearanceRow>
        <AppearanceRow label={t("UI 字体")}>
          <select aria-label={t("UI 字体")} value={ui.family} onChange={(event) => setUi({ family: event.target.value as FontChoice })}>
            <option value="system">{t("系统默认")}</option>
            <option value="mono">{t("等宽")}</option>
            <option value="serif">{t("衬线")}</option>
          </select>
          <select aria-label={t("UI 字重")} value={String(ui.weight)} onChange={(event) => setUi({ weight: event.target.value === '500' ? 500 : 400 })}>
            <option value="400">{t('常规字重')}</option>
            <option value="500">{t("中等")}</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label={t("内容字体")}>
          <select
            aria-label={t("内容字体")}
            value={content.sameAsUi ? 'same' : content.family}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'same') setContent({ sameAsUi: true });
              else setContent({ sameAsUi: false, family: value as FontChoice });
            }}
          >
            <option value="same">{t("与界面字体相同")}</option>
            <option value="system">{t("系统默认")}</option>
            <option value="mono">{t("等宽")}</option>
            <option value="serif">{t("衬线")}</option>
          </select>
          <select
            aria-label={t("内容字重")}
            value={String(content.weight)}
            onChange={(event) => setContent({ weight: event.target.value === '500' ? 500 : 400 })}
          >
            <option value="400">{t('常规字重')}</option>
            <option value="500">{t("中等")}</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label={t("半透明侧边栏")}>
          <label className="switch">
            <input
              aria-label={t("半透明侧边栏")}
              type="checkbox"
              checked={props.palette.translucentSidebar}
              onChange={(event) => props.onPaletteChange({ translucentSidebar: event.target.checked })}
            />
            <span />
          </label>
        </AppearanceRow>
        <AppearanceRow label={t("界面密度")}>
          <select
            aria-label={t("界面密度")}
            title={t("紧凑会收紧设置分区、外观行与进程表的行距")}
            value={props.density}
            onChange={(event) => props.onDensityChange(event.target.value === 'compact' ? 'compact' : 'comfortable')}
          >
            <option value="comfortable">{t("舒适")}</option>
            <option value="compact">{t("紧凑")}</option>
          </select>
        </AppearanceRow>
        <AppearanceRow label={t("对比度")}>
          <span className="appearance-slider">
            <input
              type="range"
              aria-label={t("对比度")}
              min="0"
              max="100"
              step="1"
              value={props.palette.contrast}
              onChange={(event) => props.onPaletteChange({ contrast: Number(event.target.value) })}
            />
            <code>{props.palette.contrast}</code>
          </span>
        </AppearanceRow>
      </div>
      {props.customized && (
        <div className="settings-actions">
          <button className="button button--secondary" type="button" onClick={props.onPaletteReset}>{t("恢复默认")}</button>
        </div>
      )}
    </section>
  );
}

function SettingsPanel(props: {
  config: WatchdogConfig;
  hookStatus: ClaudeHookStatusView;
  profiles: CodexProfilesView | null;
  environment: EnvironmentView | null;
  environmentRefreshing: boolean;
  environmentUpgrading: string | null;
  onRefreshEnvironment: () => Promise<void>;
  onUpgradeTool: (id: string) => Promise<void>;
  onUpgradeAllTools: () => Promise<void>;
  /** Push a 通知 change up: the notice strip and the timeline filter on these preferences. */
  onNotificationsChange: (pref: NotificationsPref) => void;
  /** Comfortable or compact spacing; the app owns it so a change reaches the document root. */
  density: Density;
  onDensityChange: (next: Density) => void;
  /** The desktop ornament, drawn by the shell so it is on screen on every page. */
  pet: PetPref;
  onPetChange: (next: PetPref) => void;
  theme: ThemePreference;
  /** The scheme the preference actually resolves to right now. */
  activeTheme: Theme;
  /** The palette in effect for the active scheme. */
  palette: ThemePalette;
  /** Both schemes' effective palettes, for the preview cards. */
  palettes: Record<Theme, ThemePalette>;
  /** True when that palette is a person's override rather than the default. */
  customized: boolean;
  onThemeChange: (theme: ThemePreference) => void;
  onPaletteChange: (patch: Partial<ThemePalette>) => void;
  onPaletteReset: () => void;
  onImportTheme: () => Promise<void>;
  onCopyTheme: () => Promise<void>;
  onApplyProfile: (fields: CodexProfileEditView[]) => Promise<void>;
  applyingProfile: boolean;
  saving: boolean;
  running: boolean;
  onSave: (config: WatchdogConfig) => Promise<void>;
  onToggle: () => Promise<void>;
  onInstall: () => Promise<void>;
  startupInstalled: boolean;
  onToggleStartup: () => Promise<void>;
  onInstallClaudeHook: () => Promise<void>;
  onUninstallClaudeHook: () => Promise<void>;
  onDisableClaudeHook: () => Promise<void>;
  onUninstall: () => Promise<void>;
  /** Live data the rail sections read. */
  sessions: readonly SessionView[];
  events: readonly AuditEvent[];
  connected: boolean;
  /** Which rail entry is in view; owned by the app so the tray can target one. */
  activeSection: string;
  onSectionChange: (id: string) => void;
  /** Leave the settings page (the rail's 返回应用). */
  onBack: () => void;
  /** Apply a theme/config blob read from the clipboard by the import section. */
  onImportThemeText: (text: string) => Promise<void>;
  onImportConfigText: (text: string) => Promise<void>;
  /** Lets the sidebar brand block adopt the imported 显示名称. */
  onDisplayNameChange: (name: string) => void;
  allowReveal: boolean;
  onAllowRevealChange: (allowed: boolean) => void;
  closeToTray: boolean | null;
  onCloseToTrayChange: (value: boolean) => void;
  preferredTerminal: string | null;
  onPreferredTerminalChange: (value: string) => void;
  desktopBridgeAvailable: boolean;
  desktopPlatform?: string;
  desktopSettingsBusy?: boolean;
  desktopSettingsError?: string | null;
  staticDemo: boolean;
  /** Origin this WebUI is served from. */
  origin: string;
}) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState(() => structuredClone(props.config));
  // The rail is the navigation; the app owns which section is in view so a tray
  // command can open the settings page directly on a named section.
  const activeSection = props.activeSection;
  const [includeFilters, setIncludeFilters] = useState(() => props.config.processFilters.include.join(', '));
  const [excludeFilters, setExcludeFilters] = useState(() => props.config.processFilters.exclude.join(', '));
  useEffect(() => {
    setDraft(structuredClone(props.config));
    setIncludeFilters(props.config.processFilters.include.join(', '));
    setExcludeFilters(props.config.processFilters.exclude.join(', '));
  }, [props.config]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void props.onSave({
      ...draft,
      processFilters: {
        ...draft.processFilters,
        include: parseFilterList(includeFilters),
        exclude: parseFilterList(excludeFilters),
      },
    });
  };

  /** The config save bar, shared by the sections that edit the service config. */
  const saveBar = (
    <div className="settings-actions"><button className="button button--primary" type="submit" disabled={props.saving}>{props.saving ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}{t("保存配置")}</button><button className="button button--secondary" type="button" onClick={() => void props.onInstall()} disabled={props.saving}><CirclePlay size={17} />{t("安装 Watchdog")}</button><button className="button button--secondary" type="button" onClick={() => void props.onToggleStartup()} disabled={props.saving}><Power size={17} />{props.startupInstalled ? t("移除启动项") : t("安装启动项")}</button><button className={`button ${props.running ? 'button--stop' : 'button--start'}`} type="button" onClick={() => void props.onToggle()} disabled={props.saving}>{props.running ? <Power size={17} /> : <CirclePlay size={17} />}{props.running ? t("停止 Watchdog") : t("启动 Watchdog")}</button><button className="button button--danger" type="button" onClick={() => void props.onUninstall()} disabled={props.saving}><Trash2 size={17} />{t("卸载 Watchdog")}</button></div>
  );

  return (
    <form className="settings-shell" onSubmit={submit}>
      {/* The section rail is this page's left column now, so the app shell renders it
          beside the content rather than inside this form.
          Keyed on the active section so React replaces the subtree when the section changes,
          which restarts the CSS enter animation: switching sections then reads as a change of
          place rather than as text silently swapping under the cursor. */}
      <div className="settings-content" key={activeSection}>
      {props.staticDemo && <p className="section-hint settings-section--wide" role="note">{t("演示模式：设置保存在此浏览器。Watchdog、启动项、Stop Hook、Codex 端点与工具安装操作仅模拟，不会操作本机进程或文件。")}</p>}
      {activeSection === 'appearance' && (
        <>
          <AppearancePanel
            preference={props.theme}
            activeTheme={props.activeTheme}
            palette={props.palette}
            palettes={props.palettes}
            customized={props.customized}
            onPreferenceChange={props.onThemeChange}
            onPaletteChange={props.onPaletteChange}
            onPaletteReset={props.onPaletteReset}
            onImport={props.onImportTheme}
            onCopy={props.onCopyTheme}
            density={props.density}
            onDensityChange={props.onDensityChange}
          />
          <LanguageSection />
        </>
      )}
      {activeSection === 'general' && (
        <>
      <section className="settings-section settings-section--wide">
        <div className="section-title"><div><span className="eyebrow">Watchdog</span><h2>{t("常规")}</h2></div><Gauge size={20} /></div>
        <p className="section-hint">{t("检测节奏、续写提示词与进程范围，保存后立即生效。")}</p>
        <div className="switch-row"><div><strong>{t("启用自动续写")}</strong><span>{t("关闭后继续发现进程和记录事件，停止自动发送续写提示词")}</span></div><label className="switch"><input aria-label={t("启用自动续写")} type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span /></label></div>
        {(['claude', 'codex', 'dsh'] as const).map((tool) => <div className="switch-row" key={tool}><div><strong>{t('监控 {tool}', { tool: toolLabel(tool) })}</strong><span>{t("控制该工具的自动续写；进程仍显示以便查看")}</span></div><label className="switch"><input aria-label={t('监控 {tool}', { tool: toolLabel(tool) })} type="checkbox" checked={draft.tools[tool].enabled} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, [tool]: { ...draft.tools[tool], enabled: event.target.checked } } })} /><span /></label></div>)}
      </section>
      <section className="settings-section">
        <div className="section-title"><div><span className="eyebrow">{t("Timing")}</span><h2>{t("检测节奏")}</h2></div><Gauge size={20} /></div>
        <div className="field-grid">
          <label><span>{t("静默阈值（秒）")}</span><input type="number" min="1" value={draft.defaultIdleTimeoutMs / 1_000} onChange={(event) => setDraft({ ...draft, defaultIdleTimeoutMs: clampNumber(event.target.value, 1) * 1_000 })} /></label>
          <label><span>{t("冷却时间（秒）")}</span><input type="number" min="1" value={draft.defaultCooldownMs / 1_000} onChange={(event) => setDraft({ ...draft, defaultCooldownMs: clampNumber(event.target.value, 1) * 1_000 })} /></label>
          <label><span>{t("轮询间隔（毫秒）")}</span><input type="number" min="250" step="250" value={draft.pollIntervalMs} onChange={(event) => setDraft({ ...draft, pollIntervalMs: clampNumber(event.target.value, 250) })} /></label>
          <label><span>{t("每轮最大尝试")}</span><input type="number" min="1" value={draft.maxAttemptsPerQuietPeriod} onChange={(event) => setDraft({ ...draft, maxAttemptsPerQuietPeriod: clampNumber(event.target.value, 1) })} /></label>
        </div>
      </section>
      <section className="settings-section">
        <div className="section-title"><div><span className="eyebrow">{t("Prompts")}</span><h2>{t("续写内容")}</h2></div><Terminal size={20} /></div>
        <div className="field-stack">
          <label><span>Claude</span><input value={draft.tools.claude.normalPrompt} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, claude: { ...draft.tools.claude, normalPrompt: event.target.value } } })} /></label>
          <label><span>{t("Codex 普通对话")}</span><input value={draft.tools.codex.normalPrompt} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, codex: { ...draft.tools.codex, normalPrompt: event.target.value } } })} /></label>
          <label><span>Codex Goal</span><input value={draft.tools.codex.goalPrompt} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, codex: { ...draft.tools.codex, goalPrompt: event.target.value } } })} /></label>
          <label><span>DeepSeek Harness</span><input value={draft.tools.dsh.normalPrompt} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, dsh: { ...draft.tools.dsh, normalPrompt: event.target.value } } })} /></label>
          <label><span>{t("Harness 活动窗口（分钟）")}</span><input aria-label={t("Harness 活动窗口（分钟）")} type="number" min="1" value={Math.round(draft.tools.dsh.sessionWindowMs / 60_000)} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, dsh: { ...draft.tools.dsh, sessionWindowMs: clampNumber(event.target.value, 1) * 60_000 } } })} /></label>
        </div>
        <div className="switch-row"><div><strong>{t("允许续写 DeepSeek Harness")}</strong><span>{t("通过 Harness 自己的本机会话接口写入，仅在会话已停止且能完成本机认证时生效")}</span></div><label className="switch"><input aria-label={t("允许续写 DeepSeek Harness")} type="checkbox" checked={draft.tools.dsh.allowApiInput} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, dsh: { ...draft.tools.dsh, allowApiInput: event.target.checked } } })} /><span /></label></div>
        <div className="switch-row"><div><strong>{t("Dry run")}</strong><span>{t("只记录决策，不写入进程")}</span></div><label className="switch"><input aria-label={t('Dry run')} type="checkbox" checked={draft.dryRun} onChange={(event) => setDraft({ ...draft, dryRun: event.target.checked })} /><span /></label></div>
        <fieldset className="goal-status-settings"><legend>{t("Codex Goal 续写状态")}</legend><p className="section-hint">{t("选中的 active / paused 状态使用 Goal 提示词；至少保留一个状态。其他状态使用普通对话提示词。")}</p>{(['active', 'paused'] as const).map((status) => <label key={status}><input type="checkbox" aria-label={t("Goal 状态 {status}", { status })} disabled={draft.tools.codex.goalStatuses.length === 1 && draft.tools.codex.goalStatuses.includes(status)} checked={draft.tools.codex.goalStatuses.includes(status)} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, codex: { ...draft.tools.codex, goalStatuses: event.target.checked ? [...draft.tools.codex.goalStatuses, status] : draft.tools.codex.goalStatuses.filter((entry) => entry !== status) } } })} /><span>{status === 'active' ? t("active（进行中）") : t("paused（已暂停）")}</span></label>)}</fieldset>
      </section>
      <section className="settings-section settings-section--wide">
        <div className="section-title"><div><span className="eyebrow">{t("Processes")}</span><h2>{t("进程范围")}</h2></div><ShieldAlert size={20} /></div>
        <div className="field-grid">
          <label><span>{t("包含匹配")}</span><input aria-label={t("包含匹配")} placeholder={t("例如 Nexus, study-os")} value={includeFilters} onChange={(event) => setIncludeFilters(event.target.value)} /></label>
          <label><span>{t("排除匹配")}</span><input aria-label={t("排除匹配")} placeholder={t("例如 node_modules")} value={excludeFilters} onChange={(event) => setExcludeFilters(event.target.value)} /></label>
        </div>
        <div className="switch-row"><div><strong>{t("仅监控当前用户进程")}</strong><span>{t("关闭后会发现其他用户进程，但仍只对安全关联且可验证的会话写入")}</span></div><label className="switch"><input aria-label={t("仅监控当前用户进程")} type="checkbox" checked={draft.processFilters.sameUserOnly} onChange={(event) => setDraft({ ...draft, processFilters: { ...draft.processFilters, sameUserOnly: event.target.checked } })} /><span /></label></div>
      </section>
      {/*
        WSL is opt-in and left empty by default, because looking inside a distribution costs a subprocess per
        poll while only helping someone who runs a CLI there. The field names the distribution exactly as
        `wsl -l -q` reports it: a session inside one has no window, so the distribution is what identifies it.
      */}
      <section className="settings-section">
        <div className="section-title"><div><span className="eyebrow">WSL</span><h2>{t("WSL 发行版")}</h2></div><Terminal size={20} /></div>
        <p className="section-hint">{t("留空即不监控。填入发行版名称（如 Ubuntu-22.04）后，会一并监控该发行版里的 codex / claude 会话。")}</p>
        <div className="field-stack">
          <label><span>{t("发行版名称")}</span><input aria-label={t("WSL 发行版名称")} placeholder={t("留空即关闭")} value={draft.wslDistribution ?? ''} onChange={(event) => setDraft({ ...draft, wslDistribution: event.target.value })} /></label>
        </div>
      </section>
      {saveBar}
        </>
      )}

      {/*
        The 配置 section.

        The rail advertises this entry, and it used to render nothing at all: the
        Claude Stop Hook block and the Codex endpoint panel were mounted under 常规, so
        selecting 配置 produced an empty panel. Nothing caught it because no test ever
        clicked that entry — the browser suite only visited four of the eighteen
        sections. Both panels belong here, next to the other per-tool configuration.
      */}
      {activeSection === 'config' && (
        <>
          <section className="settings-section settings-section--wide hook-settings">
            <div className="section-title hook-settings__title">
              <div><span className="eyebrow">Claude</span><h2>Claude Stop Hook</h2></div>
              <Webhook size={20} />
            </div>
            <div className="hook-status-list" aria-label={t("Claude Stop Hook 状态")}>
              <span className={`state-chip ${props.hookStatus.manualReviewRequired ? 'state-chip--error' : props.hookStatus.installed ? 'state-chip--ready' : 'state-chip--limited'}`}>
                <span className="state-chip__dot" />
                {props.hookStatus.manualReviewRequired ? t("需人工检查") : props.hookStatus.installed ? t("已安装") : t("未安装")}
              </span>
              <span className={`state-chip ${props.hookStatus.enabled ? 'state-chip--ready' : 'state-chip--limited'}`}>
                <span className="state-chip__dot" />
                {props.hookStatus.enabled ? t("已启用") : t("未启用")}
              </span>
              {props.hookStatus.restartRequired && <span className="state-chip state-chip--waiting"><span className="state-chip__dot" />{t("需重启 Claude")}</span>}
            </div>
            <div className="hook-settings__body">
              <div>
                <div className="field-grid hook-settings__fields">
                  <label><span>{t("Lease 有效期（毫秒）")}</span><input aria-label={t("Lease 有效期（毫秒）")} type="number" min="1" value={draft.tools.claude.stopHook.leaseTtlMs} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, claude: { ...draft.tools.claude, stopHook: { ...draft.tools.claude.stopHook, leaseTtlMs: clampNumber(event.target.value, 1) } } } })} /></label>
                  <label><span>{t("命令超时（毫秒）")}</span><input aria-label={t("命令超时（毫秒）")} type="number" min="1" value={draft.tools.claude.stopHook.commandTimeoutMs} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, claude: { ...draft.tools.claude, stopHook: { ...draft.tools.claude.stopHook, commandTimeoutMs: clampNumber(event.target.value, 1) } } } })} /></label>
                </div>
                <div className="switch-row"><div><strong>{t("启用 Stop Hook 续写")}</strong><span>{t("仅对唯一关联且已静默的 Claude 会话创建一次性 Lease")}</span></div><label className="switch"><input aria-label={t("启用 Claude Stop Hook")} type="checkbox" checked={draft.tools.claude.stopHook.enabled} onChange={(event) => setDraft({ ...draft, tools: { ...draft.tools, claude: { ...draft.tools.claude, stopHook: { ...draft.tools.claude.stopHook, enabled: event.target.checked } } } })} /><span /></label></div>
              </div>
              <div className="hook-settings__control">
                <p className="hook-disclosure"><CircleAlert size={17} /><span>{t('安装会修改 {path}。已打开的 Claude 会话需要重启后才能加载 Hook。', { path: '~/.claude/settings.json' })}</span></p>
                {props.hookStatus.lastError && <p className="hook-error" role="alert">{props.hookStatus.lastError}</p>}
                <div className="hook-actions">
                  {!props.hookStatus.installed && !props.hookStatus.manualReviewRequired && <button className="button button--secondary" type="button" onClick={() => void props.onInstallClaudeHook()} disabled={props.saving}><Plug size={17} />{t("安装 Stop Hook")}</button>}
                  {props.hookStatus.enabled && <button className="button button--stop" type="button" onClick={() => void props.onDisableClaudeHook()} disabled={props.saving}><Power size={17} />{t("停用 Stop Hook")}</button>}
                  {(props.hookStatus.installed || props.hookStatus.manualReviewRequired) && <button className="button button--danger" type="button" onClick={() => void props.onUninstallClaudeHook()} disabled={props.saving}><Unplug size={17} />{t("卸载 Stop Hook")}</button>}
                </div>
              </div>
            </div>
          </section>
          <CodexEndpointsPanel profiles={props.profiles} onApply={props.onApplyProfile} applying={props.applyingProfile} />
          {saveBar}
        </>
      )}
      {activeSection === 'notifications' && <NotificationsSection onChange={props.onNotificationsChange} />}
      {activeSection === 'import' && (
        <ImportSection onImportTheme={props.onImportThemeText} onImportConfig={props.onImportConfigText} config={props.config} />
      )}
      {activeSection === 'profile' && (
        <ProfileSection onDisplayNameChange={props.onDisplayNameChange} />
      )}
      {activeSection === 'pet' && <PetSection pet={props.pet} onChange={props.onPetChange} />}
      {activeSection === 'shortcuts' && <ShortcutsSection />}
      {activeSection === 'account' && (
        <>
          <AccountSection connected={props.connected} running={props.running} version={APP_VERSION} />
          <EnvironmentPanel
            environment={props.environment}
            refreshing={props.environmentRefreshing}
            upgrading={props.environmentUpgrading}
            onRefresh={props.onRefreshEnvironment}
            onUpgrade={props.onUpgradeTool}
            onUpgradeAll={props.onUpgradeAllTools}
          />
        </>
      )}
      {activeSection === 'startup' && (
        <StartupSection
          startupInstalled={props.startupInstalled}
          onToggleStartup={props.onToggleStartup}
          busy={props.saving || props.desktopSettingsBusy}
          closeToTray={props.closeToTray}
          onCloseToTrayChange={props.onCloseToTrayChange}
          preferredTerminal={props.preferredTerminal}
          onPreferredTerminalChange={props.onPreferredTerminalChange}
          desktopBridgeAvailable={props.desktopBridgeAvailable}
          platform={props.desktopPlatform}
          error={props.desktopSettingsError}
        />
      )}
      {activeSection === 'computer-control' && (
        <ComputerControlSection
          allowReveal={props.allowReveal}
          onAllowRevealChange={props.onAllowRevealChange}
        />
      )}
      {activeSection === 'plugins' && <PluginsSection />}
      {activeSection === 'browser' && (
        <BrowserSection theme={props.activeTheme} origin={props.origin} />
      )}
      </div>
    </form>
  );
}

export interface AppProps { api?: WatchdogApi; agentsApi?: AgentApi }

/** The four menu labels, in the order the reference layout presents them. */
const MENU_LABELS = ['文件', '编辑', '视图', '帮助'] as const;
type MenuLabel = (typeof MENU_LABELS)[number];

/** One row of a dropdown. `role` items without a click are display-only. */
interface MenuEntry {
  readonly label: string;
  /** Items the desktop bridge performs; absent means "renderer action". */
  readonly action?: keyof DesktopShellBridge | 'back-to-app' | 'hide' | 'about';
  /** A zoom step for the `zoom` action. */
  readonly delta?: number;
  readonly url?: string;
  /** True when the item needs a live desktop bridge to do anything. */
  readonly needsBridge?: boolean;
  readonly disabled?: boolean;
  readonly shortcut?: string;
}

const MENU_ITEMS: Record<MenuLabel, readonly (MenuEntry | 'separator')[]> = {
  文件: [
    { label: '返回应用', action: 'back-to-app' },
    'separator',
    // The desktop app hides to the tray; a plain browser has nothing to hide
    // into, so the item is disabled there rather than doing nothing silently.
    { label: '隐藏到托盘', action: 'hide', needsBridge: true },
  ],
  编辑: [
    // The desktop shell performs these on the window's web contents. A plain browser has the OS's own
    // shortcuts for them and no way to reach a window's editing surface, so each item is disabled there with
    // the same reason the view items use — the alternative was six items that responded to a click by doing
    // nothing at all, which is what they did in the desktop app too.
    { label: '撤销', action: 'undo', needsBridge: true, shortcut: 'Ctrl+Z' },
    { label: '重做', action: 'redo', needsBridge: true, shortcut: 'Ctrl+Y' },
    'separator',
    { label: '剪切', action: 'cut', needsBridge: true, shortcut: 'Ctrl+X' },
    { label: '复制', action: 'copy', needsBridge: true, shortcut: 'Ctrl+C' },
    { label: '粘贴', action: 'paste', needsBridge: true, shortcut: 'Ctrl+V' },
    { label: '全选', action: 'selectAll', needsBridge: true, shortcut: 'Ctrl+A' },
  ],
  视图: [
    { label: '重新加载', action: 'reload', needsBridge: true, shortcut: 'Ctrl+R' },
    'separator',
    { label: '实际大小', action: 'zoom', delta: 0, needsBridge: true, shortcut: 'Ctrl+0' },
    { label: '放大', action: 'zoom', delta: 1, needsBridge: true, shortcut: 'Ctrl+=' },
    { label: '缩小', action: 'zoom', delta: -1, needsBridge: true, shortcut: 'Ctrl+-' },
    'separator',
    { label: '切换全屏', action: 'toggleFullScreen', needsBridge: true, shortcut: 'F11' },
  ],
  帮助: [
    { label: '项目主页', url: 'https://github.com/dieWehmut/Selbstlauf' },
    { label: '关于 Selbstlauf', action: 'about' },
  ],
};

/**
 * The renderer's own title bar row.
 *
 * With `titleBarStyle: 'hidden'` the OS paints nothing but the window buttons,
 * so this row *is* the title bar: the whole row is a drag region and every
 * interactive child opts back out with `no-drag`, otherwise clicks would be
 * swallowed as window drags. The right edge reserves the gutter the native
 * minimise / maximise-restore / close buttons occupy (see the CSS comment).
 */
function TitleBar(props: {
  readonly sidebarCompact: boolean;
  readonly onToggleSidebar: () => void;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  readonly bridge: DesktopBridge | null;
  readonly onAction: (entry: MenuEntry) => void;
}) {
  const { t, locale } = useI18n();
  const [openMenu, setOpenMenu] = useState<MenuLabel | null>(null);
  /** The open dropdown, so a press inside it is not mistaken for a press outside. */
  const menuRef = useRef<HTMLDivElement | null>(null);
  const shell = props.bridge?.shell;

  // Clicking anywhere outside, or pressing Escape, dismisses the open dropdown.
  useEffect(() => {
    if (openMenu === null) return undefined;
    const close = (event: MouseEvent) => {
      // Ignore presses that start inside the menu. Closing on the mousedown of the
      // item itself unmounted the menu before the item's onClick could run, so a
      // mouse click on 返回应用 or 隐藏到托盘 did nothing at all — the menu just
      // vanished. Keyboard activation worked, which is why the unit tests passed:
      // `fireEvent.click` fires no mousedown.
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    // `mousedown` rather than `click`, so the menu closes on the press that
    // starts outside it instead of waiting for a full click.
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  const open = openMenu === null ? null : MENU_ITEMS[openMenu];

  return (
    <div className="titlebar" role="toolbar" aria-label={t("窗口工具栏")}>
      <button
        className="titlebar__button"
        type="button"
        title={props.sidebarCompact ? t("展开侧栏") : t("收起侧栏")}
        aria-label={props.sidebarCompact ? t("展开侧栏") : t("收起侧栏")}
        onClick={props.onToggleSidebar}
      >
        {props.sidebarCompact ? <PanelLeftOpen size={17} /> : <PanelLeft size={17} />}
      </button>
      <button
        className="titlebar__button"
        type="button"
        title={t("后退")}
        aria-label={t("后退")}
        disabled={!props.canGoBack}
        aria-disabled={!props.canGoBack}
        onClick={props.onBack}
      >
        <ArrowLeft size={17} />
      </button>
      <button
        className="titlebar__button"
        type="button"
        title={t("前进")}
        aria-label={t("前进")}
        disabled={!props.canGoForward}
        aria-disabled={!props.canGoForward}
        onClick={props.onForward}
      >
        <ArrowRight size={17} />
      </button>

      <div className="titlebar__menus">
        {MENU_LABELS.map((label) => {
          const entries = MENU_ITEMS[label];
          return (
            <div className="titlebar__menu" key={label}>
              <button
                className={openMenu === label ? 'titlebar__menu-button is-open' : 'titlebar__menu-button'}
                type="button"
                aria-haspopup="menu"
                aria-expanded={openMenu === label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setOpenMenu((current) => (current === label ? null : label))}
              >
                {t(label)}
              </button>
              {openMenu === label && (
                <div className="titlebar__dropdown" role="menu" aria-label={t(label)} ref={menuRef}>
                  {entries.map((entry, index) => {
                    if (entry === 'separator') {
                      return <div className="titlebar__separator" role="separator" key={`sep-${index}`} />;
                    }
                    // An item that needs the desktop bridge is disabled — with a
                    // real accessible disabled state — in a plain browser.
                    const needsBridge = entry.needsBridge === true && shell === undefined;
                    const disabled = entry.disabled === true || needsBridge;
                    return (
                      <button
                        className="titlebar__item"
                        type="button"
                        role="menuitem"
                        key={entry.label}
                        disabled={disabled}
                        aria-disabled={disabled}
                        title={needsBridge ? t("仅在桌面应用中可用") : undefined}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setOpenMenu(null);
                          props.onAction(entry);
                        }}
                      >
                        <span>{t(entry.label)}</span>
                        {entry.shortcut && <span className="titlebar__shortcut">{entry.shortcut}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function App({ api: suppliedApi, agentsApi: suppliedAgentsApi }: AppProps) {
  const { t, locale } = useI18n();
  const api = useMemo(() => suppliedApi ?? createApi(), [suppliedApi]);
  const agentsApi = useMemo(() => suppliedAgentsApi ?? createAgentApi(), [suppliedAgentsApi]);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const requestedAgentId = new URLSearchParams(window.location.search).get('agent');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => requestedAgentId ?? localStorage.getItem('selbstlauf-selected-agent'));
  const staticDemo = import.meta.env.VITE_STATIC_DEMO === 'true';
  // Read once: the bridge is installed by the preload before the page script
  // runs, so it never appears or disappears during a session.
  const bridge = useMemo(() => desktopBridge(), []);
  const [page, setPage] = useState<Page>(requestedAgentId !== null || sessionStorage.getItem('selbstlauf-agent-page') === 'true' ? 'agents' : 'overview');
  const [agentWindowsMounted, setAgentWindowsMounted] = useState(requestedAgentId !== null);
  useEffect(() => {
    if (page === 'agents') { setAgentWindowsMounted(true); sessionStorage.setItem('selbstlauf-agent-page', 'true'); }
    else sessionStorage.removeItem('selbstlauf-agent-page');
  }, [page]);
  /**
   * In-app page history for the title bar's back/forward arrows.
   *
   * The app is a single route in a loopback page, so `window.history` has
   * nothing to walk; the two stacks are the whole navigation model. `back`
   * holds visited pages oldest-first and `forward` is the redo stack.
   */
  const [history, setHistory] = useState<{ back: Page[]; forward: Page[] }>({ back: [], forward: [] });

  /**
   * Change page and record it, so 后退 can return here.
   *
   * Every in-app navigation goes through this rather than `setPage`, otherwise
   * a jump from the sidebar would be invisible to the arrows.
   */
  const navigate = (next: Page) => {
    setPage((current) => {
      if (current === next) return current;
      setHistory((stack) => ({ back: [...stack.back, current], forward: [] }));
      return next;
    });
  };

  const goBack = () => {
    setHistory((stack) => {
      const previous = stack.back.at(-1);
      if (previous === undefined) return stack;
      setPage(previous);
      return { back: stack.back.slice(0, -1), forward: [page, ...stack.forward] };
    });
  };

  const goForward = () => {
    setHistory((stack) => {
      const [next, ...rest] = stack.forward;
      if (next === undefined) return stack;
      setPage(next);
      return { back: [...stack.back, page], forward: rest };
    });
  };

  /** Open the settings page on a named section (used by the rail and the tray). */
  const openSettings = (section?: string) => {
    if (section !== undefined && SETTINGS_SECTION_IDS.includes(section)) setSettingsSection(section);
    navigate('settings');
    setSidebarOpen(false);
  };
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem('watchdog-theme'); } catch { /* Unavailable storage uses the default theme. */ }
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark';
  });
  // Per-scheme palette overrides, so a custom dark palette survives a switch
  // to light and back.
  const [paletteOverrides, setPaletteOverrides] = useState<Partial<Record<Theme, ThemePalette>>>(() => loadPaletteOverrides());
  const [prefersLight, setPrefersLight] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(THEME_QUERY).matches);
  const theme = resolveTheme(themePreference, prefersLight);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  /** The session shown on the 进程详情 page, chosen from the sidebar list. */
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  /** The sidebar list's own filter, kept out of the page's state. */
  const [processFilter, setProcessFilter] = useState('');
  /** The bottom bar's menu, which opens upwards out of the sidebar footer. */
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  /** The open menu, so a press inside it is not mistaken for a press outside. */
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  /** Which settings rail entry is in view; the tray can open one by name. */
  const [settingsSection, setSettingsSection] = useState<string>(DEFAULT_SETTINGS_SECTION);
  /** The name the sidebar brand block shows once 个人资料 sets one. */
  const [displayName, setDisplayName] = useState(() => readPref<ProfilePref>(PREF_KEYS.profile, PROFILE_DEFAULTS, isProfilePref).displayName);
  /**
   * The pinned sessions, in pin order.
   *
   * Held as a preference rather than in the session list so a pin survives the list being
   * rebuilt on every poll, and survives a restart.
   */
  const [pinnedIds, setPinnedIds] = useState<readonly string[]>(
    () => readPref(PREF_KEYS.pinnedSessions, PINNED_SESSIONS_DEFAULTS, isPinnedSessionsPref).ids,
  );
  const togglePinned = (session: SessionView) => {
    setPinnedIds((current) => {
      const next = togglePinnedId(current, session.id);
      writePref(PREF_KEYS.pinnedSessions, { ids: next });
      return next;
    });
  };
  /** 电脑操控: whether the process table may reveal a session's window. */
  const [allowReveal, setAllowReveal] = useState(() => readPref(PREF_KEYS.computerControl, { allowReveal: true }, isRevealPref).allowReveal);
  /** Desktop-shell preferences, mirrored from the main process when available. */
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null);
  const [preferredTerminal, setPreferredTerminal] = useState<string | null>(null);
  const [desktopSettingsReady, setDesktopSettingsReady] = useState(false);
  const [desktopSettingsBusy, setDesktopSettingsBusy] = useState(false);
  const [desktopSettingsError, setDesktopSettingsError] = useState<LocalizedMessage | null>(null);
  const [preferenceError, setPreferenceError] = useState<LocalizedMessage | null>(null);
  /**
   * The window-preview request, or null outside the desktop shell.
   *
   * Bound once here rather than read at the call site, so the detail page receives a stable
   * function and its effect does not re-run — and therefore does not re-capture the desktop —
   * on every render.
   */
  const previewWindow = useMemo(() => {
    const request = bridge?.shell?.windowPreview;
    return typeof request === 'function'
      ? (sessionId: string) => request.call(bridge!.shell, sessionId)
      : null;
  }, [bridge]);

  /**
   * Typing into a window, bound the same way and for the same reason.
   *
   * Derived once so the panel's callback identity is stable across renders; a new function each render would
   * invalidate the panel's own memoised state on every poll, which polls every two seconds.
   */
  const typeIntoWindow = useMemo(() => {
    const request = bridge?.shell?.windowType;
    return typeof request === 'function'
      ? (sessionId: string, text: string, submit: boolean) => request.call(bridge!.shell, sessionId, text, submit)
      : null;
  }, [bridge]);
  const [health, setHealth] = useState<HealthView>({ ok: false, running: false, dryRun: true, lastPollAtMs: null });
  const [startupInstalled, setStartupInstalled] = useState(false);
  const [hookStatus, setHookStatus] = useState<ClaudeHookStatusView>(fallbackHookStatus);
  const [codexProfiles, setCodexProfiles] = useState<CodexProfilesView | null>(null);
  const profileReadSequence = useRef(0);
  const profileWriteSequence = useRef(0);
  const [environment, setEnvironment] = useState<EnvironmentView | null>(null);
  const [environmentRefreshing, setEnvironmentRefreshing] = useState(false);
  // 'all' while a bulk run is in flight, otherwise the tool id, otherwise null.
  const [environmentUpgrading, setEnvironmentUpgrading] = useState<string | null>(null);
  const [applyingProfile, setApplyingProfile] = useState(false);
  const [config, setConfig] = useState(fallbackConfig);
  const [sessions, setSessions] = useState<SessionView[]>(staticDemo ? fallbackSessions : []);
  const [events, setEvents] = useState<AuditEvent[]>(staticDemo ? fallbackEvents : []);
  const auditReadSequence = useRef(0);
  const auditStreamSequence = useRef(0);
  const auditStreamEvents = useRef(new Map<string, { event: AuditEvent; sequence: number }>());
  const [connected, setConnected] = useState(false);
  /**
   * Whether the console is connected to a service this build can talk to.
   *
   * The static demo answers from memory, so its `refresh()` always succeeds and `connected` becomes true — which
   * made every surface report a live console (实时同步, 服务在线, a green online light) for a page with no service
   * at all, and left the app's own `staticDemo` wording as unreachable branches in the one build that needs it.
   * The demo shows sample data on purpose; saying it is connected is not part of that.
   */
  const live = connected && !staticDemo;
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The notice strip's message and its tone.
   *
   * The tone is what the 通知 switches filter on: without it, `面板内通知`, `操作成功时提示` and
   * `出现错误时提示` had nothing to consult and were inert (see `setNotice`).
   */
  const [notice, setNoticeState] = useState<{ readonly text: LocalizedMessage; readonly tone: 'info' | 'error' } | null>(null);
  /** Show a notice. The default tone is a confirmation; failures pass `'error'`. */
  const setNotice = (text: LocalizedMessage | null, tone: 'info' | 'error' = 'info') =>
    setNoticeState(text === null ? null : { text, tone });

  // Each scheme keeps its own palette, so a preview card shows that scheme's
  // colours rather than whatever scheme happens to be active.
  const palettes: Record<Theme, ThemePalette> = {
    light: paletteOverrides.light ?? DEFAULT_PALETTES.light,
    dark: paletteOverrides.dark ?? DEFAULT_PALETTES.dark,
  };
  const palette = palettes[theme];
  const paletteCustomized = paletteOverrides[theme] !== undefined;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /**
   * Mark the document when the page really is inside the desktop shell.
   *
   * The right-hand gutter for the native window buttons is only reserved then;
   * in a plain browser the title bar row uses ordinary padding instead of
   * leaving a dead 148px strip under nothing.
   */
  useEffect(() => {
    if (bridge === null) return undefined;
    document.documentElement.dataset.shell = 'desktop';
    return () => {
      delete document.documentElement.dataset.shell;
    };
  }, [bridge]);

  /**
   * Follow commands from the native menu bar and the tray.
   *
   * The main process sends these over the bridge; the same two commands arrive
   * from `文件 -> 返回应用` and from the tray's settings entries, so the
   * renderer has one place that knows what "go to the app" and "open settings"
   * mean. An unknown section falls back to simply opening the settings page.
   */
  useEffect(() => {
    if (bridge?.onCommand === undefined) return undefined;
    return bridge.onCommand((payload) => {
      if (payload.command === 'back-to-app') {
        navigate('overview');
        setSidebarOpen(false);
        return;
      }
      if (payload.command === 'open-settings') {
        openSettings(payload.section);
      }
    });
  }, [bridge]);

  /**
   * Mirror the desktop shell's own preferences.
   *
   * `closeToTray` and `preferredTerminal` live in the main process because they
   * drive the window lifecycle, so they are read once and written back through
   * the bridge. In a plain browser the bridge is absent and both stay null, which
   * is exactly what makes the matching rows render disabled instead of lying.
   */
  useEffect(() => {
    const settings = bridge?.settings;
    if (typeof settings?.get !== 'function' || typeof settings.set !== 'function') return undefined;
    let active = true;
    const apply = (current: { closeToTray?: boolean; preferredTerminal?: string | null }) => {
      if (!active) return;
      if (typeof current.closeToTray !== 'boolean') {
        setDesktopSettingsError('桌面应用未提供可用的窗口设置');
        return;
      }
      setCloseToTray(current.closeToTray);
      setPreferredTerminal(current.preferredTerminal ?? null);
      setDesktopSettingsReady(true);
      setDesktopSettingsError(null);
    };
    const unsubscribe = settings.onChange?.(apply);
    void (async () => {
      try {
        const current = await settings.get();
        apply(current);
      } catch (error) {
        if (active) setDesktopSettingsError(message('读取桌面设置失败：{detail}', { detail: error instanceof Error ? error.message : String(error) }));
      }
    })();
    return () => { active = false; unsubscribe?.(); };
  }, [bridge]);

  const changeDesktopSettings = async (patch: { closeToTray?: boolean; preferredTerminal?: string }) => {
    if (!desktopSettingsReady || desktopSettingsBusy || bridge?.settings === undefined) return;
    setDesktopSettingsBusy(true);
    setDesktopSettingsError(null);
    try {
      await bridge.settings.set(patch);
      if (patch.closeToTray !== undefined) setCloseToTray(patch.closeToTray);
      if (patch.preferredTerminal !== undefined) setPreferredTerminal(patch.preferredTerminal);
    } catch (error) {
      setDesktopSettingsError(message('保存桌面设置失败：{detail}', { detail: error instanceof Error ? error.message : String(error) }));
    } finally { setDesktopSettingsBusy(false); }
  };

  const changeCloseToTray = (value: boolean) => { void changeDesktopSettings({ closeToTray: value }); };
  const changePreferredTerminal = (value: string) => { void changeDesktopSettings({ preferredTerminal: value }); };

  const changeAllowReveal = (allowed: boolean) => {
    if (!persistPreference(PREF_KEYS.computerControl, { allowReveal: allowed })) return;
    setAllowReveal(allowed);
  };

  const persistPreference = (key: string, value: unknown): boolean => {
    if (!writePref(key, value)) {
      setPreferenceError('保存失败：浏览器存储不可用或空间不足，请释放空间后重试');
      return false;
    }
    setPreferenceError(null);
    return true;
  };

  const openSessionTerminal = typeof bridge?.shell?.openTerminal === 'function'
    ? async (session: SessionView) => {
      if (!allowReveal || !session.alive) return;
      setBusy(session.id);
      try {
        const result = await bridge.shell!.openTerminal!(session.id);
        if (!result.ok) throw new Error(result.reason ?? '终端无法打开');
        setNotice(result.terminal ? message('已打开终端：{terminal}', { terminal: result.terminal }) : '已打开终端');
      } catch (error) { setNotice(error instanceof Error ? error.message : String(error), 'error'); }
      finally { setBusy(null); }
    } : undefined;

  /**
   * Keyboard shortcuts, exactly the set the 键盘快捷键 section documents.
   *
   * Ctrl+1..3 switch page. They are ignored while a text field has focus, so the
   * bindings cannot steal a typing or IME shortcut. Adding a binding here means
   * adding the matching row to `SHORTCUTS` in `./settings/sections`.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const shortcutPages: Record<string, Page> = {
        '1': 'overview',
        '2': 'timeline',
        '3': 'settings',
        // The bottom bar's menu advertises Ctrl+, beside 设置, the conventional binding
        // for preferences. It was shown without ever being bound, so the hint promised
        // something the app did not do.
        ',': 'settings',
      };
      const next = shortcutPages[event.key];
      if (next === undefined) return;
      event.preventDefault();
      navigate(next);
      setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [page]);

  // The bottom bar's menu closes the way the title bar's dropdowns do: on Escape, and
  // on the press that starts outside it rather than on a completed click.
  useEffect(() => {
    if (!accountMenuOpen) return undefined;
    const close = (event: MouseEvent) => {
      // Same reason as the title bar's dropdowns: closing on the mousedown of the
      // item itself would unmount the menu before its onClick could run.
      if (event.target instanceof Node && accountMenuRef.current?.contains(event.target)) return;
      setAccountMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [accountMenuOpen]);

  /**
   * Notification preferences.
   *
   * Held in state and pushed by the 通知 section, rather than re-read on every render. Re-reading only
   * appeared to work because the app polls, so the timeline limit depended on some unrelated state
   * change happening — and the notice strip, which the old comment here claimed followed these values,
   * did not consult them at all.
   */
  const [notifications, setNotifications] = useState(
    () => readPref(PREF_KEYS.notifications, NOTIFICATIONS_DEFAULTS, isNotificationsPref),
  );
  const visibleEvents = useMemo(() => events.slice(0, notifications.timelineLimit), [events, notifications.timelineLimit]);

  /**
   * The layout density, which the compact rules in `sections.css` key off `data-density` on the root.
   *
   * The preference, its validator, its default and those three rules had all been written, and nothing
   * ever set the attribute — so the rules could never match and there was no way to choose.
   */
  const [personalization, setPersonalization] = useState(
    () => readPref(PREF_KEYS.personalization, PERSONALIZATION_DEFAULTS, isPersonalizationPref),
  );
  useEffect(() => {
    document.documentElement.dataset.density = personalization.density;
  }, [personalization.density]);
  const changeDensity = (density: Density) => {
    const next = { ...personalization, density };
    if (!persistPreference(PREF_KEYS.personalization, next)) return;
    setPersonalization(next);
  };

  /**
   * The desktop pet, which the shell draws rather than the settings section.
   *
   * The 宠物 section used to render the ornament itself, so it existed only while that section was open —
   * invisible while actually using the app, and its pulse could only fire if the session count changed
   * during the visit. Its stylesheet is `position: fixed` at the window's bottom-right, which is where the
   * shell now puts it, on every page.
   */
  const [pet, setPet] = useState(() => readPref(PREF_KEYS.pet, PET_DEFAULTS, isPetPref));
  const changePet = (next: PetPref) => {
    if (!persistPreference(PREF_KEYS.pet, next)) return;
    setPet(next);
  };

  useEffect(() => {
    const unsubscribe = [
      subscribePref(PREF_KEYS.notifications, () => setNotifications(readPref(PREF_KEYS.notifications, NOTIFICATIONS_DEFAULTS, isNotificationsPref))),
      subscribePref(PREF_KEYS.profile, () => setDisplayName(readPref(PREF_KEYS.profile, PROFILE_DEFAULTS, isProfilePref).displayName)),
      subscribePref(PREF_KEYS.personalization, () => setPersonalization(readPref(PREF_KEYS.personalization, PERSONALIZATION_DEFAULTS, isPersonalizationPref))),
      subscribePref(PREF_KEYS.pet, () => setPet(readPref(PREF_KEYS.pet, PET_DEFAULTS, isPetPref))),
      subscribePref(PREF_KEYS.computerControl, () => setAllowReveal(readPref(PREF_KEYS.computerControl, { allowReveal: true }, isRevealPref).allowReveal)),
      subscribePref(PREF_KEYS.pinnedSessions, () => setPinnedIds(readPref(PREF_KEYS.pinnedSessions, PINNED_SESSIONS_DEFAULTS, isPinnedSessionsPref).ids)),
      subscribePref('watchdog-theme', () => {
        let stored: string | null = null;
        try { stored = localStorage.getItem('watchdog-theme'); } catch { /* Default below. */ }
        setThemePreference(stored === 'light' || stored === 'system' ? stored : 'dark');
      }),
      subscribePref(PALETTE_STORAGE_KEY, () => setPaletteOverrides(loadPaletteOverrides())),
    ];
    return () => unsubscribe.forEach((dispose) => dispose());
  }, []);

  /**
   * Run a title bar menu item.
   *
   * Items that need the desktop bridge are already disabled without it, so this
   * only ever calls into `shell` when it exists.
   */
  const runMenuAction = (entry: MenuEntry) => {
    const shell = bridge?.shell;
    if (entry.action === 'back-to-app') {
      // Back to the overview and out of the mobile drawer, so the page the
      // person lands on is the one they can actually see.
      navigate('overview');
      setSidebarOpen(false);
      return;
    }
    if (entry.action === 'about') {
      navigate('settings');
      setSidebarOpen(false);
      return;
    }
    if (entry.action === 'hide') {
      // "隐藏到托盘" is the same gesture as the window's own close button: the
      // desktop shell turns `close` into a hide (see the main process lifecycle),
      // which is why this never calls the bridge's quit action — the tray owns
      // the only real quit. In a plain browser the item is disabled anyway.
      window.close();
      return;
    }
    if (entry.url !== undefined) {
      // External links go through the shell when there is one, so they open in
      // the OS browser rather than navigating the app's own window.
      if (shell?.openExternal !== undefined) void shell.openExternal(entry.url);
      else window.open(entry.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (entry.action === 'zoom') shell?.zoom?.(entry.delta ?? 0);
    if (entry.action === 'reload') shell?.reload?.();
    if (entry.action === 'toggleFullScreen') shell?.toggleFullScreen?.();
    if (entry.action === 'quit') shell?.quit?.();
    if (
      entry.action === 'undo' || entry.action === 'redo' || entry.action === 'cut'
      || entry.action === 'copy' || entry.action === 'paste' || entry.action === 'selectAll'
    ) {
      // The 编辑 commands edit the window's own contents, which only the shell can reach.
      shell?.[entry.action]?.();
    }
  };

  /**
   * Paint the chosen palette onto the document root.
   *
   * Inline custom properties win over the [data-theme] blocks, so one set of
   * values covers everything the stylesheet already derives from them.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--accent', palette.accent);
    root.style.setProperty('--bg', palette.background);
    root.style.setProperty('--text', palette.foreground);

    /**
     * The browser's own chrome follows the page too.
     *
     * `theme-color` tints a tab strip or an address bar. It shipped as a static `#000000` in
     * index.html and nothing moved it, so a light-theme user's browser stayed dark however long the
     * app ran, and a custom background never reached it at all. `theme-boot.js` sets it before the
     * bundle for a saved palette; this keeps it right for everything else, including a live change.
     */
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.background);

    /**
     * The surfaces, derived once and shared with the appearance previews.
     *
     * The slider drives how far they sit from the background, and the direction is the palette's
     * rather than the theme's (`paletteSurfaces` in src/theme/palette.ts documents both, including
     * the collapse that a theme-keyed branch caused for a light background chosen on the dark theme).
     * The previews call the same function, so a swatch cannot show a colour the app does not paint:
     * before they were shared, the card's own formula put its rail at `rgb(23, 24, 24)` against a
     * painted `#0d0d0d`, its sheet at `rgb(37, 38, 38)` against `#0f0f0f`, and moving the contrast
     * slider did not move the swatches at all.
     */
    const painted = paletteSurfaces(palette);
    root.style.setProperty('--panel', painted.panel);
    root.style.setProperty('--panel-soft', painted.rail);
    root.style.setProperty('--panel-raised', painted.raised);

    /**
     * The text colours, solved against the surfaces above rather than trusted as literals.
     *
     * Both are used as text: `--accent-strong` is the active rail entry and the prompt chips, and
     * `--green`/`--red`/`--blue` are the status words ("writable", "failed", an editor window).
     * Their values are the app's own — they are not the user's palette — but they have to be legible
     * on whatever background the user chose, which a literal cannot promise. Measured with `#eef2f1`
     * chosen on the dark theme: green status text at **1.81:1** on its own near-white chip and
     * `--accent-strong` at **1.36:1**, both below AA.
     *
     * `readableText` returns each colour unchanged when it already clears the bar, which is the case
     * for both built-in palettes: no built-in colour moves. The status bar is 4.8 rather than 4.5
     * because a chip paints itself with a 9% wash of the colour it writes, which costs about 0.07:1
     * against a light surface.
     */
    const surfaces = [palette.background, painted.panel, painted.rail, painted.raised];
    const accentStrong = mix(palette.accent, isLight(palette.background) ? '#000000' : '#ffffff', 0.28);
    root.style.setProperty('--accent-strong', readableText(accentStrong, surfaces));
    for (const [name, colour] of Object.entries(STATUS_COLOURS[theme])) {
      root.style.setProperty(`--${name}`, readableText(colour, surfaces, 4.8));
    }

    /**
     * The two line tokens.
     *
     * `--line` is only ever used through its translucent children (`--line-soft` and
     * `--line-whisper`), so nothing paints it directly. `--line-strong` is the opaque
     * one: it draws an icon button's hover border and the scrollbar thumb. It used to
     * be a literal in each theme block, which made it the only colour token a custom
     * palette left behind — every other token followed a user's palette and this one
     * did not — and it left the dark theme painting a blue-grey (`#39464d`) from the
     * palette the pure-black page replaced.
     *
     * A fixed extra step above `--line` keeps the two in order and keeps the slider's
     * slope. Measured against what each is drawn on, before -> after:
     *
     *     dark   #39464d -> #505152   hover border 1.92:1 -> 2.36:1, thumb 1.55:1 -> 1.78:1
     *     light  #bac9c4 -> #a6acad   hover border 1.53:1 -> 2.06:1, thumb 1.25:1 -> 1.51:1
     */
    const line = 0.1 + palette.contrast / 420;
    root.style.setProperty('--line', mix(palette.background, palette.foreground, line));
    root.style.setProperty('--line-strong', mix(palette.background, palette.foreground, line + 0.08));

    const uiType = fontStack(palette.uiType.family);
    const content = palette.contentType.sameAsUi ? uiType : fontStack(palette.contentType.family);
    root.style.setProperty('--ui-font', uiType);
    root.style.setProperty('--content-font', content);
    root.style.setProperty('--ui-weight', String(palette.uiType.weight));
    root.style.setProperty('--content-weight', String(palette.contentType.weight));

    root.dataset.sidebar = palette.translucentSidebar ? 'translucent' : 'solid';
  }, [palette, theme]);

  /**
   * Keep the native window-button strip on the same surface as the title bar.
   *
   * The bar is `--panel-soft`, which the palette effect above derives from the
   * background, contrast and accent. Rather than duplicate that formula (and let
   * the two drift), this reads the colour the browser actually resolved and
   * reports it; the main process repaints the OS strip to match. In a plain
   * browser the bridge is absent and this does nothing.
   */
  useEffect(() => {
    const setOverlay = bridge?.shell?.setTitleBarOverlay;
    if (setOverlay === undefined || typeof document === 'undefined') return;
    const bar = document.querySelector('.titlebar');
    if (bar === null) return;
    const background = window.getComputedStyle(bar).backgroundColor;
    const channels = /rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(background);
    if (channels === null) return;
    const color = `#${[1, 2, 3]
      .map((index) => Number(channels[index]).toString(16).padStart(2, '0'))
      .join('')}`;
    // The glyph colour follows the text token so the buttons stay legible on
    // both the dark and the light palette.
    const foreground = window.getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
    setOverlay({
      color,
      ...(HEX_COLOR.test(foreground) ? { symbolColor: foreground } : {}),
    });
  }, [bridge, palette, theme]);

  const changeThemePreference = (next: ThemePreference) => {
    // The boot script reads this legacy key as a plain string before React mounts.
    try {
      localStorage.setItem('watchdog-theme', next);
      setThemePreference(next);
      setPreferenceError(null);
    } catch { setPreferenceError('保存失败：浏览器存储不可用或空间不足，请释放空间后重试'); }
  };

  // Follow the OS while "system" is selected, and stop listening otherwise.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(THEME_QUERY);
    const apply = () => setPrefersLight(query.matches);
    apply();
    query.addEventListener?.('change', apply);
    return () => query.removeEventListener?.('change', apply);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    if (!sidebarOpen) {
      document.body.style.overflow = '';
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [sidebarOpen]);

  const refresh = async () => {
    const profileRead = ++profileReadSequence.current;
    const profileWrite = profileWriteSequence.current;
    // A snapshot supersedes older snapshots, including an empty/cleared history.
    // SSE events received while it is loading are merged over that snapshot.
    if (api.audit !== undefined) {
      const auditRead = ++auditReadSequence.current;
      const streamAtRead = auditStreamSequence.current;
      void api.audit(TIMELINE_LIMIT_MAX).then((history) => {
        if (auditRead !== auditReadSequence.current) return;
        const duringRead = [...auditStreamEvents.current.values()].filter((entry) => entry.sequence > streamAtRead);
        setEvents(mergeAuditEvents(history, duringRead.map((entry) => entry.event)));
        for (const [id, entry] of auditStreamEvents.current) {
          if (entry.sequence <= streamAtRead) auditStreamEvents.current.delete(id);
        }
      }).catch(() => undefined);
    }
    try {
      const [nextHealth, nextConfig, nextSessions, nextStartup, nextHookStatus, nextCodexProfiles] = await Promise.all([
        api.health(),
        api.config(),
        api.sessions(),
        api.startup(),
        api.claudeHook(),
        api.codexProfiles(),
      ]);
      setHealth(nextHealth);
      setConfig(mergeConfig(nextConfig));
      setSessions(nextSessions);
      setStartupInstalled(nextStartup.installed);
      setHookStatus(nextHookStatus);
      if (profileRead === profileReadSequence.current && profileWrite === profileWriteSequence.current) setCodexProfiles(nextCodexProfiles);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  };

  useEffect(() => {
    if (staticDemo && suppliedApi === undefined) return undefined;
    let active = true;
    let environmentPending = false;
    // npm diagnostics can be slow; they must not hold up monitoring or controls.
    const loadEnvironment = async () => {
      if (environmentPending) return;
      environmentPending = true;
      try {
        const report = await api.environment();
        if (active) setEnvironment(report);
      } catch {
        // Keep the last report and let the next poll retry independently.
      } finally { environmentPending = false; }
    };
    void refresh();
    void loadEnvironment();
    const unsubscribe = api.subscribe((event: WatchdogEvent) => {
      // Keep as many events as 保留最近事件条数 can ask for. This closure is created once, so it cannot read
      // the *current* setting; keeping the ceiling that setting offers is what makes it honest, and
      // `visibleEvents` slices back down to whatever it says.
      if (event.kind === 'audit') {
        auditStreamEvents.current.set(event.event.id, { event: event.event, sequence: ++auditStreamSequence.current });
        if (auditStreamEvents.current.size > TIMELINE_LIMIT_MAX) {
          auditStreamEvents.current.delete(auditStreamEvents.current.keys().next().value!);
        }
        setEvents((current) => mergeAuditEvents(current, [event.event]));
      }
      else void refresh();
    });
    const timer = window.setInterval(() => {
      void refresh();
      void loadEnvironment();
    }, 10_000);
    return () => { active = false; ++auditReadSequence.current; auditStreamEvents.current.clear(); unsubscribe(); window.clearInterval(timer); };
  }, [api, staticDemo]);

  const mutateSession = async (session: SessionView, action: 'pause' | 'inject', prompt?: string): Promise<{ readonly dryRun: boolean }> => {
    setBusy(session.id); setNotice(null);
    let outcome: { readonly dryRun: boolean } = { dryRun: false };
    try {
      // A supplied prompt goes through the same transport as the one-click action; the service
      // accepts any single line and rejects anything it could not carry.
      if (action === 'inject') {
        // A typed prompt is the user's and wins; the one-click path falls back to the 续写插件 list, so
        // the section's promise — that those prompts are what a manual continuation sends — holds.
        const line = prompt ?? pluginPromptLine();
        // Only a supplied prompt adds the second argument, so an empty plugin list calls exactly as
        // before and its callers see an unchanged shape.
        outcome = line === undefined ? await api.inject(session.id) : await api.inject(session.id, line);
      }
      else if (session.paused) await api.resume(session.id);
      else await api.pause(session.id);
      await refresh();
      return outcome;
    } catch (error) {
      setNotice(error instanceof LocalizedError ? error.localized : error instanceof Error ? error.message : '操作失败', 'error');
      // Rethrown so a caller showing its own error — the composer does — is not left believing the
      // send succeeded just because the notice was set.
      if (prompt !== undefined) throw error;
      return outcome;
    } finally { setBusy(null); }
  };

  const focusSession = async (session: SessionView) => {
    // 电脑操控 can switch the reveal action off; the buttons are disabled too, so
    // this is the belt-and-braces half of the same rule.
    if (!allowReveal) {
      setNotice('“打开运行位置”已在 电脑操控 中被关闭');
      return;
    }
    setBusy(session.id); setNotice(null);
    try {
      const result = await api.focus(session.id);
      setNotice(result.focused
        ? message('已打开 {host}', { host: session.host?.label ?? t('运行位置') })
        : message('已置顶 {host}（系统未授予前台焦点）', { host: session.host?.label ?? t('运行位置') }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法打开运行位置', 'error');
    } finally { setBusy(null); }
  };

  /**
   * Re-probe the machine instead of reusing the service's cached scan.
   * The probe shells out to npm, so the button reports its own progress.
   */
  const refreshEnvironment = async () => {
    setEnvironmentRefreshing(true); setNotice(null);
    try {
      setEnvironment(await api.refreshEnvironment());
      setNotice('本地环境已刷新');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '刷新失败', 'error');
    } finally { setEnvironmentRefreshing(false); }
  };
  /**
   * Install one agent CLI, then re-read the report.
   *
   * The panel must show what actually got installed, so the service's fresh
   * scan replaces the optimistic view instead of the button just disappearing.
   */
  const upgradeTool = async (id: string) => {
    setEnvironmentUpgrading(id); setNotice(null);
    try {
      const result = await api.upgradeTool(id);
      const report = await api.environment();
      setEnvironment(report);
      // The card is titled with the tool's label and its button reads 升级 <label>, so the notice uses that name
      // too. The id is only the fallback for a tool the report does not describe.
      const name = report.tools.find((tool) => tool.id === id)?.label ?? id;
      setNotice(result.ok ? message('{tool} 升级完成', { tool: name }) : message('{tool} 升级失败：{detail}', { tool: name, detail: result.error ?? t('未知错误') }), result.ok ? 'info' : 'error');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '升级失败', 'error');
    } finally { setEnvironmentUpgrading(null); }
  };

  const upgradeAllTools = async () => {
    setEnvironmentUpgrading('all'); setNotice(null);
    try {
      const outcome = await api.upgradeAllTools();
      setEnvironment(await api.environment());
      const failed = outcome.results.filter((result) => !result.ok);
      setNotice(failed.length === 0
        ? message('{count} 个工具已升级', { count: outcome.results.length })
        : message('{success} 个成功，{failed} 个失败', { success: outcome.results.length - failed.length, failed: failed.length }), failed.length === 0 ? 'info' : 'error');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '全部升级失败', 'error');
    } finally { setEnvironmentUpgrading(null); }
  };

  /**
   * Change one field of the palette for the scheme in effect.
   *
   * The override belongs to that scheme, so switching to light keeps the
   * custom dark accent where it was set.
   */
  const changePalette = (patch: Partial<ThemePalette>) => {
    const next = { ...paletteOverrides, [theme]: { ...(paletteOverrides[theme] ?? DEFAULT_PALETTES[theme]), ...patch } };
    if (persistPreference(PALETTE_STORAGE_KEY, next)) setPaletteOverrides(next);
  };

  const resetPalette = () => {
    const next = { ...paletteOverrides };
    delete next[theme];
    if (persistPreference(PALETTE_STORAGE_KEY, next)) setPaletteOverrides(next);
  };

  const importTheme = async () => {
    setNotice(null);
    try {
      const text = await navigator.clipboard.readText();
      const parsed = JSON.parse(text) as unknown;
      if (!isThemePalette(parsed)) throw new TypeError('剪贴板里不是有效的主题配置');
      await importThemeText(text);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导入失败', 'error');
    }
  };

  const copyTheme = async () => {
    await navigator.clipboard.writeText(JSON.stringify(palette, null, 2));
    setNotice('主题已复制');
  };

  /**
   * Apply a theme blob the import section read from the clipboard.
   *
   * The section owns reading and parsing; applying it stays here so it uses the
   * same palette-override path as the appearance panel's own import button.
   */
  const importThemeText = async (text: string) => {
    const parsed = JSON.parse(text) as unknown;
    if (!isThemePalette(parsed)) throw new TypeError('剪贴板里不是有效的主题配置');
    const next = { ...paletteOverrides, [theme]: normalizePalette(parsed, DEFAULT_PALETTES[theme]) };
    if (!persistPreference(PALETTE_STORAGE_KEY, next)) throw new Error('浏览器存储不可用或空间不足，主题未保存');
    setPaletteOverrides(next);
    setNotice('主题已导入');
  };

  /** Apply a config blob from the clipboard through the normal save path. */
  const importConfigText = async (text: string) => {
    await applyConfig(JSON.parse(text) as WatchdogConfig);
  };

  /**
   * Save the service config.
   *
   * This used to demand a PIN first when 家长控制 was on. That section is gone — it gated a
   * single switch with a local-only obfuscation that was never a security boundary — so the
   * prompt is gone with it. Leaving it would have been worse than removing it: a profile that
   * still had the preference set would have been asked for a PIN with no section left to
   * change or clear it.
   */
  const applyConfig = async (nextConfig: WatchdogConfig) => {
    setSaving(true); setNotice(null);
    try {
      const saved = await api.updateConfig(nextConfig);
      setConfig(mergeConfig(saved));
      setHookStatus((current) => ({ ...current, enabled: saved.tools.claude.stopHook.enabled }));
      setNotice('配置已保存');
    }
    finally { setSaving(false); }
  };

  const saveConfig = async (nextConfig: WatchdogConfig) => {
    try { await applyConfig(nextConfig); }
    catch (error) { setNotice(error instanceof Error ? error.message : '保存失败', 'error'); }
  };

  const applyCodexProfile = async (fields: CodexProfileEditView[]) => {
    const profileWrite = ++profileWriteSequence.current;
    setApplyingProfile(true); setNotice(null);
    try {
      await api.applyCodexProfile(fields);
      ++profileReadSequence.current;
      const nextProfiles = await api.codexProfiles();
      if (profileWrite === profileWriteSequence.current) setCodexProfiles(nextProfiles);
      setNotice('Codex 端点已切换');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '切换失败', 'error');
      throw error;
    } finally { setApplyingProfile(false); }
  };

  const updateClaudeHook = async (action: 'disable' | 'install' | 'uninstall') => {
    setSaving(true);
    setNotice(null);
    try {
      const status = action === 'install'
        ? await api.installClaudeHook()
        : action === 'uninstall'
          ? await api.uninstallClaudeHook()
          : await api.disableClaudeHook();
      setHookStatus(status);
      if (action === 'disable') {
        setConfig((current) => ({
          ...current,
          tools: {
            ...current.tools,
            claude: {
              ...current.tools.claude,
              stopHook: { ...current.tools.claude.stopHook, enabled: false },
            },
          },
        }));
      }
      if (status.manualReviewRequired) {
        // A hook that needs a person is a problem to report, not a confirmation.
        setNotice(status.lastError ?? 'Stop Hook 需要人工检查', 'error');
      } else if (action === 'install') {
        setNotice(status.restartRequired ? 'Stop Hook 已安装；需重启 Claude' : 'Stop Hook 已安装');
      } else if (action === 'uninstall') {
        setNotice('Stop Hook 已卸载');
      } else {
        setNotice('Stop Hook 已停用并清空待处理 Lease');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Stop Hook 操作失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const uninstall = async () => {
    if (!window.confirm(t('停止并卸载 Continuation Watchdog？'))) return;
    setSaving(true);
    try {
      await api.uninstall();
      setHealth({ ok: false, running: false, dryRun: config.dryRun, lastPollAtMs: null });
      setStartupInstalled(false);
      setNotice(staticDemo ? '演示 Watchdog 已卸载（仅此浏览器）' : '卸载已启动');
    }
    catch (error) { setNotice(error instanceof Error ? error.message : '卸载失败', 'error'); }
    finally { setSaving(false); }
  };

  const install = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await api.install();
      await refresh();
      setNotice(staticDemo ? '演示 Watchdog 已安装（仅此浏览器）' : 'Watchdog 已安装');
    }
    catch (error) { setNotice(error instanceof Error ? error.message : '安装失败', 'error'); }
    finally { setSaving(false); }
  };

  const toggleStartup = async () => {
    setSaving(true);
    setNotice(null);
    try {
      if (startupInstalled) {
        await api.uninstallStartup();
        setStartupInstalled(false);
        setNotice('启动项已移除');
      } else {
        await api.installStartup();
        setStartupInstalled(true);
        setNotice('启动项已安装');
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : '启动项操作失败', 'error'); }
    finally { setSaving(false); }
  };

  const emergencyStop = async () => {
    await stopWatchdog();
  };

  const stopWatchdog = async () => {
    setSaving(true);
    try { await api.stop(); setHealth((current) => ({ ...current, running: false })); setNotice('Watchdog 已停止'); }
    catch (error) { setNotice(error instanceof Error ? error.message : '停止失败', 'error'); }
    finally { setSaving(false); }
  };

  const startWatchdog = async () => {
    setSaving(true);
    try { await api.start(); setHealth((current) => ({ ...current, ok: true, running: true })); setNotice('Watchdog 已启动'); }
    catch (error) { setNotice(error instanceof Error ? error.message : '启动失败', 'error'); }
    finally { setSaving(false); }
  };

  const toggleWatchdog = () => health.running ? stopWatchdog() : startWatchdog();

  /**
   * The sessions that are actually running.
   *
   * The service keeps a session after its process exits, with `alive: false`, because the audit trail
   * refers to it. Those are history, not things to act on: listing them filled the sidebar with rows for
   * processes that had been gone for hours — measured, 25 rows for 5 live processes, 20 of them dead — and
   * every action on one could only fail. The events page is where the audit history belongs, so the
   * process views read this list instead.
   */
  const liveSessions = useMemo(() => sessions.filter((session) => session.alive), [sessions]);

  /**
   * The pet bounces briefly whenever the number of live sessions changes.
   *
   * A count that arrives from nothing is the app loading, not a change to signal: the first sessions of a
   * launch used to set the pet bouncing before a person had looked at it. Only a change *from* a count the
   * user was already looking at is a signal.
   */
  const [petPulsing, setPetPulsing] = useState(false);
  const previousSessionCount = useRef<number | null>(null);
  useEffect(() => {
    const previous = previousSessionCount.current;
    previousSessionCount.current = liveSessions.length;
    if (previous === null || previous === 0) return undefined;
    setPetPulsing(true);
    const timer = window.setTimeout(() => setPetPulsing(false), 600);
    return () => window.clearTimeout(timer);
  }, [liveSessions.length]);

  const ready = liveSessions.filter(canInject).length;
  const goalCount = liveSessions.filter((session) => session.tool === 'codex' && session.goal && ['active', 'paused'].includes(session.goal.status)).length;

  /**
   * The top navigation.
   *
   * 设置 is deliberately not here: the settings rail becomes the left column on that page, and
   * settings is reached from the bottom bar's popup or `Ctrl+,`, the way the reference puts it
   * in the account menu rather than in the page list.
   */
  const nav = [
    { id: 'overview' as const, label: '进程', icon: LayoutDashboard },
    { id: 'agents' as const, label: '智能体窗口', icon: Terminal },
    { id: 'timeline' as const, label: '事件', icon: ListTree },
  ];

  /**
   * What occupies the left column.
   *
   * On 设置 the column is the settings section rail, so the app's own sidebar — brand,
   * navigation, process list and footer — is not drawn at all: two stacked left rails
   * would be one column too many, and the settings rail is the navigation for that page.
   * The title bar spans the full width either way, so it stays at the top regardless.
   */
  const settingsMode = page === 'settings';

  return (
    <div className={`app-shell ${sidebarCompact ? 'app-shell--compact' : ''} ${settingsMode ? 'app-shell--settings' : ''}`}>
      {/* Row 1 spans both grid columns: it is the window's title bar, so the
          sidebar must not sit beside it. */}
      <TitleBar
        sidebarCompact={sidebarCompact}
        onToggleSidebar={() => setSidebarCompact((current) => !current)}
        canGoBack={history.back.length > 0}
        canGoForward={history.forward.length > 0}
        onBack={goBack}
        onForward={goForward}
        bridge={bridge}
        onAction={runMenuAction}
      />
      <button className={`mobile-overlay ${sidebarOpen ? 'is-open' : ''}`} type="button" aria-label={t("关闭菜单")} onClick={() => setSidebarOpen(false)} />
      {settingsMode ? (
        /* The settings column. On the settings page this *is* the left rail, so it owns
           the same slot the app sidebar would. Below the drawer breakpoint it is a
           drawer like the sidebar, opened by the same topbar button, which is why it
           carries the open state and the close control too. */
        <aside
          id="watchdog-sidebar"
          className={`sidebar sidebar--settings ${sidebarOpen ? 'is-open' : ''}`}
          aria-label={t("设置分区")}
        >
          <button className="sidebar-close icon-button" type="button" aria-label={t("关闭菜单")} onClick={() => setSidebarOpen(false)}><X size={18} /></button>
          <SettingsRail
            active={settingsSection}
            onSelect={(id) => {
              setSettingsSection(id);
              // Picking a section closes the drawer so the panel it opened is readable,
              // the same way choosing a page closes the app sidebar's drawer. At column
              // widths this is a no-op because the rail is not a drawer there.
              setSidebarOpen(false);
            }}
            onBack={() => { navigate('overview'); setSidebarOpen(false); }}
          />
        </aside>
      ) : (
      <aside id="watchdog-sidebar" className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        {/* No brand block at the top: it repeated the app's own name on every page without
            carrying anything actionable, and the identity it showed lives in the bottom
            bar instead. The close control the drawer needs at narrow widths stays, and
            hides itself at column widths where there is no drawer to close. */}
        <button className="sidebar-close icon-button" type="button" aria-label={t("关闭菜单")} onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        <nav aria-label={t("主导航")}>{nav.map((item) => <button key={item.id} className={`nav-button ${page === item.id ? 'is-active' : ''}`} type="button" aria-current={page === item.id ? 'page' : undefined} title={sidebarCompact ? t(item.label) : undefined} onClick={() => { navigate(item.id); setSidebarOpen(false); }}><item.icon size={18} /><span>{t(item.label)}</span></button>)}</nav>
        {/* The discovered processes, grouped by the application they run inside. This
            is the list the reference sidebar's structure is modelled on: a heading per
            group and a full-width highlight on the selected row. It scrolls on its own
            so a long list never pushes the navigation or the footer out of reach. */}
        <SidebarProcessList
          sessions={liveSessions}
          selectedId={selectedSessionId}
          onSelect={(session) => {
            setSelectedSessionId(session.id);
            navigate('process');
            setSidebarOpen(false);
          }}
          filter={processFilter}
          onFilterChange={setProcessFilter}
          pinnedIds={pinnedIds}
          onTogglePin={togglePinned}
        />
        {/* The bottom bar. Selecting it opens a menu upwards, out of the sidebar's
            bottom edge, the way the reference sidebar's user bar does. It is a menu
            rather than a row of buttons so the sidebar footer stays one line however
            many entries it grows. */}
        <div className="sidebar__footer">
          <div className={`account-bar ${accountMenuOpen ? 'is-open' : ''}`} ref={accountMenuRef}>
            {accountMenuOpen && (
              // The status block sits outside the `role="menu"`, in the popup region that
              // contains it. A menu may only hold menu items, separators and groups, so a
              // plain status block among the items is invalid and some screen readers skip
              // the whole menu for it. The status is still announced, because it is a
              // region with its own label.
              <div className="account-popup" role="region" aria-label={t("账户与状态")}>
                {/* One header block, then rows — the grammar the reference popup uses. Two
                    stacked header blocks read as two headers; the identity is the header and
                    the service facts become label/value rows like any other.
                    Only real values appear here: the app has no billing, invites or account,
                    so none of those are invented to look like the reference. */}
                <div className="account-popup__header">
                  <span className="brand__mark" data-testid="brand-mark" aria-hidden="true"><img src={brandIcon} alt="" width={34} height={34} /></span>
                  <div>
                    <strong>{displayName.trim().length > 0 ? displayName : 'Selbstlauf'}</strong>
                    <span>{t("continuation watchdog")}</span>
                  </div>
                </div>

                <div className="account-popup__facts">
                  <div className="account-popup__fact">
                    <span className={`process-dot process-dot--${live ? 'writable' : 'error'}`} aria-hidden="true" />
                    <span>{t("连接状态")}</span>
                    <strong className={live ? 'text-ready' : 'text-warn'}>
                      {live ? t("在线") : staticDemo ? t("离线预览") : t("未连接")}
                    </strong>
                  </div>
                  <div className="account-popup__fact">
                    <span className={`process-dot process-dot--${ready > 0 ? 'writable' : 'monitor'}`} aria-hidden="true" />
                    <span>{t("发现进程")}</span>
                    <strong>{sessions.length}</strong>
                  </div>
                  <div className="account-popup__fact">
                    <span className="process-dot process-dot--writable" aria-hidden="true" />
                    <span>{t("可写入")}</span>
                    <strong>{ready}</strong>
                  </div>
                </div>

                <div className="account-menu" role="menu" aria-label={t("账户与状态菜单")}>
                  <button className="account-menu__item" type="button" role="menuitem" onClick={() => { changeThemePreference(theme === 'dark' ? 'light' : 'dark'); setAccountMenuOpen(false); }}>
                    {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
                    <span>{t(theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题')}</span>
                  </button>
                  {/* The pet has its own settings section, so this is a real destination
                      rather than a decoration, and it is reachable from here. No key is shown beside it: Ctrl+3
                      is bound to 切换到设置 and lands on the settings page's first section, not on the pet, and
                      the 键盘快捷键 section documents it that way. */}
                  <button className="account-menu__item" type="button" role="menuitem" onClick={() => { navigate('settings'); setSettingsSection('pet'); setAccountMenuOpen(false); setSidebarOpen(false); }}>
                    <PawPrint size={17} />
                    <span>{t("显示宠物")}</span>
                  </button>
                  <button className="account-menu__item" type="button" role="menuitem" onClick={() => { navigate('settings'); setAccountMenuOpen(false); setSidebarOpen(false); }}>
                    <Settings2 size={17} />
                    <span>{t("设置")}</span>
                    <kbd>Ctrl+,</kbd>
                  </button>
                </div>

                {/* The last entry is set apart, as the reference sets its final entry apart:
                    it changes the window rather than navigating anywhere. */}
                <div className="account-menu account-menu--separated" role="menu" aria-label={t("窗口")}>
                  {/* A toggle, naming the direction it will take — like the title bar's own control. It used to
                      read 收起侧栏 and call setSidebarCompact(true) whatever the state was, so the entry repeated
                      an action that had already happened and offered no way back. */}
                  <button className="account-menu__item" type="button" role="menuitem" onClick={() => { setSidebarCompact((current) => !current); setAccountMenuOpen(false); }}>
                    {sidebarCompact ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
                    <span>{sidebarCompact ? t("展开侧栏") : t("收起侧栏")}</span>
                  </button>
                </div>
              </div>
            )}
            <button
              className="account-bar__button"
              type="button"
              aria-haspopup="menu"
              aria-expanded={accountMenuOpen}
              onClick={() => setAccountMenuOpen((current) => !current)}
            >
              <span className="brand__mark" aria-hidden="true"><img src={brandIcon} alt="" width={34} height={34} /></span>
              <div>
                <strong>{live ? t("服务在线") : staticDemo ? t("离线预览") : t("服务未连接")}</strong>
                {/* The count is its own text node so it reads on its own. */}
                <span>{t('{count} 个进程', { count: sessions.length })}</span>
              </div>
              <ChevronUp size={17} />
            </button>
          </div>
        </div>
      </aside>
      )}

      <main className="workspace">
        {preferenceError && <p className="notice notice--error" role="alert">{messageText(preferenceError, locale)}</p>}
        <header className="topbar"><div className="topbar__title"><button className="mobile-menu icon-button" type="button" aria-label={t("打开菜单")} aria-controls="watchdog-sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><div><span className="eyebrow">{t("Local control")}</span><h1>{page === 'overview' ? t("进程监控") : page === 'process' ? t("进程详情") : page === 'agents' ? t("智能体窗口") : page === 'timeline' ? t("事件记录") : t("Watchdog 设置")}</h1></div></div><div className="topbar__actions"><button className="button button--primary agent-launch-button" type="button" aria-label={t("启动智能体")} onClick={() => setLauncherOpen(true)}><CirclePlay size={16} />{t("启动智能体")}</button><span className="poll-age"><Activity size={14} />{health.lastPollAtMs === null ? t("尚未轮询") : t("轮询 {duration} 前", { duration: formatDuration(Math.max(0, Date.now() - health.lastPollAtMs)) })}</span>{config.dryRun && <span className="mode-badge"><ShieldAlert size={15} />{t("DRY RUN")}</span>}<button className="icon-button" type="button" title={t("刷新")} aria-label={t("刷新")} onClick={() => void refresh()}><RefreshCw size={17} /></button>{health.running ? <button className="button button--stop" type="button" onClick={() => void emergencyStop()} disabled={saving}><Power size={16} />{t("紧急停止")}</button> : <button className="button button--start" type="button" onClick={() => void startWatchdog()} disabled={saving}><CirclePlay size={16} />{t("启动 Watchdog")}</button>}</div></header>

        {notice !== null
          && notifications.inPanel
          && (notice.tone === 'error' ? notifications.onError : notifications.onSuccess)
          && <div className="notice" role="status"><span>{messageText(notice.text, locale)}</span><button className="icon-button" type="button" aria-label={t("关闭通知")} onClick={() => setNotice(null)}><X size={15} /></button></div>}

        {page === 'overview' && <div className="page-content">
          <section className="metric-strip" aria-label={t("运行概览")}><div><span>{t("发现进程")}</span><strong>{liveSessions.length}</strong></div><div><span>{t("可写入")}</span><strong>{ready}</strong></div><div><span>Codex Goal</span><strong>{goalCount}</strong></div><div><span>Watchdog</span><strong className={health.running ? 'text-ready' : 'text-warn'}>{health.running ? t("运行中") : live ? t("已停止") : t("离线")}</strong></div></section>
          <section className="content-section"><div className="section-heading"><div><span className="eyebrow">{t("Sessions")}</span><h2>{t("独立进程")}</h2></div><span className="section-meta"><span className={`status-light ${live ? 'is-online' : ''}`} />{live ? t("实时同步") : staticDemo ? t("离线预览") : t("等待连接")}</span></div><ProcessTable sessions={liveSessions} config={config} busy={busy} allowReveal={allowReveal} onPause={(session) => void mutateSession(session, 'pause')} onInject={(session) => void mutateSession(session, 'inject')} onFocus={(session) => void focusSession(session)} onOpenTerminal={openSessionTerminal} /></section>
          <section className="content-section compact-events"><div className="section-heading"><div><span className="eyebrow">{t("Recent")}</span><h2>{t("最近事件")}</h2></div><button className="text-button" type="button" onClick={() => navigate('timeline')}>{t("查看全部")}</button></div><Timeline events={visibleEvents.slice(0, 5)} /></section>
        </div>}

        {/* The session chosen in the sidebar list. The id is resolved against the
            current sessions every render, so a session that exits while its detail is
            open falls back to the empty state rather than showing stale data. */}
        {page === 'process' && <div className="page-content">
          <ProcessDetail
            session={liveSessions.find((session) => session.id === selectedSessionId) ?? null}
            sessions={liveSessions}
            config={config}
            busy={busy}
            allowReveal={allowReveal}
            onBack={() => navigate('overview')}
            onSelect={(session) => setSelectedSessionId(session.id)}
            onPause={(session) => void mutateSession(session, 'pause')}
            onInject={(session) => void mutateSession(session, 'inject')}
            onFocus={(session) => void focusSession(session)}
            onSendPrompt={(session, prompt) => mutateSession(session, 'inject', prompt)}
            {...(staticDemo || api.output === undefined ? {} : { requestOutput: api.output })}
            onOpenTerminal={openSessionTerminal}
            {...(previewWindow === null ? {} : { requestPreview: previewWindow })}
            {...(typeIntoWindow === null ? {} : { onTypeIntoWindow: typeIntoWindow })}
            windowSharedBy={
              // How many watched sessions share the selected session's window. More than one refuses typing,
              // because the text would reach whichever pane holds the focus inside that window.
              selectedSessionId === null ? undefined : liveSessions.filter(
                (entry) => entry.host?.windowHandle !== null
                  && entry.host?.windowHandle === liveSessions.find((s) => s.id === selectedSessionId)?.host?.windowHandle,
              ).length
            }
          />
        </div>}

        {(page === 'agents' || agentWindowsMounted) && <div className="page-content" hidden={page !== 'agents'}><AgentWindows api={agentsApi} demo={staticDemo} selectedId={selectedAgentId} onSelect={(id) => { setSelectedAgentId(id); if (id === null) localStorage.removeItem('selbstlauf-selected-agent'); else localStorage.setItem('selbstlauf-selected-agent', id); }} onLaunch={() => setLauncherOpen(true)} onOpenWindow={(session) => {
          if (bridge?.shell?.openAgentWindow) { void bridge.shell.openAgentWindow(session.id).catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error), 'error')); return; }
          const url = new URL(window.location.href);
          url.searchParams.set('agent', session.id);
          window.open(url.href, '_blank', 'noopener,noreferrer');
        }} /></div>}

        {page === 'timeline' && <div className="page-content"><section className="content-section"><div className="section-heading"><div><span className="eyebrow">{t("Audit")}</span><h2>{t("决策与写入")}</h2></div><span className="section-meta">{t("{count} 条", { count: visibleEvents.length })}</span></div><Timeline events={visibleEvents} /></section></div>}
        {page === 'settings' && <div className="page-content"><SettingsPanel config={config} theme={themePreference} activeTheme={theme} palette={palette} palettes={palettes} customized={paletteCustomized} onThemeChange={changeThemePreference} onPaletteChange={changePalette} onPaletteReset={resetPalette} onImportTheme={importTheme} onCopyTheme={copyTheme} environment={environment} environmentRefreshing={environmentRefreshing} onRefreshEnvironment={refreshEnvironment} environmentUpgrading={environmentUpgrading} onUpgradeTool={upgradeTool} onUpgradeAllTools={upgradeAllTools} onNotificationsChange={setNotifications} density={personalization.density} onDensityChange={changeDensity} pet={pet} onPetChange={changePet} hookStatus={hookStatus} profiles={codexProfiles} applyingProfile={applyingProfile} onApplyProfile={applyCodexProfile} saving={saving} running={health.running} onSave={saveConfig} onToggle={toggleWatchdog} onInstall={install} startupInstalled={startupInstalled} onToggleStartup={toggleStartup} onInstallClaudeHook={() => updateClaudeHook('install')} onUninstallClaudeHook={() => updateClaudeHook('uninstall')} onDisableClaudeHook={() => updateClaudeHook('disable')} onUninstall={uninstall} sessions={liveSessions} events={events} activeSection={settingsSection} onSectionChange={setSettingsSection} onBack={() => { navigate('overview'); setSidebarOpen(false); }} onImportThemeText={importThemeText} onImportConfigText={importConfigText} onDisplayNameChange={setDisplayName} allowReveal={allowReveal} onAllowRevealChange={changeAllowReveal} closeToTray={closeToTray} onCloseToTrayChange={changeCloseToTray} preferredTerminal={preferredTerminal} onPreferredTerminalChange={changePreferredTerminal} desktopBridgeAvailable={desktopSettingsReady} desktopPlatform={bridge?.platform} desktopSettingsBusy={desktopSettingsBusy} desktopSettingsError={desktopSettingsError === null ? null : messageText(desktopSettingsError, locale)} staticDemo={staticDemo} origin={`${window.location.origin}${import.meta.env.BASE_URL}`} connected={live} /></div>}
      </main>

      {launcherOpen && <AgentLauncher api={agentsApi} demo={staticDemo} onClose={() => setLauncherOpen(false)} onLaunch={(session) => {
        setSelectedAgentId(session.id);
        localStorage.setItem('selbstlauf-selected-agent', session.id);
        setLauncherOpen(false);
        navigate('agents');
      }} onInstall={() => { setLauncherOpen(false); openSettings('general'); }} />}

      {/* The desktop pet, in the shell rather than in the section that configures it, so it is on
          screen on every page — the 宠物 settings page included. */}
      {pet.enabled && (
        <div
          className={`workspace-pet workspace-pet--${pet.form}${petPulsing ? ' is-pulsing' : ''}`}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

