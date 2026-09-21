import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TITLE_BAR_OVERLAY,
  applyNavigationPolicy,
  createWindowOptions,
  type DesktopWindowOptions,
  type NavigationPolicyTarget,
} from './navigation.js';
import { buildApplicationMenu, RENDERER_COMMANDS, type RendererCommand } from './menu.js';
import {
  SHELL_CHANNELS,
  applyAsyncShellAction,
  applyShellAction,
  isAsyncShellAction,
  parseShellRequest,
  type WindowPreview,
} from './shell-actions.js';
import {
  readDesktopSettings,
  updateDesktopSettings,
  DEFAULT_DESKTOP_SETTINGS,
  type DesktopSettings,
} from './desktop-settings.js';
import { readStartupState, setStartupInstalled } from './startup-client.js';
import { installTray, showWindow, type TrayController, type TrayLike } from './tray.js';
import { createLifecycle } from './lifecycle.js';
import {
  captureSessionWindow,
  type PreviewSession,
  type PreviewSource,
} from './window-preview.js';
import {
  minimizeWindowAgain,
  resolveRestoreScriptPath,
  showWindowWithoutActivating,
} from './window-restore.js';
import {
  readWatchdogRecord,
  resolveStateDirectory,
  waitForHealth,
  watchdogOrigin,
} from './service.js';
import {
  assertBundledDistribution,
  resolveBundledDistribution,
  startBundledService,
  type BundledServiceHost,
  type StartBundledServiceOptions,
} from './service-host.js';

export type { DesktopWindowOptions } from './navigation.js';

export const DEFAULT_WINDOW = Object.freeze({
  title: 'Selbstlauf Console',
  width: 1440,
  height: 900,
});

export interface ResolvedTarget {
  readonly kind: 'service' | 'placeholder';
  readonly url: string;
  readonly pid: number | null;
}

export async function resolveDesktopTarget(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedTarget> {
  const stateDirectory = resolveStateDirectory(environment);
  const record = await readWatchdogRecord(stateDirectory);
  if (record === null) {
    return { kind: 'placeholder', url: placeholderUrl(), pid: null };
  }
  const origin = watchdogOrigin(record.port);
  if (!(await waitForHealth(origin))) {
    return { kind: 'placeholder', url: placeholderUrl(), pid: null };
  }
  return { kind: 'service', url: origin, pid: record.pid };
}

export function placeholderUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(PLACEHOLDER_HTML)}`;
}

export interface NavigationPolicyTargetWithSend extends NavigationPolicyTarget {
  /** Deliver a named command to this webContents' renderer. */
  send?(channel: string, ...args: unknown[]): void;
}

export interface ElectronWindow {
  readonly webContents: NavigationPolicyTargetWithSend;
  loadURL(url: string): Promise<void>;
  on(event: 'closed', listener: () => void): void;
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void;
  once(event: 'ready-to-show', listener: () => void): void;
  show(): void;
  /** Present once the window can be hidden to the tray. */
  hide?(): void;
  focus?(): void;
  isMinimized?(): boolean;
  restore?(): void;
  isDestroyed?(): boolean;
  /** Used by the renderer's full-screen menu item. */
  toggleFullScreen?(): void;
  reload?(): void;
}

/**
 * The Electron pieces the desktop shell uses.
 *
 * Everything past `shell` is optional so existing test doubles that only model
 * `app`/`BrowserWindow`/`shell` keep type-checking, and so a missing member
 * degrades to "feature off" instead of a startup crash.
 */
export interface ElectronShell {
  readonly app: {
    whenReady(): Promise<void>;
    on(event: 'window-all-closed', listener: () => void): void;
    on(event: 'second-instance', listener: () => void): void;
    quit(): void;
    isPackaged?: boolean;
    requestSingleInstanceLock?(): boolean;
  };
  readonly BrowserWindow: new (options: DesktopWindowOptions) => ElectronWindow;
  readonly shell: { openExternal(url: string): Promise<void> };
  /** Optional so a stub without menus still satisfies the interface. */
  readonly Menu?: {
    setApplicationMenu(menu: unknown): void;
    buildFromTemplate(template: unknown[]): unknown;
  };
  readonly Tray?: new (icon: unknown) => TrayLike;
  readonly nativeImage?: { createFromPath(path: string): unknown };
  /**
   * The window capturer, used to preview the window a watched session runs in.
   *
   * Optional so a stub without it degrades to "preview unavailable" rather than crashing, the
   * same way the menu and tray members do.
   */
  readonly desktopCapturer?: {
    getSources(options: {
      types: readonly string[];
      thumbnailSize: { width: number; height: number };
      fetchWindowIcons?: boolean;
    }): Promise<readonly PreviewSource[]>;
  };
  readonly ipcMain?: {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
    removeHandler?(channel: string): void;
  };
}

/** The window with the extra lifecycle members the shell drives. */
export interface ManagedWindow extends ElectronWindow {
  show(): void;
  hide(): void;
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
  isDestroyed(): boolean;
  /** Repaints the native window-button strip; Electron-only, so optional here. */
  setTitleBarOverlay?(overlay: { color: string; symbolColor?: string; height?: number }): void;
}

export interface DesktopWindowRequest {
  readonly serviceOrigin: string;
  readonly preloadPath?: string;
  /** Branded window/taskbar icon; falls back to the Electron default when absent. */
  readonly iconPath?: string;
}

export interface WindowIconOptions {
  readonly appRoot: string;
  /** `process.resourcesPath` in a packaged build; absent in a checkout. */
  readonly resourcesPath?: string;
}

/**
 * Locate the branded icon.
 *
 * Electron only loads an icon from an absolute path, so both shipped layouts are
 * probed in order:
 *
 *  - `resources/build/icon.ico` — the packaged install (electron-builder copies
 *    it there as an extraResource).
 *  - `<appRoot>/build/icon.ico` — a repository checkout.
 *
 * The packaged path used to be missing from the build, which silently cost the
 * app both its taskbar icon and its tray: without a tray, closing the window
 * fell through to a real quit instead of hiding. A build without the asset still
 * opens its window; it just keeps Electron's default mark.
 */
export function resolveWindowIconPath(options: WindowIconOptions): string | undefined {
  const resourcesPath = options.resourcesPath;
  const candidates = [
    ...(resourcesPath === undefined || resourcesPath.trim().length === 0
      ? []
      : [resolve(resourcesPath, 'build', 'icon.ico')]),
    resolve(options.appRoot, 'build', 'icon.ico'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** Spreadable form so callers never build an `undefined` icon option. */
function windowIcon(appRoot: string, resourcesPath?: string): { readonly iconPath?: string } {
  const iconPath = resolveWindowIconPath({
    appRoot,
    ...(resourcesPath === undefined ? {} : { resourcesPath }),
  });
  return iconPath === undefined ? {} : { iconPath };
}

function openWindow(shell: ElectronShell, request: DesktopWindowRequest): ManagedWindow {
  const base = createWindowOptions({ serviceOrigin: request.serviceOrigin });
  const windowOptions: DesktopWindowOptions = {
    ...base,
    // `preload` belongs inside `webPreferences`; on the top level Electron ignores
    // it, the renderer gets no bridge, and every fire-and-forget call from the
    // renderer fails without a single log line.
    webPreferences: {
      ...base.webPreferences,
      ...(request.preloadPath === undefined ? {} : { preload: request.preloadPath }),
    },
    ...(request.iconPath === undefined ? {} : { icon: request.iconPath }),
  };
  const window = new shell.BrowserWindow(windowOptions) as ManagedWindow;
  applyNavigationPolicy({
    webContents: window.webContents,
    serviceOrigin: request.serviceOrigin,
    openExternal: (url) => {
      void shell.shell.openExternal(url);
    },
  });
  // A preload that throws takes the whole renderer bridge with it: the title-bar
  // colour report, the menu actions and the settings store all stop working, and
  // because every call is fire-and-forget the failure is otherwise completely
  // silent. Surface it on stderr so a broken bridge is diagnosable from a log.
  window.webContents.on?.('preload-error', (_event, preloadPath, error) => {
    process.stderr.write(
      `preload failed: ${preloadPath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
  window.once('ready-to-show', () => window.show());
  return window;
}

export async function launchDesktop(
  shell: ElectronShell,
  environment: NodeJS.ProcessEnv = process.env,
  options: { readonly appRoot?: string; readonly resourcesPath?: string } = {},
): Promise<ResolvedTarget> {
  await shell.app.whenReady();
  const target = await resolveDesktopTarget(environment);
  const window = openWindow(shell, {
    serviceOrigin: target.url,
    ...(options.appRoot === undefined ? {} : windowIcon(options.appRoot, options.resourcesPath)),
  });
  await window.loadURL(target.url);
  window.on('closed', () => undefined);
  return target;
}

export interface DesktopHostOptions {
  readonly appRoot: string;
  readonly resourcesPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly preloadPath?: string;
  /** Test seam: replace the bundled service launcher. */
  readonly startService?: (options: StartBundledServiceOptions) => Promise<BundledServiceHost>;
  /** Called with the window as soon as it exists, before it is loaded. */
  readonly attach?: (window: ManagedWindow) => void;
}

export interface HostedDesktop {
  readonly target: ResolvedTarget;
  readonly host: BundledServiceHost | null;
  /** The opened window; present for every path that actually opened one. */
  readonly window?: ManagedWindow;
}

/** Start the bundled service (when its artifacts exist) and open the window on it. */
export async function hostAndLaunch(
  shell: ElectronShell,
  options: DesktopHostOptions,
): Promise<HostedDesktop> {
  const environment = options.environment ?? process.env;
  const distribution = resolveBundledDistribution({
    appRoot: options.appRoot,
    resourcesPath: options.resourcesPath,
  });
  assertBundledDistribution(distribution);
  await shell.app.whenReady();
  const startService = options.startService ?? startBundledService;
  const host = await startService({ appRoot: options.appRoot, resourcesPath: options.resourcesPath, environment });
  const target: ResolvedTarget = { kind: 'service', url: host.origin, pid: host.pid };
  const window = openWindow(shell, {
    serviceOrigin: target.url,
    ...(options.preloadPath === undefined ? {} : { preloadPath: options.preloadPath }),
    ...windowIcon(options.appRoot, options.resourcesPath),
  });
  options.attach?.(window);
  await window.loadURL(target.url);
  window.on('closed', () => undefined);
  return { target, host, window };
}

/**
 * Install the application menu.
 *
 * A no-op when the shell has no `Menu`, so a stub (or a platform without a menu
 * bar) simply skips it instead of failing to start.
 */
export function installApplicationMenu(
  shell: ElectronShell,
  actions: {
    readonly send: (command: RendererCommand, section?: string) => void;
    readonly hide: () => void;
    readonly openExternal: (url: string) => void;
  },
): unknown {
  if (shell.Menu === undefined) return null;
  const template = buildApplicationMenu({
    send: actions.send,
    hide: actions.hide,
    openExternal: actions.openExternal,
  });
  const menu = shell.Menu.buildFromTemplate(template as unknown[]);
  shell.Menu.setApplicationMenu(menu);
  return menu;
}

/** Register the renderer-facing shell actions exactly once. */
export function registerShellHandlers(
  shell: ElectronShell,
  context: {
    readonly window: () => ManagedWindow | null;
    readonly quit: () => void;
    readonly openExternal: (url: string) => Promise<void> | void;
    readonly settings: () => Promise<DesktopSettings>;
    readonly saveSettings: (patch: unknown) => Promise<DesktopSettings>;
    /** Repaint the native window-button strip; optional so stubs keep working. */
    readonly setTitleBarOverlay?: (colors: { color: string; symbolColor?: string }) => void;
    /** Capture a preview of a watched session's window; optional so stubs keep working. */
    readonly previewWindow?: (sessionId: string) => Promise<WindowPreview> | WindowPreview;
  },
): boolean {
  const ipcMain = shell.ipcMain;
  if (ipcMain === undefined) return false;
  ipcMain.handle(SHELL_CHANNELS.invoke, (_event, payload: unknown) => {
    const request = parseShellRequest(payload);
    // The capture is the one action that must await, so it goes through the async dispatcher.
    // A rejected request resolves to an `unsupported` outcome rather than throwing across IPC,
    // where the renderer would only see an opaque "Error invoking remote method".
    if (isAsyncShellAction(request.action)) {
      return applyAsyncShellAction(
        {
          window: { reload: () => undefined },
          quit: context.quit,
          openExternal: context.openExternal,
          ...(context.previewWindow === undefined ? {} : { previewWindow: context.previewWindow }),
        },
        request,
      );
    }
    // Repainting the native strip must work before the window is usable: the
    // renderer reports its title-bar colour as soon as it paints, which can land
    // while the window is still being wired up. Every other action needs a live
    // window, so it keeps the guard.
    if (request.action === 'setTitleBarOverlay') {
      applyShellAction(
        {
          window: { reload: () => undefined },
          quit: context.quit,
          openExternal: context.openExternal,
          ...(context.setTitleBarOverlay === undefined
            ? {}
            : { setTitleBarOverlay: context.setTitleBarOverlay }),
        },
        request,
      );
      return null;
    }
    const window = context.window();
    if (window === null) return null;
    applyShellAction(
      {
        window: {
          reload: () => window.reload?.(),
          toggleFullScreen: () => window.toggleFullScreen?.(),
          webContents: {
            ...(window.webContents as { setZoomLevel?: (level: number) => void; getZoomLevel?: () => number }),
          },
        },
        quit: context.quit,
        openExternal: context.openExternal,
        ...(context.setTitleBarOverlay === undefined
          ? {}
          : { setTitleBarOverlay: context.setTitleBarOverlay }),
      },
      request,
    );
    return null;
  });
  ipcMain.handle(SHELL_CHANNELS.settingsGet, () => context.settings());
  ipcMain.handle(SHELL_CHANNELS.settingsSet, (_event, patch: unknown) => context.saveSettings(patch));
  return true;
}

/**
 * Confirm the renderer actually received the preload bridge and is hardened.
 *
 * Two failures are silent and both have shipped:
 *
 *  - A preload that fails to load emits no `preload-error` for a sandboxed
 *    preload Electron cannot execute, and every renderer call is fire-and-forget,
 *    so features just quietly stop working. A `.mjs` preload shipped that way.
 *  - Flattening `webPreferences` makes Electron ignore `sandbox`,
 *    `contextIsolation` and `preload` together, so the renderer runs with
 *    *default*, weaker privileges while every unit test still passes.
 *
 * This checks the observable facts once after load and writes any failure to
 * stderr. The checks read the renderer's own globals rather than the options
 * object, because the options object is what lied: Node globals must be absent
 * from the page, and `process.sandboxed` must be true.
 *
 * It is diagnostic only: a weaker renderer must not stop the window from opening,
 * since the console still works without the desktop extras.
 */
export async function verifyPreloadBridge(window: ManagedWindow): Promise<boolean> {
  const target = window.webContents as unknown as {
    executeJavaScript?: (code: string) => Promise<unknown>;
  };
  if (target.executeJavaScript === undefined) return false;
  try {
    const report = await target.executeJavaScript(
      `JSON.stringify({
         bridge: typeof window.selbstlaufDesktop !== 'undefined'
           && typeof window.selbstlaufDesktop.shell === 'object',
         sandboxed: typeof process !== 'undefined' ? process.sandboxed === true : null,
         nodeLeaked: typeof window.require !== 'undefined'
           || typeof window.module !== 'undefined'
           || typeof window.Buffer !== 'undefined'
           || typeof window.global !== 'undefined',
         electronLeaked: typeof window.electron !== 'undefined'
           || typeof window.ipcRenderer !== 'undefined'
       })`,
    );
    const parsed = typeof report === 'string' ? JSON.parse(report) : null;
    if (parsed === null) {
      process.stderr.write('preload bridge check returned an unreadable result\n');
      return false;
    }

    const problems: string[] = [];
    if (parsed.bridge !== true) {
      problems.push('window.selbstlaufDesktop is not available in the renderer');
    }
    // `null` means `process` is absent entirely, which is the strongest form of
    // isolation; only an explicit `false` is a regression.
    if (parsed.sandboxed === false) {
      problems.push('the renderer is not sandboxed (webPreferences.sandbox was ignored)');
    }
    if (parsed.nodeLeaked === true) {
      problems.push('Node globals are reachable from the page (contextIsolation/nodeIntegration ignored)');
    }
    if (parsed.electronLeaked === true) {
      problems.push('the electron/ipcRenderer internals leaked onto the page');
    }

    if (problems.length > 0) {
      process.stderr.write(`renderer verification failed: ${problems.join('; ')}\n`);
      return false;
    }
    return true;
  } catch (error) {
    process.stderr.write(
      `preload bridge check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}

/**
 * Build the "tell the renderer to do something" function.
 * Commands travel over the window's `webContents`, which is the surface that
 * actually owns the renderer process; a window-level send does nothing in
 * Electron. The window is looked up on every call so a hidden-then-revived or
 * not-yet-created window is handled without the caller knowing.
 */
export function createRendererSender(
  window: () => ManagedWindow | null,
): (command: RendererCommand, section?: string) => void {
  return (command, section) => {
    const target = window();
    if (target === null || target.isDestroyed?.() === true) return;
    target.webContents.send?.(SHELL_CHANNELS.command, {
      command,
      ...(section === undefined ? {} : { section }),
    });
  };
}

export async function main(): Promise<void> {
  const shell = (await import('electron' as string)) as unknown as ElectronShell;
  const { app } = shell;

  // A second launch must surface the window the first launch already owns rather
  // than starting a second watchdog service.
  if (app.requestSingleInstanceLock !== undefined && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // dist/src/main.js -> dist -> apps/desktop
  const appRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const preloadPath = resolvePreloadPath({
    appRoot,
    ...(app.isPackaged === true && typeof resourcesPath === 'string' ? { resourcesPath } : {}),
  });
  // The window-restore helper ships in the service's own resource tree, so there is one asset layout
  // rather than two. Absent in a checkout, where the source path is used instead.
  const restoreScriptPath = resolveRestoreScriptPath(
    app.isPackaged === true && typeof resourcesPath === 'string' ? resourcesPath : undefined,
  );

  const stateDirectory = resolveStateDirectory();
  // Tracked in a mutable box so the close handler always reads the current value.
  let closeToTray = true;

  let tray: TrayController | null = null;
  let window: ManagedWindow | null = null;
  let serviceHost: BundledServiceHost | null = null;

  const lifecycle = createLifecycle({
    window: () => window,
    closeToTray: () => closeToTray,
    shutdown: {
      stopService: async () => {
        await serviceHost?.stop().catch(() => undefined);
      },
      destroyTray: () => {
        tray?.destroy();
        tray = null;
      },
      quit: () => app.quit(),
    },
    hasTray: () => tray !== null && tray.tray !== null,
  });

  // Preferences are read before the window opens so the first close already
  // honours them; a state directory that cannot be read keeps the defaults.
  const stored = await readDesktopSettings(stateDirectory).catch(() => DEFAULT_DESKTOP_SETTINGS);
  closeToTray = stored.closeToTray;

  const sendToRenderer = createRendererSender(() => window);

  /**
   * Register the shell IPC handlers before any window opens.
   *
   * The renderer reports its title-bar colour as soon as it paints, which happens
   * while the window is still loading — before `hostAndLaunch` resolves. Register
   * afterwards and that first report hits "No handler registered", which the
   * preload's fire-and-forget call swallows, leaving the native button strip on
   * its stale colour and splitting the top row into two visibly different strips.
   * `window` is read through a closure, so registering early is safe: the box is
   * populated by the time a report arrives.
   */
  registerShellHandlers(shell, {
    window: () => window,
    quit: () => void lifecycle.shutdown(),
    openExternal: (url) => shell.shell.openExternal(url),
    settings: () => readDesktopSettings(stateDirectory).catch(() => DEFAULT_DESKTOP_SETTINGS),
    saveSettings: async (patch) => {
      const saved = await updateDesktopSettings(stateDirectory, patch);
      closeToTray = saved.closeToTray;
      return saved;
    },
    // The title bar is painted from the live palette, so its colour changes with
    // the theme, the contrast slider and the accent. A fixed overlay colour
    // cannot match it; the renderer reports what it painted and the native strip
    // follows.
    setTitleBarOverlay: (colors) => {
      window?.setTitleBarOverlay?.({
        color: colors.color,
        ...(colors.symbolColor === undefined ? {} : { symbolColor: colors.symbolColor }),
        height: TITLE_BAR_OVERLAY.height,
      });
    },
    /**
     * Preview the window a watched session runs in.
     *
     * The service origin is resolved lazily from the same record the rest of the desktop shell
     * reads, because this handler is registered before the service is hosted. The session list
     * comes from the service rather than from the renderer, which is what bounds the capability
     * to windows this app already monitors — the renderer names a session, never a window.
     */
    previewWindow: async (sessionId) => {
      const capturer = shell.desktopCapturer;
      if (capturer === undefined) {
        return { state: 'unsupported', reason: 'this build cannot capture windows' } as const;
      }
      const restoreOptions = restoreScriptPath === undefined ? {} : { scriptPath: restoreScriptPath };
      return captureSessionWindow(
        {
          getSources: (options) => capturer.getSources(options),
          // A minimized window is not enumerated at all, so it is shown briefly to let it render, then
          // minimized again. Both calls use the non-activating variants, so a preview never takes focus.
          showWithoutActivating: (handle) => showWindowWithoutActivating(handle, restoreOptions),
          minimizeAgain: (handle, wasMinimized) => minimizeWindowAgain(handle, wasMinimized, restoreOptions),
          sessions: async () => {
            const record = await readWatchdogRecord(stateDirectory);
            if (record === null) return [];
            const origin = watchdogOrigin(record.port);
            const response = await fetch(`${origin}/api/sessions`);
            if (!response.ok) throw new Error(`sessions request failed: ${response.status}`);
            const body = (await response.json()) as { sessions?: readonly PreviewSession[] };
            return body.sessions ?? [];
          },
        },
        sessionId,
      );
    },
  });

  let hosted: HostedDesktop;
  try {
    hosted = await hostAndLaunch(shell, {
      appRoot,
      preloadPath,
      ...(app.isPackaged === true && typeof resourcesPath === 'string' ? { resourcesPath } : {}),
      attach: (opened) => {
        window = opened;
        opened.on('close', (event) => lifecycle.handleWindowClose(event));
        // Verify the renderer really received the bridge. A preload that fails to
        // load is otherwise invisible: the renderer's calls are fire-and-forget,
        // so the window simply loses its title-bar colour report, the menus their
        // actions and the settings page its store with nothing in the log.
        void verifyPreloadBridge(opened);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Packaged installs must stay usable when the service is already running or the
    // bundled artifacts are missing; the recorded service is the fallback target.
    const fallback = await resolveDesktopTarget().catch(() => null);
    if (fallback === null || fallback.kind !== 'service') throw error;
    process.stderr.write(`${message}\nfalling back to the recorded watchdog service\n`);
    const opened = openWindow(shell, { serviceOrigin: fallback.url, preloadPath, ...windowIcon(appRoot, resourcesPath) });
    opened.on('close', (event) => lifecycle.handleWindowClose(event));
    window = opened;
    await opened.loadURL(fallback.url);
    opened.on('closed', () => undefined);
    hosted = { target: fallback, host: null, window: opened };
  }
  serviceHost = hosted.host;

  const origin = hosted.target.url;
  const startupClient = { origin };

  const revealWindow = () => showWindow(window);

  installApplicationMenu(shell, {
    send: sendToRenderer,
    // With the native menu bar hidden behind the custom title bar, the menu's
    // "hide" item is the same gesture as the window's own close button.
    hide: () => window?.hide(),
    openExternal: (url) => { void shell.shell.openExternal(url); },
  });

  tray = installTray({
    dependencies: {
      createIcon: (path) =>
        path === undefined || shell.nativeImage === undefined ? null : shell.nativeImage.createFromPath(path),
      createTray: (icon) => (shell.Tray === undefined ? null : new shell.Tray(icon)),
      buildMenu: (template) => {
        if (shell.Menu === undefined) return null;
        return shell.Menu.buildFromTemplate(template as unknown[]);
      },
    },
    actions: {
      window: () => window,
      send: sendToRenderer,
      readStartup: () => readStartupState(startupClient).then((state) => state.installed),
      toggleStartup: (installed) =>
        setStartupInstalled(startupClient, installed).then(async (state) => {
          // Windows renders a static context menu, so the checkbox is repainted
          // from the service's answer rather than from the click.
          await tray?.refreshStartupState();
          return state.installed;
        }),
      quit: () => void lifecycle.shutdown(),
    },
    ...windowIcon(appRoot, resourcesPath),
  });

  // The startup task can be created or removed by the service at any time, so
  // the checkbox is refreshed once the tray exists rather than staying stale.
  void tray.refreshStartupState();

  app.on('second-instance', () => revealWindow());
  app.on('window-all-closed', () => {
    lifecycle.handleWindowAllClosed();
  });
  process.stdout.write(`desktop target: ${hosted.target.kind} ${hosted.target.url}\n`);
}


export interface PreloadPathOptions {
  readonly appRoot: string;
  readonly resourcesPath?: string;
}

/** The packaged build copies the preload next to the asar; the dev tree keeps it in src. */
export function resolvePreloadPath(options: PreloadPathOptions): string {
  if (options.resourcesPath !== undefined && options.resourcesPath.trim().length > 0) {
    return resolve(options.resourcesPath, 'preload.cjs');
  }
  return resolve(options.appRoot, 'src', 'preload.cjs');
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Selbstlauf Console</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1120; color: #e2e8f0; font: 15px/1.6 "Segoe UI", system-ui, sans-serif; }
      main { max-width: 32rem; padding: 2rem; text-align: center; }
      code { background: #1e293b; border-radius: 4px; padding: 0.15rem 0.4rem; font-size: 0.9em; }
    </style>
  </head>
  <body>
    <main>
      <h1>Selbstlauf Console</h1>
      <p>The local continuation watchdog is not running.</p>
      <p>Start it with <code>scripts/continuation/start-watchdog.ps1</code>, then reopen this window.</p>
    </main>
  </body>
</html>`;

// Electron sets process.argv[1] to the app directory (".") or the script path while the
// module is imported, and omits it entirely for a packaged launch.
if (isMainModule(process.argv, import.meta.url, { isPackaged: isPackagedProcess() })) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

/** Electron defines resourcesPath only in a packaged build. */
function isPackagedProcess(): boolean {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  return typeof resourcesPath === 'string' && resourcesPath.length > 0;
}

/**
 * True when this module is the process entry point.
 *
 * Electron passes the script path or the app directory in argv[1] for unpackaged
 * launches ("electron ." / "electron dist/src/main.js"), but a packaged app is
 * started from its executable with no script argument at all. A packaged process
 * therefore counts as the entry whenever resourcesPath is set, which Electron only
 * defines for packaged builds.
 */
export function isMainModule(
  argv: readonly string[] = process.argv,
  moduleUrl: string = import.meta.url,
  options: { readonly isPackaged?: boolean } = {},
): boolean {
  const entry = argv[1];
  const self = fileURLToPath(moduleUrl);
  if (entry !== undefined && entry.length > 0) {
    const candidate = resolve(entry);
    if (candidate === self) return true;
    // "electron ." passes the app directory; the entry module lives in its dist tree.
    if (resolve(candidate, 'dist', 'src', 'main.js') === self) return true;
  }
  if (options.isPackaged !== true) return false;
  // A packaged launch has no script argument, so the module path is the only
  // signal left: the packaged layout always places the main script at
  // dist/src/main.js (inside app.asar), and no other shipped module lives there.
  return self.replaceAll('\\', '/').endsWith('/dist/src/main.js');
}

