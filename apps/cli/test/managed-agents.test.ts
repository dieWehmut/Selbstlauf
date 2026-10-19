import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ManagedAgentSessions } from '../src/agents/managed-sessions.js';
import { AgentSessionError } from '../src/agents/types.js';
import { terminalCommand } from '../src/agents/catalog.js';

export const terminalFixture = fileURLToPath(new URL('./fixtures/agent-terminal.js', import.meta.url));

export async function waitForOutput(service: ManagedAgentSessions, id: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const data = service.output(id).data;
    if (pattern.test(data)) return data;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail(`Missing ${pattern}: ${service.output(id).data}`);
}

test('real PTYs keep each process, argv, Unicode input, resize and output replay independent', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent work dir '));
  const service = new ManagedAgentSessions({ defaultCwd: cwd });
  t.after(async () => { await service.stop(); await rm(cwd, { recursive: true, force: true }); });
  const first = await service.launch({ tool: 'claude', command: process.execPath, args: [terminalFixture, 'one two', 'a&b', '中文'], title: 'first' });
  const second = await service.launch({ tool: 'opencode', command: process.execPath, args: [terminalFixture], title: 'second' });
  assert.notEqual(first.pid, second.pid);
  assert.notEqual(first.id, second.id);
  const ready = await waitForOutput(service, first.id, /READY/);
  assert.match(ready, /"tty":true/u);
  assert.match(ready, /"args":\["one two","a&b","中文"\]/u);
  assert.equal(first.cwd, cwd);
  await waitForOutput(service, second.id, /READY/);
  const before = service.output(first.id).offset;
  service.input(first.id, '你好 🌍\rsecond line\r');
  service.input(second.id, 'only second\r');
  await waitForOutput(service, first.id, /REPLY second line/);
  await waitForOutput(service, second.id, /REPLY only second/);
  assert.match(service.output(first.id, before).data, /REPLY 你好 🌍/u);
  assert.doesNotMatch(service.output(first.id).data, /only second/u);
  assert.doesNotMatch(service.output(second.id).data, /你好/u);
  const complete = service.output(first.id);
  assert.equal(service.output(first.id, complete.offset).data, '');
  assert.equal(service.output(first.id, complete.offset + 100).reset, true);
  service.resize(first.id, 91, 27);
  service.input(first.id, 'size\r');
  await waitForOutput(service, first.id, /SIZE 91 27/);
  assert.throws(() => service.remove(first.id), { status: 409 });
  service.input(first.id, 'quit\r');
  const deadline = Date.now() + 5000;
  while (service.output(first.id).session.status !== 'exited' && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  assert.equal(service.output(first.id).session.exitCode, 7);
  assert.throws(() => service.input(first.id, 'wrong'), { status: 409 });
  service.remove(first.id);
  assert.throws(() => service.output(first.id), { status: 404 });
  assert.equal(service.list().length, 1);
});

test('limits retained output and preserves a valid reconnect cursor', async (t) => {
  const service = new ManagedAgentSessions({ maxOutputChars: 100 });
  t.after(() => service.stop());
  const session = await service.launch({ tool: 'custom', command: process.execPath, args: [terminalFixture] });
  await waitForOutput(service, session.id, /READY/);
  service.input(session.id, `${'终'.repeat(120)}\rmarker\r`);
  await waitForOutput(service, session.id, /REPLY marker/);
  const output = service.output(session.id, 0);
  assert.equal(output.reset, true);
  assert.ok(output.fromOffset > 0);
  assert.ok(output.data.length <= 100);
  assert.equal(output.fromOffset + output.data.length, output.offset);
  assert.equal(service.output(session.id, output.offset).data, '');
});

test('validates launch, input, dimensions and ownership before affecting any process', async (t) => {
  const service = new ManagedAgentSessions({ maxSessions: 1 });
  t.after(() => service.stop());
  for (const value of [null, [], { tool: 'unknown' }, { tool: 'custom' }, { tool: 'shell', cols: 0 },
    { tool: 'shell', args: 'echo hello' }, { tool: 'shell', args: [null] }, { tool: 'shell', command: 'bad\0command' }]) {
    await assert.rejects(service.launch(value), (error: unknown) => error instanceof AgentSessionError && error.status === 400);
  }
  await assert.rejects(service.launch({ tool: 'custom', command: 'selbstlauf-no-such-tool' }), /找不到命令/u);
  await assert.rejects(service.launch({ tool: 'shell', cwd: join(tmpdir(), 'selbstlauf-no-such-directory') }), /工作目录/u);
  const session = await service.launch({ tool: 'custom', command: process.execPath, args: [terminalFixture] });
  await assert.rejects(service.launch({ tool: 'shell' }), { status: 409 });
  assert.throws(() => service.input(session.id, ''), { status: 400 });
  assert.throws(() => service.input(session.id, 'x'.repeat(16385)), { status: 400 });
  assert.throws(() => service.input('claude:1234', 'bad'), { status: 404 });
  assert.throws(() => service.resize(session.id, 0, 20), { status: 400 });
  assert.throws(() => service.output(session.id, -1), { status: 400 });
  await service.terminate(session.id);
  assert.equal(service.output(session.id).session.status, 'exited');
  await service.stop();
  await assert.rejects(service.launch({ tool: 'shell' }), { status: 503 });
});

test('terminates an owned process group including its child', { skip: process.platform === 'win32' }, async (t) => {
  const service = new ManagedAgentSessions();
  t.after(() => service.stop());
  const session = await service.launch({ tool: 'custom', command: process.execPath, args: [terminalFixture] });
  await waitForOutput(service, session.id, /READY/);
  service.input(session.id, 'child\r');
  const output = await waitForOutput(service, session.id, /CHILD \d+/);
  const pid = Number(/CHILD (\d+)/u.exec(output)?.[1]);
  assert.ok(pid > 0);
  process.kill(pid, 0);
  await service.terminate(session.id);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    // A reaped child's disappearance can lag the PTY exit callback.
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.fail(`Child ${pid} survived terminal termination`);
});

test('Windows script launch preserves literal arguments without evaluating them', () => {
  const plan = terminalCommand('C:\\tool dir\\claude.ps1', ['say "hi"', "a'b", '$env:SECRET', 'a&b'], 'win32', {});
  const args = plan.args as string[];
  const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
  assert.match(script, /& 'C:\\tool dir\\claude.ps1'/u);
  assert.ok(script.includes("'say \"hi\"' 'a''b' '$env:SECRET' 'a&b'"));
  const batch = terminalCommand('C:\\tool dir\\opencode.cmd', ['one two', 'a&b'], 'win32', { ComSpec: 'cmd.exe' });
  assert.equal(batch.args, '/d /s /c ""C:\\tool dir\\opencode.cmd" "one two" "a&b""');
  assert.throws(() => terminalCommand('tool.cmd', ['%SECRET%'], 'win32', {}), { status: 400 });
});
