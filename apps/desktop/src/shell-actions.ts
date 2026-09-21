/**
 * Desktop shell actions exposed to the renderer.
 *
 * The renderer draws its own `文件 编辑 视图 帮助` row, so it needs a small,
 * explicitly enumerated set of window operations rather than a general
 * `ipcRenderer` passthrough. This module owns both the action catalogue and the
 * pure mapping from an action name to the Electron call it performs, so the
 * mapping can be unit-tested without launching Electron.
 */

import { shouldOpenExternally } from './navigation.js';

/** Renderer commands the desktop shell may send over the preload bridge. */
export const SHELL_CHANNELS = Object.freeze({
  invoke: 'selbstlauf:shell',
  settingsGet: 'selbstlauf:settings:get',
  settingsSet: 'selbstlauf:settings:set',
  /** Main -> renderer commands (menu bar, tray). */
  command: 'selbstlauf:command',
  settingsChanged: 'selbstlauf:settings:changed',
} as const);

/** Every action the renderer is allowed to ask the main process to perform. */
export const SHELL_ACTIONS = Object.freeze([
  'reload',
  'toggleFullScreen',
  'zoom',
  'quit',
  'openExternal',
  'setTitleBarOverlay',
  'windowPreview',
  /** Type a line into a session window. Takes the foreground briefly; the user chose that trade. */
  'windowType',
] as const);

export type ShellAction = (typeof SHELL_ACTIONS)[number];

/**
 * A `#rrggbb` colour.
 *
 * The overlay action takes a colour from the renderer, so it is validated here
 * rather than trusted: anything else is refused before it reaches Electron.
 */
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/**
 * The overlay strip the native minimise / maximise / close buttons sit on.
 *
 * The title bar's background is theme- and palette-dependent (it is
 * `--panel-soft`, derived from the background, contrast and accent), so a fixed
 * colour cannot match it. The renderer therefore reports the colour it actually
 * painted and this action repaints the native strip to match; otherwise the top
 * row reads as two different strips.
 */
export interface TitleBarOverlayRequest {
  readonly color: string;
  readonly symbolColor?: string;
}

export function isShellAction(value: unknown): value is ShellAction {
  return typeof value === 'string' && (SHELL_ACTIONS as readonly string[]).includes(value);
}

/** The renderer's zoom ladder: +1 in, -1 out, 0 back to 100%. */
export function isZoomDelta(value: unknown): value is number {
  return value === 1 || value === -1 || value === 0;
}

/**
 * The subset of an Electron `webContents` the shell actions need.
 *
 * Declaring it structurally (rather than importing Electron) keeps this module
 * loadable from a plain Node test process.
 */
export interface ShellActionTarget {
  reload(): void;
  toggleFullScreen?(): void;
  setZoomLevel?(level: number): void;
  getZoomLevel?(): number;
  /** The window's own webContents, when the target is a window. */
  readonly webContents?: { setZoomLevel?(level: number): void; getZoomLevel?(): number };
}

export interface ShellActionContext {
  /** The window the action applies to. */
  readonly window: ShellActionTarget;
  /** Quit the whole app through the clean-shutdown path. */
  quit(): void;
  /** Hand an absolute http(s) URL to the OS browser. */
  openExternal(url: string): Promise<void> | void;
  /** Repaint the native window-button strip so it matches the page title bar. */
  setTitleBarOverlay?(overlay: TitleBarOverlayRequest): void;
  /**
   * Capture a preview of the window a watched session runs in.
   *
   * Deliberately keyed by *session id*, not by a window handle. If the renderer passed a handle
   * it could ask for a picture of any window on the machine; going through the service's own
   * session list bounds the capability to windows this app already monitors. The main process
   * performs the lookup, so the renderer never names a window at all.
   */
  previewWindow?(sessionId: string): Promise<WindowPreview> | WindowPreview;
  /**
   * Type a line into the window a watched session runs in.
   *
   * Keyed by session id for the same reason the preview is: the renderer never names a window, so this cannot be
   * pointed at an arbitrary one. The main process resolves the id against the service's session list, refuses
   * when the window hosts more than one session (the text would go to whichever pane holds the focus inside it),
   * and only then types — briefly taking the foreground, which the user chose knowingly.
   */
  typeIntoWindow?(sessionId: string, text: string, submit: boolean): Promise<WindowType> | WindowType;
}

/**
 * The outcome of typing into a window.
 *
 * A refusal is a result rather than an error, because the ordinary refusals are states of a healthy system — a
 * shared window, a session with no window, a window that will not take focus — and the UI has to say which one
 * applies rather than showing a failure it cannot explain.
 */
export interface WindowType {
  readonly ok: boolean;
  /** A stated reason when nothing was typed; absent on success. */
  readonly reason?: string;
  /** The window's title, so the UI can state what it typed into. */
  readonly title?: string;
  readonly typed?: number;
  readonly submitted?: boolean;
  readonly focusRestored?: boolean;
}

/**
 * The outcome of a preview request.
 *
 * `unavailable` is a first-class result rather than an error, because two of the three ways a
 * preview can fail are normal states of a healthy system: a session may run in no window at all
 * (DeepSeek Harness is a web UI), and a minimized window is not enumerated by the OS capture
 * layer at all — established by measurement, not assumption. Returning a reason lets the UI say
 * which one applies instead of showing an empty frame.
 */
export type WindowPreview =
  | {
    readonly state: 'captured';
    /** A `data:image/png;base64,...` URL, ready to use as an `<img src>`. */
    readonly dataUrl: string;
    readonly width: number;
    readonly height: number;
    /** How many watched sessions share this window; two Codex sessions can share one Tabby. */
    readonly sharedBy: number;
  }
  | { readonly state: 'no-window' }
  | { readonly state: 'minimized' }
  | { readonly state: 'unsupported'; readonly reason: string };

export interface ShellActionRequest {
  readonly action: ShellAction;
  /** Only meaningful for `zoom`; +1 in, -1 out, 0 reset. */
  readonly delta?: number;
  /** Only meaningful for `openExternal`. */
  readonly url?: string;
  /** Only meaningful for `setTitleBarOverlay`. */
  readonly color?: string;
  readonly symbolColor?: string;
  /** Only meaningful for the window actions: the watched session to act on. */
  readonly sessionId?: string;
  /** Only meaningful for `windowType`: the line to type. */
  readonly text?: string;
  /** Only meaningful for `windowType`: press Enter afterwards. */
  readonly submit?: boolean;
}

/** The zoomable surface of a window, whichever shape Electron hands back. */
function zoomTarget(window: ShellActionTarget): { setZoomLevel?(level: number): void; getZoomLevel?(): number } {
  return window.webContents ?? window;
}

export function applyShellAction(context: ShellActionContext, request: ShellActionRequest): void {
  const { window } = context;
  switch (request.action) {
    case 'reload':
      window.reload();
      return;
    case 'toggleFullScreen':
      window.toggleFullScreen?.();
      return;
    case 'zoom': {
      const delta = isZoomDelta(request.delta) ? request.delta : 0;
      const target = zoomTarget(window);
      if (target.setZoomLevel === undefined) return;
      // Electron's zoom levels are steps, not percentages: three steps per
      // doubling, and reading the current level keeps repeated presses additive.
      const current = target.getZoomLevel?.() ?? 0;
      target.setZoomLevel(delta === 0 ? 0 : current + delta);
      return;
    }
    case 'quit':
      context.quit();
      return;
    case 'openExternal': {
      const url = request.url;
      // Reuse the navigation policy's rule: only absolute http(s) URLs may reach
      // the OS, so `file:`, `javascript:`, and `ms-settings:` are refused here.
      if (typeof url !== 'string' || !shouldOpenExternally(url)) {
        throw new TypeError(`refusing to open a non-http(s) URL externally: ${String(url)}`);
      }
      void context.openExternal(url);
      return;
    }
    case 'setTitleBarOverlay': {
      // A renderer-supplied colour is validated before it reaches Electron; an
      // invalid one is dropped rather than repainting the strip with garbage.
      if (!isHexColor(request.color)) {
        throw new TypeError(`refusing a non-#rrggbb overlay colour: ${String(request.color)}`);
      }
      if (request.symbolColor !== undefined && !isHexColor(request.symbolColor)) {
        throw new TypeError(`refusing a non-#rrggbb overlay symbol colour: ${String(request.symbolColor)}`);
      }
      context.setTitleBarOverlay?.({
        color: request.color,
        ...(request.symbolColor === undefined ? {} : { symbolColor: request.symbolColor }),
      });
      return;
    }
    case 'windowPreview':
      // Handled by `applyAsyncShellAction`, which can await the capture. Reaching here means a
      // caller used the synchronous dispatcher for it, which is a programming error rather than
      // something to paper over.
      throw new TypeError('windowPreview is asynchronous: use applyAsyncShellAction');
    case 'windowType':
      // Asynchronous for a different reason: it spawns a helper that takes the foreground, types and restores.
      throw new TypeError('windowType is asynchronous: use applyAsyncShellAction');
    default: {
      const exhaustive: never = request.action;
      throw new TypeError(`unknown shell action: ${String(exhaustive)}`);
    }
  }
}

/**
 * Validate an untrusted IPC payload into a shell request.
 *
 * Anything malformed is rejected here so `applyShellAction` only ever sees a
 * well-formed action.
 */
export function parseShellRequest(payload: unknown): ShellActionRequest {
  if (payload === null || typeof payload !== 'object') {
    throw new TypeError('shell request must be an object');
  }
  const entry = payload as {
    action?: unknown;
    delta?: unknown;
    url?: unknown;
    color?: unknown;
    symbolColor?: unknown;
    sessionId?: unknown;
    text?: unknown;
    submit?: unknown;
  };
  if (!isShellAction(entry.action)) {
    throw new TypeError(`unknown shell action: ${String(entry.action)}`);
  }
  return {
    action: entry.action,
    ...(entry.delta === undefined ? {} : { delta: Number(entry.delta) }),
    ...(entry.url === undefined ? {} : { url: String(entry.url) }),
    ...(entry.color === undefined ? {} : { color: String(entry.color) }),
    ...(entry.symbolColor === undefined ? {} : { symbolColor: String(entry.symbolColor) }),
    ...(entry.sessionId === undefined ? {} : { sessionId: String(entry.sessionId) }),
    ...(entry.text === undefined ? {} : { text: String(entry.text) }),
    ...(entry.submit === undefined ? {} : { submit: entry.submit === true }),
  };
}

/**
 * The async half of the action set, kept separate from `applyShellAction`.
 *
 * `applyShellAction` is deliberately synchronous and returns nothing, which is what makes it
 * unit-testable without Electron. A capture is the one action that must await, so it is
 * dispatched through this function instead of widening the synchronous one to a Promise.
 */
export async function applyAsyncShellAction(
  context: ShellActionContext,
  request: ShellActionRequest,
): Promise<WindowPreview | WindowType> {
  if (request.action === 'windowType') {
    const typeHandler = context.typeIntoWindow;
    if (typeHandler === undefined) return { ok: false, reason: 'windowType is not wired up' };
    const sessionId = request.sessionId;
    const text = request.text;
    // A session id and a line are the only things the renderer may name here. An empty id is refused rather than
    // passed down, and the text is validated by the handler before anything is typed.
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, reason: 'windowType needs a session id' };
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, reason: 'windowType needs text to type' };
    }
    try {
      return await typeHandler(sessionId, text, request.submit === true);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  if (request.action !== 'windowPreview') {
    throw new TypeError(`not an async shell action: ${request.action}`);
  }
  const handler = context.previewWindow;
  if (handler === undefined) return { state: 'unsupported', reason: 'windowPreview is not wired up' };
  const sessionId = request.sessionId;
  // A session id is the only thing the renderer may name here, and an empty one is refused
  // rather than passed down to become some default window.
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { state: 'unsupported', reason: 'windowPreview needs a session id' };
  }
  try {
    return await handler(sessionId);
  } catch (error) {
    return { state: 'unsupported', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether an action is one the asynchronous dispatcher handles. */
export function isAsyncShellAction(action: ShellAction): boolean {
  return action === 'windowPreview' || action === 'windowType';
}

/**
 * Distinguish the two async outcomes.
 *
 * `applyAsyncShellAction` returns a union because the two actions produce different results. A caller that knows
 * which action it sent still has to narrow the type, and a named guard reads better at the call site than a
 * property check — and it keeps the discrimination in one place if a field is ever renamed.
 */
export function isWindowPreviewResult(result: WindowPreview | WindowType): result is WindowPreview {
  return 'state' in result;
}
