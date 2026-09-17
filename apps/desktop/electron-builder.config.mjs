import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// This config lives in apps/desktop, so the app root is its own directory and
// the repository root is two levels up.
const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(appRoot, '..', '..');

const cliDist = path.join(repositoryRoot, 'apps', 'cli', 'dist');
const webDist = path.join(repositoryRoot, 'apps', 'web', 'dist');
const preload = path.join(appRoot, 'src', 'preload.mjs');
const icon = path.join(appRoot, 'build', 'icon.ico');

for (const [label, target] of [['apps/cli/dist', cliDist], ['apps/web/dist', webDist]]) {
  if (!existsSync(target)) {
    throw new Error(`${label} is missing: ${target}\nRun "npm run build" before packaging the desktop app.`);
  }
}

export default {
  appId: 'tech.diesw.selbstlauf',
  productName: 'Selbstlauf',
  copyright: 'Selbstlauf contributors',
  directories: {
    output: path.join(repositoryRoot, 'tmp', 'desktop-dist'),
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
    { from: webDist, to: 'web-dist' },
    { from: preload, to: 'preload.mjs' },
  ],
  asar: true,
  ...(existsSync(icon) ? { win: { icon } } : {}),
};
