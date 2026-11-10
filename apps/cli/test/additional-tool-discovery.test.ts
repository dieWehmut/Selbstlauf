import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectProcessTool, groupProcesses } from '../src/process/discovery.js';
import { parseWslProcessLine } from '../src/process/wsl-processes.js';
import type { RawProcessRecord } from '../src/process/process-provider.js';

const sid = 'S-1-5-21-monitor-fixture';
function record(overrides: Partial<RawProcessRecord> = {}): RawProcessRecord {
  return {
    pid: 100, parentPid: 1, name: 'node.exe', commandLine: null,
    executablePath: 'C:\\Tools\\node.exe', creationTimeMs: 1,
    userSid: sid, workingDirectory: 'C:\\projects\\one', ...overrides,
  };
}

test('Gemini CLI recognizes installed package entries and extensionless launchers', () => {
  const signatures = [
    'node "C:/Users/u/AppData/Roaming/npm/node_modules/@google/gemini-cli/dist/index.js"',
    'node /home/u/.npm/_npx/123/node_modules/@google/gemini-cli/bundle/gemini.js',
    'node --inspect=9229 /usr/local/bin/gemini',
    'bun /usr/local/lib/node_modules/@google/gemini-cli/dist/index.js',
  ];
  assert.deepEqual(signatures.map(commandLine => detectProcessTool(record({ commandLine }))), signatures.map(() => 'gemini'));
  assert.equal(detectProcessTool(record({ name: 'gemini.exe', executablePath: 'C:\\tools\\gemini.exe' })), 'gemini');
});

test('new tools require actual entry points, not mentions in prompts, evals, or arbitrary paths', () => {
  const neutral = [
    'node tools/report.js "@google/gemini-cli/dist/index.js"',
    'node -e "require(\'@google/gemini-cli/dist/index.js\')"',
    'node --eval="console.log(1)" /usr/local/bin/gemini',
    'node --import @google/gemini-cli/dist/index.js tools/report.js',
    'powershell.exe -Command "Get-ChildItem C:/tools/cursor-agent/versions/1/index.js"',
    'node C:/tools/prefix@google/gemini-cli/dist/index.js',
    'node C:/tools/@google/gemini-cli/dist/index.js-helper',
    'node scripts/index.js --tool=antigravity --model=gemini',
  ];
  assert.deepEqual(neutral.map(commandLine => detectProcessTool(record({ commandLine }))), neutral.map(() => null));
  assert.equal(detectProcessTool(record({ name: 'agent.exe', executablePath: 'C:/other/agent.exe', commandLine: 'agent.exe cursor' })), null);
});

test('Cursor CLI alias agent requires the Cursor-owned installation path', () => {
  const aliases: Partial<RawProcessRecord>[] = [
    { name: 'cursor-agent.exe', executablePath: 'C:/Users/u/AppData/Local/cursor-agent/cursor-agent.exe' },
    { name: 'agent.exe', executablePath: 'C:/Users/u/AppData/Local/cursor-agent/agent.exe' },
    { name: 'agent.exe', executablePath: null, commandLine: '"C:/Users/u/AppData/Local/cursor-agent/agent.exe" --resume abc' },
    { name: 'node', executablePath: null, commandLine: 'node /home/u/.local/share/cursor-agent/versions/2026.11.05/index.js --resume abc' },
    { name: 'bash', executablePath: null, commandLine: 'bash /home/u/.local/bin/cursor-agent' },
  ];
  assert.deepEqual(aliases.map(value => detectProcessTool(record(value))), aliases.map(() => 'cursor'));
  assert.equal(detectProcessTool(record({ name: 'agent.exe', executablePath: 'C:/other/prefixcursor-agent/agent.exe' })), null);
  assert.equal(detectProcessTool(record({ name: 'cursor-agent.exe', executablePath: 'C:/tools/cursor-agent.exe', commandLine: 'cursor-agent.exe -p "--type=renderer"' })), 'cursor');
});

test('editor roots are monitored but Electron renderer, GPU and utility workers are neutral', () => {
  for (const name of ['Cursor.exe', 'Antigravity.exe']) {
    const root = record({ name, executablePath: `C:/tools/${name}`, commandLine: `"C:/tools/${name}"` });
    assert.equal(detectProcessTool(root), name.startsWith('Cursor') ? 'cursor' : 'antigravity');
    for (const arg of ['--type=renderer', '--type=gpu-process', '--type utility', '--crashpad-handler']) {
      assert.equal(detectProcessTool({ ...root, commandLine: `${root.commandLine} ${arg}` }), null, `${name} ${arg}`);
    }
  }
});

test('Cursor Electron Node workers are neutral even when the process image is Cursor.exe', () => {
  const base = record({ name: 'Cursor.exe', executablePath: 'C:/Programs/Cursor/Cursor.exe' });
  const workerCommands = [
    'Cursor.exe --dns-result-order=ipv4first --experimental-network-inspection C:/Programs/Cursor/resources/app/extensions/cursor-always-local/dist/gitWorker.js',
    'Cursor.exe C:/Programs/Cursor/resources/app/extensions/json-language-features/server/dist/node/jsonServerMain --node-ipc --clientProcessId=55',
  ];
  for (const commandLine of workerCommands) assert.equal(detectProcessTool({ ...base, commandLine }), null);
  assert.equal(detectProcessTool({ ...base, commandLine: 'Cursor.exe C:/projects/one/main.js' }), 'cursor');
  const daemon = 'C:/Programs/Cursor/resources/app/extensions/cursor-agent-host/dist/agent-host-daemon/dist/bin/daemon.cjs';
  assert.equal(detectProcessTool({ ...base, commandLine: `Cursor.exe ${daemon}` }), 'cursor');
});

test('dedicated desktop agent helpers require a complete owned entry path', () => {
  const daemon = '/opt/cursor/resources/app/extensions/cursor-agent-host/dist/agent-host-daemon/dist/bin/daemon.cjs';
  assert.equal(detectProcessTool(record({ commandLine: `node ${daemon}` })), 'cursor');
  assert.equal(detectProcessTool(record({ commandLine: `node scripts/report.js "${daemon}"` })), null);
  assert.equal(detectProcessTool(record({ commandLine: `node ${daemon}-helper` })), null);
  const helper = record({ name: 'language_server.exe', executablePath: 'C:/Programs/Antigravity/resources/bin/language_server.exe' });
  assert.equal(detectProcessTool(helper), 'antigravity');
  assert.equal(detectProcessTool({ ...helper, executablePath: 'C:/Programs/other/resources/bin/language_server.exe' }), null);
  assert.equal(detectProcessTool({ ...helper, executablePath: 'C:/CustomInstall/resources/bin/language_server.exe', ancestors: [{ pid: 1, name: 'Antigravity.exe' }] }), 'antigravity');
  assert.equal(detectProcessTool({ ...helper, name: 'language_server', executablePath: '/Applications/Antigravity.app/Contents/Resources/bin/language_server' }), 'antigravity');
});

test('desktop agent daemons fold through neutral intermediates and orphan helpers keep their product host', () => {
  const root = record({ name: 'Antigravity.exe', executablePath: 'C:/Programs/antigravity/Antigravity.exe' });
  const helper = record({ pid: 102, parentPid: 101, name: 'language_server.exe', executablePath: 'C:/Programs/antigravity/resources/bin/language_server.exe', ancestors: [{ pid: 101, name: 'helper.exe' }, { pid: 100, name: 'Antigravity.exe' }] });
  const sessions = groupProcesses([root, helper], { currentUserSid: sid });
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0]?.childPids, [102]);
  assert.equal(sessions[0]?.processKind, 'desktop');
  const orphan = groupProcesses([{ ...helper, ancestors: [] }], { currentUserSid: sid })[0];
  assert.equal(orphan?.host?.label, 'Antigravity');
  assert.equal(orphan?.host?.windowHandle, null);
  const daemon = record({ commandLine: 'node /opt/cursor/resources/app/extensions/cursor-agent-host/dist/agent-host-daemon/dist/bin/daemon.cjs --listen unix:///tmp/agent.sock' });
  const orphanCursor = groupProcesses([daemon], { currentUserSid: sid })[0];
  assert.equal(orphanCursor?.processKind, 'desktop');
  assert.equal(orphanCursor?.host?.label, 'Cursor');
  assert.equal(orphanCursor?.workingDirectory, daemon.workingDirectory);
});

test('custom executable names work without broadening the default names', () => {
  for (const tool of ['gemini', 'cursor', 'antigravity'] as const) {
    const item = record({ name: 'team-agent.exe', executablePath: 'C:/Tools/team-agent.exe' });
    assert.equal(detectProcessTool(item), null);
    assert.equal(detectProcessTool(item, { [`${tool}ExecutableNames`]: ['C:/Tools/team-agent.exe'] }), tool);
  }
});

test('known new entry points retain their tool when prompts or project paths name another CLI', () => {
  const prompt = '"inspect @openai/codex/bin/codex.js and @deepseek-ai/dsh/lib/bin.js and claude-code"';
  assert.equal(detectProcessTool(record({ commandLine: `node /usr/local/bin/gemini --prompt ${prompt}` })), 'gemini');
  assert.equal(detectProcessTool(record({ name: 'cursor-agent.exe', executablePath: 'C:/tools/cursor-agent.exe', commandLine: `cursor-agent.exe -p ${prompt}` })), 'cursor');
  assert.equal(detectProcessTool(record({ name: 'Antigravity.exe', executablePath: 'C:/tools/Antigravity.exe', commandLine: 'Antigravity.exe C:/projects/claude-code' })), 'antigravity');
  const alias = record({ name: 'team-agent.exe', executablePath: 'C:/tools/team-agent.exe' });
  assert.equal(detectProcessTool(alias, { geminiExecutableNames: ['team-agent.exe'], claudeExecutableNames: ['team-agent.exe'] }), null);
});

test('Cursor desktop and a nested CLI stay independent while CLI helpers fold into the CLI root', () => {
  const records = [
    record({ pid: 100, name: 'Cursor.exe', executablePath: 'C:/tools/Cursor.exe', commandLine: 'Cursor.exe C:/projects/editor' }),
    record({ pid: 101, parentPid: 100, name: 'Cursor.exe', executablePath: 'C:/tools/Cursor.exe', commandLine: 'Cursor.exe --type=renderer', ancestors: [{ pid: 100, name: 'Cursor.exe' }] }),
    record({ pid: 102, parentPid: 101, name: 'cursor-agent.exe', executablePath: 'C:/tools/cursor-agent.exe', commandLine: 'cursor-agent.exe --cwd C:/projects/cli', ancestors: [{ pid: 101, name: 'Cursor.exe' }, { pid: 100, name: 'Cursor.exe' }] }),
    record({ pid: 103, parentPid: 102, name: 'node.exe', commandLine: 'node C:/Users/u/AppData/Local/cursor-agent/versions/1/index.js', ancestors: [{ pid: 102, name: 'cursor-agent.exe' }, { pid: 101, name: 'Cursor.exe' }, { pid: 100, name: 'Cursor.exe' }] }),
    record({ pid: 104, name: 'cursor-agent.exe', executablePath: 'C:/tools/cursor-agent.exe', commandLine: 'cursor-agent.exe --cwd C:/projects/independent' }),
  ];
  const sessions = groupProcesses(records, { currentUserSid: sid });
  assert.deepEqual(sessions.map(({ tool, rootPid, childPids, processKind }) => ({ tool, rootPid, childPids, processKind })), [
    { tool: 'cursor', rootPid: 100, childPids: [], processKind: 'desktop' },
    { tool: 'cursor', rootPid: 102, childPids: [103], processKind: 'cli' },
    { tool: 'cursor', rootPid: 104, childPids: [], processKind: 'cli' },
  ]);
  assert.deepEqual(sessions.map(item => item.workingDirectory), ['C:/projects/editor', 'C:/projects/cli', 'C:/projects/independent']);
});

test('nested GUI roots keep their own windows and absorb only their nearest dedicated helpers', () => {
  for (const tool of ['cursor', 'antigravity'] as const) {
    const name = tool === 'cursor' ? 'Cursor.exe' : 'Antigravity.exe';
    const gui = (pid: number, parentPid: number, ancestors: RawProcessRecord['ancestors']) => record({
      pid, parentPid, name, executablePath: `C:/Programs/${tool}/${name}`,
      commandLine: `${name} --user-data-dir C:/profiles/${pid} C:/projects/${pid}`,
      ancestors,
      windows: [{ handle: pid * 10, pid, processName: name, title: `${tool} ${pid}`, className: 'Chrome_WidgetWin_1', visible: true }],
    });
    const helper = tool === 'cursor'
      ? record({ pid: 202, parentPid: 201, commandLine: 'node C:/Programs/cursor/resources/app/extensions/cursor-agent-host/dist/agent-host-daemon/dist/bin/daemon.cjs' })
      : record({ pid: 202, parentPid: 201, name: 'language_server.exe', executablePath: 'C:/Programs/antigravity/resources/bin/language_server.exe' });
    const sessions = groupProcesses([
      gui(100, 1, []),
      gui(200, 100, [{ pid: 100, name }]),
      { ...helper, ancestors: [{ pid: 201, name: 'worker.exe' }, { pid: 200, name }, { pid: 100, name }] },
    ], { currentUserSid: sid });
    assert.deepEqual(sessions.map(({ rootPid, childPids, workingDirectory, host }) => ({ rootPid, childPids, workingDirectory, window: host?.windowHandle })), [
      { rootPid: 100, childPids: [], workingDirectory: 'C:/projects/100', window: 1000 },
      { rootPid: 200, childPids: [202], workingDirectory: 'C:/projects/200', window: 2000 },
    ], tool);
  }
});

test('an unassociated detached Cursor daemon remains distinct from multiple GUI roots and a standalone CLI', () => {
  const desktop = (pid: number, project: string) => record({ pid, name: 'Cursor.exe', executablePath: 'C:/Programs/Cursor/Cursor.exe', commandLine: `Cursor.exe C:/projects/${project}` });
  const sessions = groupProcesses([
    desktop(100, 'one'), desktop(200, 'two'),
    record({ pid: 300, parentPid: 1, workingDirectory: 'C:/Users/u', commandLine: 'node C:/Programs/Cursor/resources/app/extensions/cursor-agent-host/dist/agent-host-daemon/dist/bin/daemon.cjs --listen unix:///tmp/daemon.sock' }),
    record({ pid: 400, parentPid: 300, name: 'cursor-agent.exe', executablePath: 'C:/tools/cursor-agent.exe', commandLine: 'cursor-agent.exe --cwd C:/projects/cli', ancestors: [{ pid: 300, name: 'node.exe' }] }),
    record({ pid: 401, parentPid: 400, commandLine: 'node C:/Users/u/.local/share/cursor-agent/versions/1/index.js', ancestors: [{ pid: 400, name: 'cursor-agent.exe' }, { pid: 300, name: 'node.exe' }] }),
  ], { currentUserSid: sid });
  assert.deepEqual(sessions.map(({ rootPid, childPids, processKind, workingDirectory }) => ({ rootPid, childPids, processKind, workingDirectory })), [
    { rootPid: 100, childPids: [], processKind: 'desktop', workingDirectory: 'C:/projects/one' },
    { rootPid: 200, childPids: [], processKind: 'desktop', workingDirectory: 'C:/projects/two' },
    { rootPid: 300, childPids: [], processKind: 'desktop', workingDirectory: 'C:/Users/u' },
    { rootPid: 400, childPids: [401], processKind: 'cli', workingDirectory: 'C:/projects/cli' },
  ]);
  assert.ok(sessions.every(({ logicalId, threadId }) => logicalId === undefined && threadId === undefined));
});

test('desktop roots own their host window instead of borrowing Explorer', () => {
  const sessions = groupProcesses([
    record({
      name: 'Antigravity.exe', executablePath: 'C:/tools/Antigravity.exe', commandLine: 'Antigravity.exe',
      ancestors: [{ pid: 1, name: 'explorer.exe' }],
      windows: [{ handle: 3100, pid: 100, processName: 'Antigravity.exe', title: 'Antigravity - project', className: 'Chrome_WidgetWin_1', visible: true }],
    }),
  ], { currentUserSid: sid });
  assert.equal(sessions[0]?.host?.label, 'Antigravity');
  assert.equal(sessions[0]?.host?.processId, 100);
  assert.equal(sessions[0]?.host?.windowHandle, 3100);
});

test('explicit editor workspace paths skip settings directories and decode file URIs', () => {
  const item = record({ name: 'Cursor.exe', executablePath: 'C:/tools/Cursor.exe' });
  const cwd = (commandLine: string) => groupProcesses([{ ...item, commandLine }], { currentUserSid: sid })[0]?.workingDirectory;
  assert.equal(cwd('Cursor.exe --user-data-dir C:/Profiles/Cursor --new-window "C:/projects/My Project"'), 'C:/projects/My Project');
  assert.equal(cwd('Cursor.exe --folder-uri="file:///C:/projects/My%20Project"'), 'C:\\projects\\My Project');
  assert.equal(cwd('Cursor.exe --file-uri file:///C:/projects/My%20Project/readme.md'), 'C:\\projects\\My Project');
  assert.equal(cwd('Cursor.exe --folder-uri vscode-remote://wsl+Ubuntu/home/u/project'), item.workingDirectory);
});

test('WSL Gemini and Cursor CLI retain separate distribution identities and launcher directories', () => {
  const gemini = parseWslProcessLine('8\t1\tMainThread\tnode /usr/local/bin/gemini\t/home/u/gemini-project');
  const cursor = parseWslProcessLine('9\t1\tMainThread\tnode /home/u/.local/share/cursor-agent/versions/1/index.js\t/home/u/cursor-project');
  assert(gemini && cursor);
  const sessions = groupProcesses([gemini, cursor], { distribution: 'Ubuntu', currentProcessId: 8 });
  assert.deepEqual(sessions.map(({ tool, rootPid, workingDirectory, distribution }) => ({ tool, rootPid, workingDirectory, distribution })), [
    { tool: 'gemini', rootPid: 8, workingDirectory: '/home/u/gemini-project', distribution: 'Ubuntu' },
    { tool: 'cursor', rootPid: 9, workingDirectory: '/home/u/cursor-project', distribution: 'Ubuntu' },
  ]);
});

test('a CLI prompt mentioning a working directory does not override the actual process directory', () => {
  const gemini = record({ commandLine: 'node /usr/local/bin/gemini --prompt "read --cwd C:/other/project please"' });
  assert.equal(groupProcesses([gemini], { currentUserSid: sid })[0]?.workingDirectory, gemini.workingDirectory);
  assert.equal(groupProcesses([{ ...gemini, commandLine: 'node /usr/local/bin/gemini --cwd "C:/real project"' }], { currentUserSid: sid })[0]?.workingDirectory, 'C:/real project');
});
