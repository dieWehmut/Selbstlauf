import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWatchdogProcess } from '../../apps/cli/dist/src/index.js';

// Run after building the CLI, mobile APK and :app:assembleDebugAndroidTest.
// Discovered sessions are disposable fixtures; the Shell is a real host PTY.
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = path.resolve(process.env.SELBSTLAUF_MOBILE_EVIDENCE ?? path.join(root, 'tmp/mobile-android-live'));
const adbPath = process.env.SELBSTLAUF_ADB ?? 'adb';
const serial = process.env.ANDROID_SERIAL;
if (!serial) throw new Error('Set ANDROID_SERIAL to the intended test device.');
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(path.join(tmpdir(), 'selbstlauf-mobile-live-'));
let session = {
  id: 'codex:native-qa', tool: 'codex', rootPid: 101, childPids: [],
  conversationId: 'native-qa', conversationTitle: 'Android 远控验收', goal: null,
  transport: 'codex-app-server', alive: true, enabled: true, paused: false,
  startedAtMs: 1, lastActivityAtMs: 2, sessionCwd: temporary, platform: process.platform,
};
let service;
let remotePort;

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(`${path.basename(command)} failed (${code}): ${output}`)));
  });
}
const adb = (...args) => run(adbPath, ['-s', serial, ...args]);
const devicePath = async (localPath) => process.platform === 'linux' && adbPath.endsWith('.exe')
  ? (await run('wslpath', ['-w', localPath])).trim() : localPath;

try {
  if ((await adb('get-state')).trim() !== 'device') throw new Error('The selected device is not online.');
  service = await startWatchdogProcess({
    stateDirectory: path.join(temporary, 'ai-cli-bypass/continuation'), port: 0,
    remote: { port: 0, name: 'Native QA' }, agentWorkingDirectory: temporary,
    claudeSettingsPath: path.join(temporary, '.claude/settings.json'),
    codexConfigPath: path.join(temporary, '.codex/config.toml'),
  }, {
    list: () => [session],
    pause: () => { session = { ...session, paused: true }; return true; },
    resume: () => { session = { ...session, paused: false }; return true; },
    focus: () => ({ ok: true }), inject: () => ({ ok: true }),
    output: () => ({ sessionId: session.id, state: 'ready', source: 'codex-rollout', entries: [
      { id: 'native-message', role: 'assistant', text: 'Android 远控链路已连接', timestampMs: 2 },
    ], truncated: false }),
  });
  remotePort = new URL(service.remoteGateway.url()).port;
  console.log(`Testing ${serial}: isolated gateway and real Shell PTY`);
  await adb('reverse', `tcp:${remotePort}`, `tcp:${remotePort}`);
  for (const relative of ['debug/app-debug.apk', 'androidTest/debug/app-debug-androidTest.apk']) {
    await adb('install', '-r', await devicePath(path.join(root, 'apps/mobile/android/app/build/outputs/apk', relative)));
  }
  const log = await adb('shell', 'am', 'instrument', '-w',
    '-e', 'class', 'de.diewehmut.selbstlauf.NativeBridgeTest',
    '-e', 'gateway', `http://127.0.0.1:${remotePort}`,
    '-e', 'code', service.remoteGateway.pairingCode().code,
    'de.diewehmut.selbstlauf.test/androidx.test.runner.AndroidJUnitRunner');
  await writeFile(path.join(evidence, 'instrumentation.log'), log);
  if (!/OK \(4 tests\)/u.test(log) || /FAILURES|Process crashed|INSTRUMENTATION_FAILED/u.test(log)) {
    throw new Error(`Native remote journey failed; inspect ${path.join(evidence, 'instrumentation.log')}`);
  }
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({
    serial, success: true, nativeTests: 4, sessionBackend: 'disposable fixture',
    terminalBackend: 'real host Shell PTY', link: 'adb reverse', physicalWifiVerified: false,
  }, null, 2) + '\n');
  console.log('Four native tests passed, including pairing, restored connection, session controls and real Shell input/output.');
} finally {
  if (remotePort) await adb('reverse', '--remove', `tcp:${remotePort}`).catch(() => undefined);
  await service?.stop();
  await rm(temporary, { recursive: true, force: true });
}
