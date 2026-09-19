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
}

export interface ShellActionRequest {
  readonly action: ShellAction;
  /** Only meaningful for `zoom`; +1 in, -1 out, 0 reset. */
  readonly delta?: number;
  /** Only meaningful for `openExternal`. */
  readonly url?: string;
  /** Only meaningful for `setTitleBarOverlay`. */
  readonly color?: string;
  readonly symbolColor?: string;
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
  const entry = payload as { action?: unknown; delta?: unknown; url?: unknown; color?: unknown; symbolColor?: unknown };
  if (!isShellAction(entry.action)) {
    throw new TypeError(`unknown shell action: ${String(entry.action)}`);
  }
  return {
    action: entry.action,
    ...(entry.delta === undefined ? {} : { delta: Number(entry.delta) }),
    ...(entry.url === undefined ? {} : { url: String(entry.url) }),
    ...(entry.color === undefined ? {} : { color: String(entry.color) }),
    ...(entry.symbolColor === undefined ? {} : { symbolColor: String(entry.symbolColor) }),
  };
}