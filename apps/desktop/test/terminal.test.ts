import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openSessionTerminal, resolveTerminalCommand, windowsTerminalLaunchScript } from '../src/terminal.js';

const windows = { platform: 'win32' as const, env: { SystemRoot: 'C:\\Windows' }, findExecutable: async (command: string) => command };

test('Windows terminals open the service-resolved directory without interpolating it into a shell', async () => {
  const session = { id: 'test', sessionCwd: "C:\\Project 空格\\100% & 'literal'" };
  for (const preferred of ['cmd', 'powershell', 'windows-terminal']) {
    const command = await resolveTerminalCommand(session, preferred, windows);
    assert.equal(command.cwd, session.sessionCwd);
    assert.equal(command.terminal, preferred);
    if (preferred === 'cmd') assert.deepEqual(command.args, ['/d', '/k']);
    if (preferred === 'powershell') assert.deepEqual(command.args, ['-NoLogo', '-NoProfile', '-NoExit']);
    if (preferred === 'windows-terminal') assert.deepEqual(command.args, ['-d', session.sessionCwd]);
  }
});

test('WSL terminals preserve distribution and Linux directory as literal arguments', async () => {
  const session = { id: 'wsl', distribution: "Ubuntu Personal'", sessionCwd: "/home/han/项目 空格 '100%'" };
  const wt = await resolveTerminalCommand(session, 'windows-terminal', { ...windows, fallbackCwd: 'C:\\Users\\han' });
  assert.equal(wt.cwd, 'C:\\Users\\han');
  assert.deepEqual(wt.args, ['-d', wt.cwd, 'wsl.exe', '--distribution', session.distribution, '--cd', session.sessionCwd]);
  const ps = await resolveTerminalCommand(session, 'powershell', windows);
  const script = Buffer.from(ps.args.at(-1)!, 'base64').toString('utf16le');
  assert.equal(script, "& wsl.exe '--distribution' 'Ubuntu Personal''' '--cd' '/home/han/项目 空格 ''100%''' ".trim());
});

test('selected unavailable terminals fail visibly and system preference finds an available terminal', async () => {
  const options = { platform: 'linux' as const, env: { DISPLAY: ':99' }, findExecutable: async (command: string) => command === 'xterm' ? '/usr/bin/xterm' : null };
  assert.equal((await resolveTerminalCommand({ id: 'a', cwd: '/tmp' }, null, options)).terminal, 'xterm');
  await assert.rejects(resolveTerminalCommand({ id: 'a', cwd: '/tmp' }, 'konsole', options), /未找到终端/u);
  await assert.rejects(resolveTerminalCommand({ id: 'a', cwd: '/tmp' }, 'powershell', options), /当前系统不支持/u);
  await assert.rejects(resolveTerminalCommand({ id: 'a', cwd: '/tmp' }, 'system', { ...options, env: {} }), /没有图形桌面/u);
});

test('Windows visible-console launcher quotes paths and argv without PowerShell interpolation', () => {
  const script = windowsTerminalLaunchScript({ executable: "C:\\Program Files\\Terminal's\\wt.exe", cwd: "C:\\项目\\100% & $(literal)'", args: ['-d', "C:\\项目\\100% & $(literal)'", 'a"b', 'trailing\\'], terminal: 'windows-terminal' });
  assert.ok(script.includes("-FilePath 'C:\\Program Files\\Terminal''s\\wt.exe'"));
  assert.ok(script.includes("-WorkingDirectory 'C:\\项目\\100% & $(literal)'''"));
  assert.ok(script.includes('"a\\"b"'));
  assert.ok(script.includes('"trailing\\\\"'));
  assert.ok(script.includes('-WindowStyle Normal -PassThru -ErrorAction Stop'));
});

test('unknown session and invalid directory cannot spawn an arbitrary terminal', async () => {
  const options = { sessions: async () => [{ id: 'a', cwd: 'relative' }], preference: async () => 'cmd', ...windows };
  assert.match((await openSessionTerminal('missing', options)).reason!, /已不在运行/u);
  assert.match((await openSessionTerminal('a', options)).reason!, /绝对路径/u);
  assert.match((await openSessionTerminal('', options)).reason!, /编号无效/u);
});

test('terminal launch really starts a detached process in the service-resolved working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-launch-'));
  const marker = join(root, 'launched.json');
  try {
    const result = await openSessionTerminal('agent-test', {
      sessions: async () => [{ id: 'agent-test', cwd: root }], preference: async () => 'xterm',
      platform: 'linux', env: { ...process.env, DISPLAY: ':test' },
      findExecutable: async () => process.execPath,
      spawnImpl: (command, _args, options) => {
        // The replacement executable records the real spawn's cwd; only the
        // terminal's drawing is replaced, the child process itself is real.
        return spawn(command, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd: process.cwd() }))`], options);
      },
    });
    assert.equal(result.ok, true);
    let text = '';
    for (let count = 0; count < 50; count++) {
      try { text = await readFile(marker, 'utf8'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.deepEqual(JSON.parse(text), { cwd: root });
  } finally { await rm(root, { recursive: true, force: true }); }
});

