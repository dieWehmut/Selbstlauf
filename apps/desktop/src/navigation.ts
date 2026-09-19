/** Window and navigation policy for the loopback-hosted Selbstlauf console. */

export interface WindowPolicyOptions {
  readonly serviceOrigin: string;
  readonly title?: string;
  readonly width?: number;
  readonly height?: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
}

export const DEFAULT_WINDOW_POLICY = Object.freeze({
  title: 'Selbstlauf Console',
  width: 1440,
  height: 900,
  minWidth: 960,
  minHeight: 640,
  backgroundColor: '#0b1120',
});

/**
 * The custom title bar contract, shared with the renderer.
 *
 * `height` is the number of device-independent pixels the OS window controls
 * (minimise / maximise-restore / close) occupy at the top-right of the window;
 * the renderer reserves that much space on the right of its own title bar row
 * and keeps everything else draggable. The colours describe the overlay strip
 * itself so the native buttons sit on the same surface as the page.
 */
export const TITLE_BAR_OVERLAY = Object.freeze({
  height: 40,
  /**
   * Matches the title bar the renderer paints.
   *
   * The bar is `--panel-soft`, which the app derives from the palette as
   * `mix(background, #ffffff, 0.004 + contrast/1400)`. For the built-in dark
   * palette (`#0d1216`, contrast 68) that resolves to `#1a1e22`. This static
   * value is the starting point so the strip lines up on first paint; the
   * renderer then reports the exact colour it used (see the
   * `setTitleBarOverlay` shell action) so a custom palette or the light theme
   * follows. A fixed `#0b1120` here was measurably wrong: it left the OS window
   * buttons on a visibly different strip from the rest of the row.
   */
  color: '#1a1e22',
  symbolColor: '#e9eef0',
});

export type TitleBarOverlay = typeof TITLE_BAR_OVERLAY;

export interface DesktopWebPreferences {
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly webviewTag: false;
}

export interface DesktopWindowOptions extends DesktopWebPreferences {
  readonly show: false;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly autoHideMenuBar: true;
  readonly backgroundColor: string;
  /**
   * The page draws the whole title bar row, so the OS chrome is hidden but the
   * native minimise / maximise-restore / close buttons stay real Windows
   * controls, right-aligned and hit-tested by the OS.
   */
  readonly titleBarStyle: 'hidden';
  readonly titleBarOverlay: TitleBarOverlay;
  /** Absolute path of the branded window/taskbar icon, when one is installed. */
  readonly icon?: string;
}

function parseOrigin(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/** True when a target URL belongs to the local service the window was opened on. */
export function isServiceUrl(target: string, serviceOrigin: string): boolean {
  if (typeof target !== 'string' || target.length === 0) return false;
  const expected = parseOrigin(serviceOrigin);
  if (expected === null) return false;
  let parsed: URL;
  try {
    parsed = new URL(target, serviceOrigin);
  } catch {
    return false;
  }
  return parsed.origin === expected.origin;
}

/** True for absolute http(s) links that belong in the user's normal browser. */
export function shouldOpenExternally(target: string): boolean {
  if (typeof target !== 'string' || target.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:';
}

export function createWindowOptions(options: WindowPolicyOptions): DesktopWindowOptions {
  if (parseOrigin(options.serviceOrigin) === null) {
    throw new TypeError('serviceOrigin must be an absolute http(s) origin');
  }
  return {
    show: false,
    title: options.title ?? DEFAULT_WINDOW_POLICY.title,
    width: options.width ?? DEFAULT_WINDOW_POLICY.width,
    height: options.height ?? DEFAULT_WINDOW_POLICY.height,
    minWidth: options.minWidth ?? DEFAULT_WINDOW_POLICY.minWidth,
    minHeight: options.minHeight ?? DEFAULT_WINDOW_POLICY.minHeight,
    autoHideMenuBar: true,
    backgroundColor: DEFAULT_WINDOW_POLICY.backgroundColor,
    // The window frame is drawn by the page from the second row down; only the
    // window controls stay native so snapping, Aero Snap, and hit-testing keep
    // working the way Windows users expect.
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLE_BAR_OVERLAY,
    // The window only ever renders the local service bundle, so Node stays out of
    // the renderer and the sandbox stays on.
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  };
}

export interface NavigationPolicyTarget {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): void;
  on(event: 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): void;
}

export interface NavigationPolicyOptions {
  readonly webContents: NavigationPolicyTarget;
  readonly serviceOrigin: string;
  readonly openExternal: (url: string) => void;
}

/** Keep every in-window navigation on the local service; send everything else out. */
export function applyNavigationPolicy(options: NavigationPolicyOptions): void {
  const { webContents, serviceOrigin, openExternal } = options;

  webContents.setWindowOpenHandler(({ url }) => {
    if (!isServiceUrl(url, serviceOrigin) && shouldOpenExternally(url)) openExternal(url);
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    if (isServiceUrl(url, serviceOrigin)) return;
    event.preventDefault();
    if (shouldOpenExternally(url)) openExternal(url);
  });

  webContents.on('will-attach-webview', (event) => event.preventDefault());
}

