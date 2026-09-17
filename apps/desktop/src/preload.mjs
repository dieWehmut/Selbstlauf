import { contextBridge } from 'electron';

// The renderer runs sandboxed with context isolation, so it receives display
// metadata only - never Node APIs, the file system, or the service origin.
contextBridge.exposeInMainWorld('selbstlaufDesktop', {
  platform: process.platform,
  versions: Object.freeze({
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  }),
});
