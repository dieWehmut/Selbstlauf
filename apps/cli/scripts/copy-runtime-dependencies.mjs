import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyRuntimeDependency } from './runtime-dependency-copy.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(appRoot, 'package.json'));
// The service lives outside app.asar in packaged desktop builds. Its pure-JS runtime dependency must too.
const packageRoot = dirname(require.resolve('ws/package.json'));
const target = resolve(appRoot, 'dist', 'node_modules', 'ws');
await copyRuntimeDependency(packageRoot, target);
