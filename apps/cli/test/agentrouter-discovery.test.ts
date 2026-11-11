import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, parseConfig } from '../src/domain/config.js';
import { MONITOR_ONLY_TOOL_NAMES } from '../src/domain/types.js';
import { detectProcessTool, groupProcesses } from '../src/process/discovery.js';
import type { RawProcessRecord } from '../src/process/process-provider.js';
import { WatchdogController } from '../src/runtime/watchdog-controller.js';
import { ConfigStore } from '../src/store/config-store.js';
import { AuditStore } from '../src/store/audit-store.js';

function processRecord(commandLine: string, overrides: Partial<RawProcessRecord> = {}): RawProcessRecord {
  return { pid: 10, parentPid: 0, name: 'node', executablePath: '/usr/bin/node', commandLine,
    creationTimeMs: 10_000, userSid: null, workingDirectory: '/project', ...overrides };
}

const cliEntries = [
  ['opencode', '/prefix/node_modules/opencode-ai/bin/opencode.exe'],
  ['qwen', '/prefix/node_modules/@qwen-code/qwen-code/cli-entry.js'],
  ['openclaw', '/prefix/node_modules/openclaw/openclaw.mjs'],
  ['pi', '/prefix/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'],
  ['pi', '/prefix/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'],
  ['crush', '/prefix/node_modules/@charmland/crush/run-crush.js'],
  ['cline', '/prefix/node_modules/cline/bin/cline'],
  ['kilo', '/prefix/node_modules/@kilocode/cli/bin/kilo'],
] as const;

test('AgentRouter CLIs require an executed official entry rather than prompt mentions or lookalike paths', () => {
  for (const [tool, entry] of cliEntries) {
    assert.equal(detectProcessTool(processRecord(`node "${entry}" -p "mentions @openai/codex claude-code"`)), tool, entry);
    for (const command of [`node report.js "${entry}"`, `node --eval "${entry}"`, `node --import "${entry}" report.js`,
      `node "${entry}-helper"`,
      // An exact launcher name (cline/kilo/opencode) remains sufficient even
      // when manually installed outside its package directory.
      ...(/\.(?:js|mjs)$/u.test(entry) ? [`node "${entry.replace('node_modules/', 'node_modules/prefix')}"`] : [])]) {
      assert.equal(detectProcessTool(processRecord(command)), null, command);
    }
    const windows = entry.replaceAll('/', '\\');
    assert.equal(detectProcessTool(processRecord(`node.exe "C:${windows}"`)), tool);
  }
  assert.equal(detectProcessTool(processRecord('python3 /venv/bin/hermes', { name: 'python3', executablePath: '/venv/bin/python3' })), 'hermes');
  assert.equal(detectProcessTool(processRecord('python3 -m hermes_cli.main', { name: 'python3', executablePath: '/venv/bin/python3' })), 'hermes');
  assert.equal(detectProcessTool(processRecord('python3 report.py --prompt hermes_cli.main', { name: 'python3' })), null);
  assert.equal(detectProcessTool(processRecord('node /prefix/bin/qwen', { arguments: ['node', '/prefix/bin/qwen', '--prompt', 'cline/bin/cline --cwd /fake'] })), 'qwen');
});

test('native agents and desktop roots are distinct, while Electron workers and shared extension hosts stay neutral', () => {
  for (const name of ['opencode', 'qwen', 'openclaw', 'hermes', 'pi', 'crush', 'cline', 'kilo']) {
    assert.equal(detectProcessTool(processRecord(name, { name: `${name}.exe`, executablePath: `C:/tools/${name}.exe` })), name);
  }
  for (const [tool, cached] of [['cline', '/npm/node_modules/cline/bin/.cline'], ['kilo', '/npm/node_modules/@kilocode/cli/bin/.kilo']] as const) {
    assert.equal(detectProcessTool(processRecord(cached, { name: `.${tool}`, executablePath: cached })), tool, 'publisher wrappers may run a cached native image');
    assert.equal(detectProcessTool(processRecord(cached, { name: `.${tool}`, executablePath: cached.replace('node_modules/', 'node_modules/prefix') })), null);
  }
  const desktops = [['trae', 'Trae.exe'], ['zcode', 'ZCode.exe'], ['workbuddy', 'WorkBuddy.exe'], ['craft-agents', 'Craft Agents.exe']] as const;
  for (const [tool, name] of desktops) {
    const record = processRecord(`"C:/Programs/${name}" "C:/work/one"`, { name, executablePath: `C:/Programs/${name}` });
    assert.equal(detectProcessTool(record), tool);
    const [group] = groupProcesses([record], { sameUserOnly: false });
    assert.equal(group?.processKind, 'desktop');
    assert.equal(group?.host?.category === 'editor' || group?.host?.category === 'desktop-app', true);
    assert.equal(group?.workingDirectory, 'C:/work/one');
    assert.equal(detectProcessTool({ ...record, commandLine: `${record.commandLine} --type=renderer` }), null);
    assert.equal(detectProcessTool({ ...record, commandLine: `"C:/Programs/${name}" C:/Programs/resources/app/worker.js` }), null);
  }
  const desktop = processRecord('"C:/Users/u/AppData/Local/AnthropicClaude/Claude.exe"', {
    name: 'Claude.exe', executablePath: 'C:/Users/u/AppData/Local/AnthropicClaude/Claude.exe' });
  assert.equal(detectProcessTool(desktop), 'claude-app');
  assert.equal(detectProcessTool({ ...desktop, commandLine: `${desktop.commandLine} --type=utility` }), null);
  assert.equal(detectProcessTool(processRecord('Claude.exe', { name: 'Claude.exe', executablePath: 'C:/npm/claude.exe' })), 'claude');
  const nativeCli = '/home/han/.local/share/claude/versions/2.1.278/claude';
  assert.equal(detectProcessTool(processRecord(nativeCli, { name: 'claude', executablePath: nativeCli })), 'claude', 'the native CLI install is distinct from Claude Desktop');
  assert.equal(detectProcessTool(processRecord('Claude.exe', { name: 'Claude.exe', executablePath: 'C:/Program Files/WindowsApps/Anthropic.Claude_1.0.0_x64/Claude.exe' })), 'claude-app');
  assert.equal(detectProcessTool(processRecord('Code.exe --extensionHost RooVeterinaryInc.roo-cline', { name: 'Code.exe', executablePath: 'C:/Code/Code.exe' })), null);
  assert.equal(detectProcessTool(processRecord('node /home/u/.vscode/extensions/rooveterinaryinc.roo-cline-3.0/dist/extension.js')), 'roo');
});

test('additional agents preserve older settings and reject malformed new monitor policies', () => {
  const legacy = structuredClone(defaultConfig) as unknown as { tools: Record<string, unknown> };
  for (const tool of MONITOR_ONLY_TOOL_NAMES) delete legacy.tools[tool];
  const parsed = parseConfig(legacy);
  for (const tool of MONITOR_ONLY_TOOL_NAMES) {
    assert.deepEqual(parsed.tools[tool], { enabled: true, normalPrompt: '继续' });
    assert(Object.isFrozen(parsed.tools[tool]));
    assert.equal(parseConfig({ ...defaultConfig, tools: { ...defaultConfig.tools, [tool]: { enabled: false, normalPrompt: 'continue' } } }).tools[tool]?.enabled, false);
    assert.throws(() => parseConfig({ ...defaultConfig, tools: { ...defaultConfig.tools, [tool]: { enabled: 'true', normalPrompt: 'continue' } } }), /enabled/u);
  }
});

test('new agents stay process-monitor-only without invented activity or transport probing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentrouter-runtime-'));
  const config = new ConfigStore(join(directory, 'config.json'));
  await config.save({ ...defaultConfig, defaultIdleTimeoutMs: 1, processFilters: { ...defaultConfig.processFilters, sameUserOnly: false } });
  let clock = 12_000;
  let alive = true;
  let probes = 0;
  let scans = 0;
  const controller = new WatchdogController({ configStore: config, auditStore: new AuditStore(join(directory, 'audit.jsonl')),
    platform: 'win32', currentProcessId: 99, now: () => clock,
    provider: { listProcesses: async () => alive ? cliEntries.map(([, entry], index) => processRecord(`node "${entry}"`, { pid: 10 + index })) : [] },
    transportFactory: () => { probes++; return null; }, monitorScanner: async () => { scans++; return []; },
  });
  t.after(async () => { await controller.stop(); await rm(directory, { recursive: true, force: true }); });
  await controller.poll();
  clock = 9_000_000;
  await controller.poll();
  const sessions = await controller.list();
  assert.equal(sessions.length, cliEntries.length);
  for (const session of sessions) {
    assert.equal(session.transport, 'monitor-only');
    assert.equal(session.lastDecision, 'monitoring');
    assert.equal(session.lastActivityAtMs, null);
    assert.equal(session.quietForMs, null);
    assert.equal(session.runningTurn, undefined);
    assert.equal(session.pendingPrompt, null);
    assert.match(session.transportError!, /transcript and input adapters/u);
    assert.equal((await controller.inject(session.id, 'continue', false)).ok, false);
    assert.equal((await controller.output(session.id))?.reason, 'transcript-format-unsupported');
  }
  assert.equal(probes, 0);
  assert.equal(scans, 0);
  await controller.configChanged(parseConfig({ ...defaultConfig, tools: { ...defaultConfig.tools, qwen: { enabled: false, normalPrompt: '继续' } } }));
  assert.equal((await controller.list()).find(session => session.tool === 'qwen')?.enabled, false);
  alive = false;
  await controller.poll();
  assert((await controller.list()).every(session => !session.alive && session.lastDecision === 'process-exited'));
});
