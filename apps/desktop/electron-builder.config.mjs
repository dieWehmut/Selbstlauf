import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// This config lives in apps/desktop, so the app root is its own directory and
// the repository root is two levels up.
const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(appRoot, '..', '..');

const cliDist = path.join(repositoryRoot, 'apps', 'cli', 'dist');
const processProviderScript = path.join(repositoryRoot, 'apps', 'cli', 'src', 'process', 'windows-processes.ps1');
const windowFocusScript = path.join(repositoryRoot, 'apps', 'cli', 'src', 'process', 'window-focus.ps1');
const webDist = path.join(repositoryRoot, 'apps', 'web', 'dist');
const continuationScripts = path.join(repositoryRoot, 'scripts', 'continuation');
const preload = path.join(appRoot, 'src', 'preload.mjs');
const icon = path.join(appRoot, 'build', 'icon.ico');

for (const [label, target] of [
  ['apps/cli/dist', cliDist],
  ['apps/cli/src/process/windows-processes.ps1', processProviderScript],
  ['apps/cli/src/process/window-focus.ps1', windowFocusScript],
  ['apps/web/dist', webDist],
  ['scripts/continuation', continuationScripts],
]) {
  if (!existsSync(target)) {
    throw new Error(`${label} is missing: ${target}\nRun "npm run build" before packaging the desktop app.`);
  }
}

export default {
  appId: 'tech.diesw.selbstlauf',
  productName: 'Selbstlauf',
  copyright: 'Selbstlauf contributors',
  directories: {
    // Overridable so a release build can write outside the checkout; the default
    // keeps local packaging output inside the ignored tmp/ directory.
    output: process.env.SELBSTLAUF_DESKTOP_OUTPUT ?? path.join(repositoryRoot, 'tmp', 'desktop-dist'),
    buildResources: path.join(appRoot, 'build'),
  },
  // Only the compiled desktop shell ships inside the asar; the watchdog service
  // and the WebUI live in resources so the service can be executed as a child
  // process and resolved through process.resourcesPath at runtime.
  files: [
    'dist/src/**/*',
    'src/preload.mjs',
    'package.json',
  ],
  extraResources: [
    { from: cliDist, to: 'service-dist' },
    // tsc never emits the PowerShell asset, and the service resolves it beside
    // its own module. Without this copy the installed app starts, serves its
    // WebUI, and silently discovers no process at all.
    { from: processProviderScript, to: 'service-dist/src/process/windows-processes.ps1' },
    // Same reason: the reveal action resolves its own PowerShell asset beside
    // the module, and an installed app without it cannot raise a session window.
    { from: windowFocusScript, to: 'service-dist/src/process/window-focus.ps1' },
    { from: webDist, to: 'web-dist' },
    // The logon-task script the watchdog registers must exist in the installed
    // app; start-watchdog.ps1 resolves service-dist and web-dist beside it.
    { from: continuationScripts, to: 'scripts/continuation' },
    { from: preload, to: 'preload.mjs' },
    // The window and tray both load the icon by absolute path, and the tray is
    // what makes closing the window hide instead of quit. Without this copy the
    // packaged app cannot build a tray at all, so 关闭即隐藏 silently degrades to
    // a real quit; electron-builder's `win.icon` only brands the executable, it
    // does not place the file in resources.
    ...(existsSync(icon) ? [{ from: icon, to: 'build/icon.ico' }] : []),
  ],
  asar: true,
  win: {
    target: [
      { target: 'nsis', arch: ['x64', 'arm64'] },
    ],
    ...(existsSync(icon) ? { icon } : {}),
  },
  nsis: {
    // Assisted per-user install: the watchdog itself is per-user (state under
    // %LOCALAPPDATA% and a per-user logon task), so installing into the user
    // profile keeps the whole product in one scope and needs no elevation.
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Selbstlauf',
    uninstallDisplayName: 'Selbstlauf',
    deleteAppDataOnUninstall: false,
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
    // Ship the app package as a zip instead of a 7z.
    //
    // The 7z payload is decoded by the bundled nsis7z plugin, whose 7-Zip
    // library predates the ARM64 branch filter: 7-Zip applies that filter to
    // the ARM64 binaries of an arm64 build, the plugin cannot decode those
    // entries, and it silently skips them (the installer exits 0 with
    // Selbstlauf.exe and every DLL missing). Zip cannot carry branch filters
    // and nsisunz is decoded by NSIS itself, which reports failures instead of
    // installing a partial app.
    useZip: true,
    // A zip payload has no block map, and this app has no auto-updater that
    // would consume one.
    differentialPackage: false,
  },
};
