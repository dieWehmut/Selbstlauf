import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(appRoot, 'package.json'));
// The service lives outside app.asar in packaged desktop builds. Its pure-JS runtime dependency must too.
const packageRoot = dirname(require.resolve('ws/package.json'));
const target = resolve(appRoot, 'dist', 'node_modules', 'ws');
await mkdir(target, { recursive: true });
for (const name of ['package.json', 'index.js', 'wrapper.mjs', 'lib', 'LICENSE']) {
  await cp(resolve(packageRoot, name), resolve(target, name), { recursive: true });
}
