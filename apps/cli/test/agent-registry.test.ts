import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentCatalog } from '../src/agents/catalog.js';
import { AGENT_TOOLS } from '../src/agents/types.js';
import { AGENT_REGISTRY } from '../src/agents/registry.js';
import { ManagedAgentSessions } from '../src/agents/managed-sessions.js';

test('the registry covers every current AgentRouter guide without duplicate identities', () => {
  const pages = [
    'claude-code', 'claude-code-vscode', 'codex', 'qwencode', 'opencode', 'openclaw', 'hermes', 'pi', 'crush',
    'cline', 'roocode', 'kilocode', 'claude-app', 'trae', 'zcode', 'workbuddy', 'craft-agents',
  ].map((page) => `https://agentrouter.org/docs/${page}.html`);
  const guides = AGENT_REGISTRY.flatMap((entry) => entry.guideUrls ?? []);
  for (const page of pages) assert.ok(guides.includes(page), page);
  assert.deepEqual(AGENT_REGISTRY.map((entry) => entry.id).sort(), [...AGENT_TOOLS].sort());
  assert.equal(new Set(AGENT_REGISTRY.map((entry) => entry.id)).size, AGENT_REGISTRY.length);
});

test('catalog preserves missing CLI choices and offers publisher guides for desktop and extension tools', async () => {
  const catalog = await agentCatalog('linux', { PATH: '' }, tmpdir());
  const windows = await agentCatalog('win32', { PATH: '' }, tmpdir());
  assert.match(catalog.tools.find((entry) => entry.id === 'hermes')!.installCommand!, /install\.sh/u);
  assert.match(windows.tools.find((entry) => entry.id === 'hermes')!.installCommand!, /install\.ps1/u);
  for (const id of ['qwen', 'openclaw', 'hermes', 'pi', 'crush', 'cline', 'kilo']) {
    const tool = catalog.tools.find((entry) => entry.id === id)!;
    assert.equal(tool.available, false, id);
    assert.equal(tool.launchable, true, id);
    assert.ok(tool.installCommand, id);
    assert.ok(tool.installUrl?.startsWith('https://'), id);
  }
  const service = new ManagedAgentSessions();
  for (const id of ['roo', 'claude-app', 'trae', 'zcode', 'workbuddy', 'workbuddy-intl', 'craft-agents', 'antigravity', 'cursor']) {
    const tool = catalog.tools.find((entry) => entry.id === id)!;
    assert.equal(tool.launchable, false, id);
    assert.equal(tool.available, false, id);
    assert.ok(tool.installUrl?.startsWith('https://'), id);
    assert.equal(tool.installCommand, undefined, 'desktop/extension tools are never invented npm packages');
    await assert.rejects(service.launch({ tool: id, command: process.execPath }), { status: 400 });
  }
  assert.equal(service.list().length, 0);
  await service.stop();
});

test('WorkBuddy editions retain distinct publisher installation choices without inventing CLI commands', async () => {
  const catalog = await agentCatalog('linux', { PATH: '' }, tmpdir());
  const domestic = catalog.tools.find((entry) => entry.id === 'workbuddy')!;
  const international = catalog.tools.find((entry) => entry.id === 'workbuddy-intl')!;
  assert.equal(domestic.label, 'WorkBuddy 国内版');
  assert.equal(international.label, 'WorkBuddy 国际版');
  assert.equal(domestic.installUrl, 'https://www.workbuddy.cn/');
  assert.equal(international.installUrl, 'https://www.workbuddy.ai/');
  assert.equal(domestic.docsUrl, 'https://www.workbuddy.cn/docs/workbuddy/');
  assert.equal(international.docsUrl, 'https://www.workbuddy.ai/docs/workbuddy/');
  assert.deepEqual(domestic.guideUrls, ['https://agentrouter.org/docs/workbuddy.html']);
  // AgentRouter's existing integration guide links to the domestic edition.
  // An international guide has not been published there.
  assert.equal(international.guideUrls, undefined);
  for (const edition of [domestic, international]) {
    assert.equal(edition.kind, 'desktop');
    assert.equal(edition.command, null);
    assert.equal(edition.launchable, false);
    assert.equal(edition.installCommand, undefined);
  }
});

test('OpenClaw starts the interactive TUI by default and honors an explicit argv override', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'registry executable '));
  const executable = join(directory, 'openclaw');
  await writeFile(executable, '#!/bin/sh\nprintf "ARG=%s\\n" "$@"\n');
  await chmod(executable, 0o755);
  const service = new ManagedAgentSessions({ env: { PATH: directory }, defaultCwd: directory });
  t.after(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
  const catalog = await service.catalog();
  assert.equal(catalog.tools.find((entry) => entry.id === 'openclaw')?.available, true);
  const first = await service.launch({ tool: 'openclaw' });
  const second = await service.launch({ tool: 'openclaw', args: ['doctor'] });
  assert.deepEqual(first.args, ['tui']);
  assert.deepEqual(second.args, ['doctor']);
  const deadline = Date.now() + 5000;
  while ((service.output(first.id).session.status !== 'exited' || service.output(second.id).session.status !== 'exited') && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.match(service.output(first.id).data, /ARG=tui/u);
  assert.match(service.output(second.id).data, /ARG=doctor/u);
});
