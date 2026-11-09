import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startWatchdogProcess } from '../src/index.js';
import type { SessionSnapshot } from '../src/domain/types.js';
import type { AgentOutput, AgentSessionView } from '../src/agents/types.js';

test('remote gateway controls the actual local session routes and a real managed PTY', { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'remote-integration-'));
  let session: SessionSnapshot = {
    id: 'codex:remote', tool: 'codex', rootPid: 101, childPids: [], conversationId: 'remote-thread',
    goal: null, transport: 'codex-app-server', alive: true, enabled: true, paused: false,
    startedAtMs: 1, lastActivityAtMs: 2,
  };
  let injected = '';
  let focused = false;
  const service = await startWatchdogProcess({
    stateDirectory: join(root, 'ai-cli-bypass', 'continuation'), port: 0,
    agentWorkingDirectory: root,
  }, {
    list: () => [session],
    pause: () => { session = { ...session, paused: true }; return true; },
    resume: () => { session = { ...session, paused: false }; return true; },
    inject: (_id, prompt) => { injected = prompt; return { ok: true }; },
    focus: () => { focused = true; return { ok: true }; },
    output: () => ({ sessionId: session.id, state: 'ready', source: 'codex-rollout', entries: [
      { id: 'message-1', role: 'assistant', text: '电脑上的会话记录', timestampMs: 2 },
    ], truncated: false }),
  });
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  const local = service.server.url();
  assert.equal(service.remoteGateway, undefined);
  const enable = () => fetch(`${local}/api/remote/enable`, {
    method: 'POST', headers: { origin: local, 'content-type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: 0, name: 'Live desktop' }),
  });
  assert.equal((await enable()).status, 200);
  const gateway = service.remoteGateway!;
  const pair = await fetch(`${gateway.url()}/remote/v1/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: gateway.pairingCode().code, device_name: 'Integration phone' }),
  });
  assert.equal(pair.status, 200);
  const { token } = await pair.json() as { token: string };
  const call = (path: string, method = 'GET', body?: unknown) => fetch(`${service.remoteGateway!.url()}/remote/v1${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const route = `/sessions/${encodeURIComponent(session.id)}`;
  assert.equal((await call(`${route}/pause`, 'POST')).status, 200);
  assert.equal(session.paused, true);
  assert.equal((await call(`${route}/resume`, 'POST')).status, 200);
  assert.equal(session.paused, false);
  assert.equal((await call(`${route}/inject`, 'POST', { prompt: '手机继续任务' })).status, 200);
  assert.equal(injected, '手机继续任务');
  assert.equal((await call(`${route}/focus`, 'POST')).status, 200);
  assert.equal(focused, true);
  const output = await (await call(`${route}/output`)).json() as { entries: { text: string }[] };
  assert.equal(output.entries[0]?.text, '电脑上的会话记录');
  assert.equal((await call('/watchdog/stop', 'POST')).status, 200);
  assert.equal((await (await call('/health')).json() as { running: boolean }).running, false);
  assert.equal((await call('/watchdog/start', 'POST')).status, 200);

  // A preset shell starts the repository's real PTY fixture without enabling
  // the gateway's forbidden custom-command interface.
  const fixture = fileURLToPath(new URL('./fixtures/agent-terminal.js', import.meta.url));
  const literal = (value: string) => process.platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = `${literal(process.execPath)} ${literal(fixture)}`;
  const args = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-Command', `& ${command}`] : ['-c', `exec ${command}`];
  const launch = await call('/agents', 'POST', { tool: 'shell', cwd: root, args });
  assert.equal(launch.status, 201);
  const agent = await launch.json() as AgentSessionView;
  const agentRoute = `/agents/${agent.id}`;
  assert.equal((await call(`${agentRoute}/resize`, 'POST', { cols: 80, rows: 24 })).status, 200);
  const waitForOutput = async (pattern: RegExp, after = 0): Promise<AgentOutput> => {
    const deadline = Date.now() + 5_000;
    let page: AgentOutput;
    do {
      const response = await call(`${agentRoute}/output?after=${after}`);
      assert.equal(response.status, 200);
      page = await response.json() as AgentOutput;
      if (pattern.test(page.data)) return page;
      await delay(30);
    } while (Date.now() < deadline);
    assert.match(page!.data, pattern);
    return page!;
  };
  const ready = await waitForOutput(/READY .*"tty":true/u);
  assert.equal((await call(`${agentRoute}/input`, 'POST', { data: '手机中文\r' })).status, 200);
  const first = await waitForOutput(/REPLY 手机中文/u, ready.offset);
  assert.equal((await call(`${agentRoute}/input`, 'POST', { data: 'reconnected\r' })).status, 200);
  const next = await waitForOutput(/REPLY reconnected/u, first.offset);
  assert.doesNotMatch(next.data, /REPLY 手机中文/u);
  assert.equal(next.session.cols, 80);
  assert.equal(next.session.rows, 24);
  const disabled = await fetch(`${local}/api/remote/disable`, { method: 'POST', headers: { origin: local } });
  assert.equal(disabled.status, 200);
  assert.equal(service.remoteGateway, undefined);
  const localAgents = await (await fetch(`${local}/api/agents`)).json() as { sessions: AgentSessionView[] };
  assert.equal(localAgents.sessions.find((entry) => entry.id === agent.id)?.status, 'running');
  assert.equal((await enable()).status, 200);
  assert.equal((await call(`${agentRoute}/output?after=${next.offset}`)).status, 200);
  assert.equal((await call(agentRoute, 'DELETE')).status, 409);
  assert.equal((await call(`${agentRoute}/interrupt`, 'POST')).status, 200);
  assert.equal((await call(`${agentRoute}/terminate`, 'POST')).status, 200);
  assert.equal((await call(agentRoute, 'DELETE')).status, 200);
  assert.equal((await call(`${agentRoute}/output`)).status, 404);
});
