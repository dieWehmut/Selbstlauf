import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWatchdogProcess } from '../../apps/cli/dist/src/index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = await mkdtemp(join(tmpdir(), 'selbstlauf-agent-browser-'));
await mkdir(join(root, '.claude'), { recursive: true });
await mkdir(join(root, '.codex'), { recursive: true });
await writeFile(join(root, '.codex', 'config.toml'), '');
const handle = await startWatchdogProcess({
  port: Number(process.env.SELBSTLAUF_AGENT_TEST_PORT ?? 49381),
  stateDirectory: join(root, 'ai-cli-bypass', 'continuation'),
  claudeSettingsPath: join(root, '.claude', 'settings.json'),
  codexConfigPath: join(root, '.codex', 'config.toml'),
  agentWorkingDirectory: repositoryRoot,
  staticDirectory: join(repositoryRoot, 'apps', 'web', 'dist'),
}, { list: () => [], pause: () => false, resume: () => false, inject: () => ({ ok: false }) });
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await handle.stop();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
process.stdout.write(`${handle.server.url()}\n`);
