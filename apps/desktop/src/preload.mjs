import { contextBridge, ipcRenderer } from 'electron';

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
      color: colors?.color,
      symbolColor: colors?.symbolColor,
    }),
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