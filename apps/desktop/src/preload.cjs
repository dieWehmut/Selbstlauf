/**
 * Preload bridge for the sandboxed renderer.
 *
 * This file is CommonJS (`require`), not ESM, and that is load-bearing. Electron
 * loads a preload into a *sandboxed* context, and a sandboxed preload cannot be an
 * ES module: with `import` statements it fails with "Cannot use import statement
 * outside a module", which takes the entire renderer bridge down with it —
 * `window.selbstlaufDesktop` becomes undefined, and because every call below is
 * fire-and-forget the window menus, the settings store and the title-bar colour
 * report all stop working with nothing in the log. Do not convert this file back
 * to ESM without also moving the window off `sandbox: true`.
 */
const { contextBridge, ipcRenderer } = require('electron');

// The renderer runs sandboxed with context isolation, so it receives display
// metadata and a small, explicitly enumerated set of window operations - never
// Node APIs, never `ipcRenderer` itself, and never a free-form channel name.
const SHELL_CHANNELS = Object.freeze({
  invoke: 'selbstlauf:shell',
  settingsGet: 'selbstlauf:settings:get',
  settingsSet: 'selbstlauf:settings:set',
  command: 'selbstlauf:command',
});

// Every action is named here rather than taking a channel argument, so the
// renderer cannot reach a channel this file does not name.
const invoke = (payload) => ipcRenderer.invoke(SHELL_CHANNELS.invoke, payload);

contextBridge.exposeInMainWorld('selbstlaufDesktop', {
  platform: process.platform,
  versions: Object.freeze({
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  }),
  shell: Object.freeze({
    reload: () => void invoke({ action: 'reload' }),
    toggleFullScreen: () => void invoke({ action: 'toggleFullScreen' }),
    zoom: (delta) => void invoke({ action: 'zoom', delta }),
    quit: () => void invoke({ action: 'quit' }),
    openExternal: (url) => invoke({ action: 'openExternal', url }),
    // The renderer paints the theme-aware title bar, so it reports the colour it
    // actually used and the native window-button strip is repainted to match.
    setTitleBarOverlay: (colors) => void invoke({
      action: 'setTitleBarOverlay',
      color: colors && colors.color,
      symbolColor: colors && colors.symbolColor,
    }),
    /**
     * Ask for a still of the window a watched session runs in.
     *
     * Takes a session id, never a window handle: the main process resolves the window through the
     * service's own session list, so the renderer cannot ask for a picture of an arbitrary
     * window. Unlike the actions above this one returns a value, so it is awaited.
     */
    windowPreview: (sessionId) => invoke({ action: 'windowPreview', sessionId }),
  }),
  settings: Object.freeze({
    get: () => ipcRenderer.invoke(SHELL_CHANNELS.settingsGet),
    set: (patch) => ipcRenderer.invoke(SHELL_CHANNELS.settingsSet, patch),
  }),
  /**
   * Subscribe to named commands from the menu bar and the tray.
   *
   * Returns an unsubscribe function so the renderer can detach on unmount; the
   * listener only ever receives the parsed command payload.
   */
  onCommand: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on(SHELL_CHANNELS.command, handler);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.command, handler);
  },
});