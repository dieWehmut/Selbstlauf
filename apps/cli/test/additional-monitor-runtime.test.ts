import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/domain/config.js';
import { ConfigStore } from '../src/store/config-store.js';
import { AuditStore } from '../src/store/audit-store.js';
import { WatchdogController } from '../src/runtime/watchdog-controller.js';
import { associateObservedGroups, cursorUserDataDirectory } from '../src/monitoring/association.js';
import type { ObservedToolSession } from '../src/monitoring/tool-sessions.js';
import type { DiscoveredProcessSession } from '../src/process/discovery.js';
import type { RawProcessRecord } from '../src/process/process-provider.js';

const group = (tool: 'gemini' | 'cursor' | 'antigravity', pid: number, cwd: string | null, desktop = false): DiscoveredProcessSession => ({
  tool, rootPid: pid, childPids: [], commandLine: null, executablePath: null, creationTimeMs: 10_000,
  userSid: null, workingDirectory: cwd, transportHint: 'unknown', processKind: desktop ? 'desktop' : 'cli',
});
const observation = (tool: 'gemini' | 'cursor' | 'antigravity', id: string, cwd: string, time = 11_000): ObservedToolSession => ({
  tool, id, cwds: [cwd], lastActivityAtMs: time, source: 'gemini-json', path: '/unused',
});

test('association isolates projects, rejects historical/ambiguous CLI conversations, and honors an explicit resume', () => {
  const process = group('gemini', 1, '/project');
  const old = observation('gemini', 'old', '/project', 1_000);
  const current = observation('gemini', 'current', '/project');
  const foreign = observation('gemini', 'foreign', '/other');
  assert.equal(associateObservedGroups([process], [old, current, foreign], 12_000)[0]!.session?.id, 'current');
  assert.equal(associateObservedGroups([process, group('gemini', 2, '/project')], [current], 12_000)[0]!.session, null);
  const resumed = { ...process, commandLine: 'gemini --resume old' };
  assert.equal(associateObservedGroups([resumed], [old, current], 12_000)[0]!.session?.id, 'old');
  const prompt = { ...process, commandLine: 'gemini --prompt "--resume old"' };
  assert.equal(associateObservedGroups([prompt], [old, current], 12_000)[0]!.session?.id, 'current');
  assert.equal(associateObservedGroups([{ ...process, commandLine: 'gemini --prompt "--resume"' }], [old, current], 12_000)[0]!.session?.id, 'current');
  assert.equal(associateObservedGroups([process], [{ ...old, runningTurn: true }], 12_000)[0]!.session, null);
});

test('Cursor matches its real project key only when known directories have no lossy collision', () => {
  const cli = group('cursor', 1, '/work/a_b');
  const transcript = { ...observation('cursor', 'chat', ''), cwds: [], projectSlug: 'work-a-b' };
  assert.equal(associateObservedGroups([cli], [transcript], 12_000)[0]!.session?.id, 'chat');
  const colliding = group('cursor', 2, '/work/a-b');
  assert(associateObservedGroups([cli, colliding], [transcript], 12_000).every(row => row.session === null));
  assert.equal(associateObservedGroups([cli], [{ ...transcript, cwds: ['/different'] }], 12_000)[0]!.session, null);
});

test('Cursor user-data profiles parse quoted paths and are scanned independently', async t => {
  assert.equal(cursorUserDataDirectory('Cursor.exe --user-data-dir="C:\\Profiles\\My Cursor"'), 'C:\\Profiles\\My Cursor');
  assert.equal(cursorUserDataDirectory('Cursor.exe --user-data-dir "/home/alice/custom profile"'), '/home/alice/custom profile');
  const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-monitor-profiles-'));
  const config = new ConfigStore(join(directory, 'config.json'));
  await config.save({ ...defaultConfig, enabled: false, processFilters: { ...defaultConfig.processFilters, sameUserOnly: false } });
  const profiles: string[] = [];
  let sharedNative = false;
  const controller = new WatchdogController({ configStore: config, auditStore: new AuditStore(join(directory, 'audit.jsonl')), platform: 'win32', currentProcessId: 99, now: () => 12_000,
    provider: { listProcesses: async () => ['C:\\Profiles\\One', 'C:\\Profiles\\Two'].map((profile, index) => ({
      pid: 10 + index, parentPid: 0, name: 'Cursor.exe', executablePath: 'C:\\Cursor.exe', commandLine: `Cursor.exe --user-data-dir="${profile}"`,
      creationTimeMs: 10_000, userSid: null, workingDirectory: '/project',
    })) },
    monitorLocations: { homeDirectory: directory },
    monitorScanner: async (tool, locations) => {
      profiles.push(locations.cursorUserDataDirectory!);
      return [{ ...observation(tool, 'copied-composer-uuid', '/project'), source: sharedNative ? 'cursor-agent-host' as const : 'cursor-composer' as const,
        path: sharedNative ? join(directory, '.cursor-agents', 'sessions', 'shared', 'meta.json') : `${locations.cursorUserDataDirectory}\\User\\globalStorage\\state.vscdb` }];
    },
  });
  t.after(async () => { await controller.stop(); await rm(directory, { recursive: true, force: true }); });
  await controller.poll();
  assert.deepEqual(profiles.sort(), ['C:\\Profiles\\One', 'C:\\Profiles\\Two']);
  const copied = (await controller.list()).filter(row => row.alive && row.conversationId);
  assert.equal(copied.length, 2);
  assert.notEqual(copied[0]!.id, copied[1]!.id);
  assert(copied.every(row => row.conversationId === 'copied-composer-uuid'));
  sharedNative = true;
  await controller.poll();
  await controller.poll();
  const shared = (await controller.list()).filter(row => row.alive && row.conversationId);
  assert.equal(shared.length, 1);
  assert.equal(shared[0]!.rootPid, 10);
});

test('shared Cursor recordings choose their workspace across profiles before claiming a source', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-monitor-profile-owner-'));
  const config = new ConfigStore(join(directory, 'config.json'));
  await config.save({ ...defaultConfig, enabled: false, processFilters: { ...defaultConfig.processFilters, sameUserOnly: false } });
  let reversed = false;
  let withCli = false;
  const roots = ['C:\\Profiles\\One', 'C:\\Profiles\\Two'].map((profile, index) => ({
    pid: 10 + index, parentPid: 0, name: 'Cursor.exe', executablePath: 'C:\\Cursor.exe', commandLine: `Cursor.exe --user-data-dir="${profile}"`,
    creationTimeMs: null, userSid: null, workingDirectory: index === 0 ? '/a' : '/b',
  }));
  let now = 12_000;
  const controller = new WatchdogController({ configStore: config, auditStore: new AuditStore(join(directory, 'audit.jsonl')), platform: 'win32', currentProcessId: 99, now: () => now,
    provider: { listProcesses: async () => [
      ...(reversed ? [...roots].reverse() : roots),
      ...(withCli ? [{ pid: 12, parentPid: 0, name: 'cursor-agent.exe', executablePath: 'C:\\tools\\cursor-agent.exe',
        commandLine: 'cursor-agent.exe --resume global-b', creationTimeMs: null, userSid: null, workingDirectory: '/b' }] : []),
    ] },
    monitorLocations: { homeDirectory: directory },
    monitorScanner: async (tool, locations) => [
      { ...observation(tool, 'global-b', '/b'), source: 'cursor-agent-host' as const, path: join(directory, '.cursor-agents', 'sessions', 'global-b', 'meta.json') },
      { ...observation(tool, 'global-outside', '/outside'), source: 'cursor-jsonl' as const, path: join(directory, '.cursor', 'projects', 'outside', 'agent-transcripts', 'global-outside.jsonl') },
      ...(locations.cursorUserDataDirectory === 'C:\\Profiles\\One' ? [{ ...observation(tool, 'profile-workspace', '/outside'),
        source: reversed ? 'cursor-jsonl' as const : 'cursor-composer' as const, cursorProfileDirectory: locations.cursorUserDataDirectory,
        path: reversed ? join(directory, '.cursor', 'projects', 'outside', 'profile-workspace.jsonl') : `${locations.cursorUserDataDirectory}\\User\\globalStorage\\state.vscdb` }] : []),
    ],
  });
  t.after(async () => { await controller.stop(); await rm(directory, { recursive: true, force: true }); });
  for (const order of [false, true, false]) {
    reversed = order;
    await controller.poll();
    const alive = (await controller.list()).filter(row => row.alive && row.conversationId);
    assert.equal(alive.find(row => row.conversationId === 'global-b')?.rootPid, 11, 'the shared /b recording belongs to profile Two');
    assert.equal(alive.find(row => row.conversationId === 'profile-workspace')?.rootPid, 10, 'profile-owned composer metadata retains its multiple workspaces');
    assert(!alive.some(row => row.conversationId === 'global-outside'), 'multiple profiles cannot guess the owner of global history');
    assert.equal(alive.length, 2);
    now = 60_000;
  }
  withCli = true;
  await controller.poll();
  const resumed = (await controller.list()).filter(row => row.alive && row.conversationId === 'global-b');
  assert.deepEqual(resumed.map(row => row.rootPid), [12], 'an explicit CLI resume reserves shared history before editor profiles');
});

test('desktop conversations keep one identity across helper roots and retain each workspace', () => {
  const editor = { ...group('cursor', 1, '/a', true), host: { processId: 1, executableName: 'Cursor.exe', label: 'Cursor', category: 'editor' as const, windowHandle: 10, windowTitle: 'Cursor' } };
  const daemon = group('cursor', 2, null, true);
  const records = [observation('cursor', 'a', '/a'), observation('cursor', 'b', '/b')];
  const first = associateObservedGroups([daemon, editor], records, 12_000).filter(row => row.session);
  assert.equal(first.length, 2);
  assert(first.every(row => row.group.rootPid === 1));
  assert.deepEqual(first.map(row => row.group.workingDirectory), ['/a', '/b']);
  const replacement = { ...editor, rootPid: 3, host: { ...editor.host, processId: 3 } };
  assert.deepEqual(associateObservedGroups([replacement], records, 12_000).map(row => row.group.logicalId), first.map(row => row.group.logicalId));
  const otherWindow = { ...editor, rootPid: 4, host: { ...editor.host, processId: 4 } };
  assert.equal(associateObservedGroups([otherWindow, editor], [records[0]!], 12_000).filter(row => row.session).length, 1);
});

test('unknown process start time uses first observation instead of expiring idle associations after five seconds', () => {
  const process = { ...group('gemini', 1, '/project'), creationTimeMs: null };
  const records = [observation('gemini', 'current', '/project')];
  assert.equal(associateObservedGroups([process], records, 60_000, new Map([[1, 12_000]]))[0]!.session?.id, 'current');
});

test('desktop conversations carry independent workspace/WSL identity without inventing a historical process', () => {
  const desktop = { ...group('cursor', 1, null, true), distribution: 'Ubuntu' };
  const rows = associateObservedGroups([desktop], [observation('cursor', 'a', '/a'), observation('cursor', 'b', '/b'), observation('cursor', 'old', '/old', 1_000)], 12_000);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]!.group.logicalId, rows[1]!.group.logicalId);
  assert.match(rows[0]!.group.logicalId!, /^wsl:Ubuntu:cursor:/);
  assert.deepEqual(rows.map(row => row.group.workingDirectory), ['/a', '/b']);
  assert.deepEqual(associateObservedGroups([], [observation('cursor', 'a', '/a')], 12_000), []);
});

test('runtime monitors all three products, updates activity, reads the associated transcript and never injects', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-monitors-'));
  const path = join(directory, 'session.json');
  await writeFile(path, JSON.stringify({ sessionId: 'gemini-session', projectHash: 'hash', messages: [
    { id: 'user', type: 'user', content: 'fixture request', timestamp: new Date(11_000).toISOString() },
    { id: 'model', type: 'gemini', content: 'fixture answer', timestamp: new Date(11_000).toISOString() },
  ] }));
  const config = new ConfigStore(join(directory, 'config.json'));
  await config.save({ ...defaultConfig, defaultIdleTimeoutMs: 1, processFilters: { ...defaultConfig.processFilters, sameUserOnly: false } });
  const processes: RawProcessRecord[] = [
    { pid: 11, parentPid: 0, name: 'node.exe', executablePath: 'C:\\node.exe', commandLine: 'node C:\\npm\\@google\\gemini-cli\\dist\\index.js', creationTimeMs: 10_000, userSid: null, workingDirectory: '/gemini' },
    { pid: 12, parentPid: 0, name: 'Cursor.exe', executablePath: 'C:\\Cursor.exe', commandLine: 'Cursor.exe', creationTimeMs: 10_000, userSid: null, workingDirectory: '/cursor' },
    { pid: 13, parentPid: 0, name: 'Antigravity.exe', executablePath: 'C:\\Antigravity.exe', commandLine: 'Antigravity.exe', creationTimeMs: 10_000, userSid: null, workingDirectory: '/antigravity' },
  ];
  const records = [
    { ...observation('gemini', 'gemini-session', '/gemini'), path, title: 'Gemini task', runningTurn: true },
    { ...observation('cursor', 'cursor-session', '/cursor'), title: 'Cursor task', runningTurn: false },
    { ...observation('antigravity', 'antigravity-session', '/antigravity'), title: 'Antigravity task', runningTurn: true },
  ];
  let now = 12_000;
  const audit = new AuditStore(join(directory, 'audit.jsonl'));
  const controller = new WatchdogController({ configStore: config, auditStore: audit, platform: 'win32', currentProcessId: 99,
    provider: { listProcesses: async () => processes }, now: () => now,
    monitorScanner: async tool => records.filter(row => row.tool === tool),
    monitorLocations: { homeDirectory: directory }, transportFactory: () => { throw Error('Monitoring must not probe an input transport'); },
  });
  t.after(async () => { await controller.stop(); await rm(directory, { recursive: true, force: true }); });
  await controller.poll();
  const sessions = await controller.list();
  assert.equal(sessions.length, 3);
  assert.deepEqual(sessions.map(row => row.tool).sort(), ['antigravity', 'cursor', 'gemini']);
  assert(sessions.every(row => row.transport === 'monitor-only' && row.lastDecision === 'monitoring'));
  const gemini = sessions.find(row => row.tool === 'gemini')!;
  assert.equal(gemini.runningTurn, true);
  assert.equal(sessions.find(row => row.tool === 'cursor')!.runningTurn, false);
  assert.deepEqual((await controller.output(gemini.id))!.entries.map(entry => entry.text), ['fixture request', 'fixture answer']);
  now = 14_000; records[0]!.lastActivityAtMs = 13_000;
  await controller.poll();
  assert.equal((await controller.list()).find(row => row.tool === 'gemini')!.lastActivityAtMs, 13_000);
  assert.equal((await controller.inject(gemini.id, 'should not send', false)).ok, false);
  await config.save({ ...await config.load(), enabled: false });
  await controller.poll();
  assert((await controller.list()).every(row => row.enabled && row.lastDecision === 'monitoring'));
  assert.equal(await controller.pause(gemini.id), true);
  assert.equal((await controller.list()).find(row => row.id === gemini.id)!.lastDecision, 'paused');
  assert.equal(await controller.resume(gemini.id), true);
  await config.save({ ...await config.load(), tools: { ...(await config.load()).tools, cursor: { enabled: false, normalPrompt: '继续' } } });
  await controller.poll();
  const disabled = (await controller.list()).find(row => row.tool === 'cursor' && row.alive)!;
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.lastDecision, 'disabled');
  processes.length = 0;
  await controller.poll();
  assert((await controller.list()).every(row => !row.alive && row.lastDecision === 'process-exited'));
});

test('WSL and Windows same-PID sessions read their own home, and one corrupt source does not stop other tools', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-monitors-wsl-'));
  const config = new ConfigStore(join(directory, 'config.json'));
  await config.save({ ...defaultConfig, enabled: false, wslDistribution: 'Ubuntu', processFilters: { ...defaultConfig.processFilters, sameUserOnly: false } });
  const calls: { tool: string; home: string }[] = [];
  const auditPath = join(directory, 'audit.jsonl');
  const controller = new WatchdogController({ configStore: config, auditStore: new AuditStore(auditPath), platform: 'win32', currentProcessId: 99, now: () => 12_000,
    provider: { listProcesses: async () => [
      { pid: 42, parentPid: 0, name: 'node.exe', executablePath: null, commandLine: 'node C:\\npm\\@google\\gemini-cli\\dist\\index.js', creationTimeMs: 10_000, userSid: null, workingDirectory: '/native' },
      { pid: 43, parentPid: 0, name: 'Cursor.exe', executablePath: 'C:\\Cursor.exe', commandLine: 'Cursor.exe', creationTimeMs: 10_000, userSid: null, workingDirectory: '/cursor' },
    ] },
    wslRun: async (_distribution, script) => script === 'printf %s "$HOME"' ? '/home/phone-qa' : script.includes('ps -eo') ? '42\t1\tnode\tnode /npm/@google/gemini-cli/dist/index.js\t/wsl\t\t0\n' : '',
    monitorLocations: { homeDirectory: directory },
    monitorScanner: async (tool, locations) => {
      calls.push({ tool, home: locations.homeDirectory });
      if (tool === 'cursor') throw Error('locked source');
      const inside = locations.homeDirectory.startsWith('\\\\wsl.localhost');
      return [observation(tool, inside ? 'wsl-session' : 'native-session', inside ? '/wsl' : '/native')];
    }, transportFactory: () => { throw Error('No new tool may probe input'); },
  });
  t.after(async () => { await controller.stop(); await rm(directory, { recursive: true, force: true }); });
  await controller.poll();
  await controller.poll();
  const sessions = await controller.list();
  assert.equal(sessions.find(row => row.id === 'gemini:42')!.conversationId, 'native-session');
  assert.equal(sessions.find(row => row.id === 'wsl:Ubuntu:gemini:42')!.conversationId, 'wsl-session');
  assert.equal(sessions.find(row => row.tool === 'cursor')!.lastDecision, 'association-required');
  assert(calls.some(call => call.home === '\\\\wsl.localhost\\Ubuntu\\home\\phone-qa'));
  const { readFile } = await import('node:fs/promises');
  const events = (await readFile(auditPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(events.filter(row => row.details?.reason === 'cursor-metadata: locked source').length, 1);
});

for (const blocked of ['processes', 'home'] as const) {
  test(`a stalled WSL ${blocked} probe cannot stop Windows tool monitoring`, { timeout: 3000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'selbstlauf-monitor-deadline-'));
    const config = new ConfigStore(join(directory, 'config.json'));
    const auditPath = join(directory, 'audit.jsonl');
    await config.save({ ...defaultConfig, enabled: false, wslDistribution: 'Stalled', processFilters: { ...defaultConfig.processFilters, sameUserOnly: false } });
    let cancelled = 0;
    const controller = new WatchdogController({ configStore: config, auditStore: new AuditStore(auditPath), platform: 'win32', currentProcessId: 99, now: () => 12_000,
      wslProbeTimeoutMs: 10,
      provider: { listProcesses: async () => [
        { pid: 11, parentPid: 0, name: 'node.exe', commandLine: 'node C:\\npm\\@google\\gemini-cli\\dist\\index.js', executablePath: null, creationTimeMs: 10_000, userSid: null, workingDirectory: '/gemini' },
        { pid: 12, parentPid: 0, name: 'Cursor.exe', commandLine: 'Cursor.exe', executablePath: 'C:\\Cursor.exe', creationTimeMs: 10_000, userSid: null, workingDirectory: '/cursor' },
        { pid: 13, parentPid: 0, name: 'Antigravity.exe', commandLine: 'Antigravity.exe', executablePath: 'C:\\Antigravity.exe', creationTimeMs: 10_000, userSid: null, workingDirectory: '/antigravity' },
      ] },
      wslRun: async (_distribution, script, signal) => {
        if ((blocked === 'home' && script === 'printf %s "$HOME"') || (blocked === 'processes' && script.includes('ps -eo'))) {
          signal?.addEventListener('abort', () => { cancelled++; }, { once: true });
          return new Promise<string>(() => undefined);
        }
        return '42\t1\tnode\tnode /npm/@google/gemini-cli/dist/index.js\t/wsl\t\t0\n';
      },
      monitorScanner: async (tool, locations) => locations.homeDirectory.startsWith('\\\\wsl.localhost') ? [] : [observation(tool, `${tool}-chat`, `/${tool}`)],
      transportFactory: () => { throw Error('Monitor probes must not create input transports'); },
    });
    t.after(async () => { await controller.stop(); await rm(directory, { recursive: true, force: true }); });
    await controller.poll();
    assert.equal(cancelled, 1);
    assert.equal(controller.status().lastPollAtMs, 12_000);
    const native = (await controller.list()).filter(row => row.alive && !row.distribution);
    assert.deepEqual(native.map(row => row.tool).sort(), ['antigravity', 'cursor', 'gemini']);
    assert(native.every(row => row.lastDecision === 'monitoring'));
    if (blocked === 'processes') {
      const { readFile } = await import('node:fs/promises');
      assert.match(await readFile(auditPath, 'utf8'), /wsl-discovery.*timed out/u);
    }
  });
}
