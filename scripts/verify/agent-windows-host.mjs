import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node-pty';
import { startWatchdogProcess } from '../../apps/cli/dist/src/index.js';
import { WatchdogController } from '../../apps/cli/dist/src/runtime/watchdog-controller.js';
import { ConfigStore } from '../../apps/cli/dist/src/store/config-store.js';
import { AuditStore } from '../../apps/cli/dist/src/store/audit-store.js';
import { defaultConfig } from '../../apps/cli/dist/src/domain/config.js';
import { PtyTransport } from '../../apps/cli/dist/src/transport/pty-transport.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = await mkdtemp(join(tmpdir(), 'selbstlauf-agent-browser-'));
await mkdir(join(root, '.claude'), { recursive: true });
await mkdir(join(root, '.codex'), { recursive: true });
await writeFile(join(root, '.codex', 'config.toml'), '');
const stateDirectory = join(root, 'ai-cli-bypass', 'continuation');
const projects = join(root, '.claude', 'projects');
await mkdir(join(projects, 'fixture'), { recursive: true });
await mkdir(stateDirectory, { recursive: true });
const transcript = join(projects, 'fixture', 'session.jsonl');
const createdAt = Date.now();
const pty = spawn(process.execPath, [join(repositoryRoot, 'apps/cli/dist/test/fixtures/recorded-agent.js'), transcript], {
  name: 'xterm-256color', cwd: repositoryRoot, cols: 80, rows: 24, env: process.env,
});
const output = new PassThrough();
pty.onData((data) => output.write(data));
const input = new Writable({ write(data, _encoding, callback) { try { pty.write(String(data)); callback(); } catch (error) { callback(error); } } });
const transport = new PtyTransport({ pid: pty.pid, input, output });
await new Promise((resolveReady, reject) => {
  const timer = setTimeout(() => reject(new Error('recorded PTY fixture did not start')), 5000);
  output.on('data', (data) => { if (String(data).includes('READY true')) { clearTimeout(timer); resolveReady(); } });
});
const configStore = new ConfigStore(join(stateDirectory, 'config.json'));
await configStore.save({ ...defaultConfig, dryRun: false, defaultIdleTimeoutMs: 600000 });
let handle;
const controller = new WatchdogController({
  configStore, auditStore: new AuditStore(join(stateDirectory, 'audit.jsonl')), platform: 'win32', currentProcessId: 50,
  claudeProjectsDirectory: projects, transportFactory: (session) => session.rootPid === pty.pid ? transport : null,
  // Discovery is controlled; both transport IO and the transcript are produced by the real child above.
  provider: { listProcesses: async () => [
    { pid: 50, parentPid: 1, name: 'node.exe', commandLine: 'node watchdog.js', executablePath: null, creationTimeMs: createdAt, userSid: 'fixture' },
    { pid: pty.pid, parentPid: 1, name: 'claude.exe', commandLine: `claude.exe --cwd "${repositoryRoot}"`, executablePath: null, creationTimeMs: createdAt, userSid: 'fixture' },
  ] }, publish: (event, data) => handle?.server.publish(event, data),
});
handle = await startWatchdogProcess({
  port: Number(process.env.SELBSTLAUF_AGENT_TEST_PORT ?? 49381),
  stateDirectory,
  claudeSettingsPath: join(root, '.claude', 'settings.json'),
  codexConfigPath: join(root, '.codex', 'config.toml'),
  agentWorkingDirectory: repositoryRoot,
  staticDirectory: join(repositoryRoot, 'apps', 'web', 'dist'),
}, controller);
await controller.start();
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await controller.stop();
  pty.kill(); input.destroy(); output.destroy();
  await handle.stop();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
process.stdout.write(`${handle.server.url()}\n`);
