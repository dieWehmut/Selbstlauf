import assert from 'node:assert/strict';
import test from 'node:test';
import { detectProcessTool, groupProcesses } from '../src/process/discovery.js';
import type { RawProcessRecord } from '../src/process/process-provider.js';

function record(commandLine: string, overrides: Partial<RawProcessRecord> = {}): RawProcessRecord {
  return { pid: 10, parentPid: 0, name: 'node', executablePath: '/usr/bin/node', commandLine,
    creationTimeMs: 10_000, userSid: null, workingDirectory: '/project', ...overrides };
}

const entries = [
  ['claude', '/npm/node_modules/@anthropic-ai/claude-code/cli.js'],
  ['codex', '/npm/node_modules/@openai/codex/bin/codex.js'],
  ['dsh', '/npm/node_modules/@deepseek-ai/dsh/lib/bin.js'],
] as const;

test('legacy agents require an executed entry rather than prompt, eval, or preload text', () => {
  for (const [, entry] of entries) {
    for (const command of [`node report.js --prompt "inspect ${entry}"`, `node -e "console.log('${entry}')"`,
      `node --eval="console.log(1)" "${entry}"`, `node --import "${entry}" report.js`,
      `node --require "${entry}" report.js`]) {
      assert.equal(detectProcessTool(record(command)), null, command);
      assert.deepEqual(groupProcesses([record(command)], { sameUserOnly: false }), [], command);
    }
  }
});

test('a real legacy CLI keeps its identity when its prompt names other agents', () => {
  for (const [tool, entry] of entries) {
    assert.equal(detectProcessTool(record(`node "${entry}" --prompt "inspect claude-code @openai/codex @deepseek-ai/dsh/lib/bin.js"`)), tool);
  }
});

test('original argv boundaries establish the executed entry even when display text disagrees', () => {
  for (const [tool, entry] of entries) {
    assert.equal(detectProcessTool(record(`node ${entry}`, { arguments: ['node', 'report.js', `mentions ${entry}`] })), null);
    assert.equal(detectProcessTool(record('node report.js --prompt claude-code', {
      arguments: ['node', entry.replace('/npm/', '/npm with spaces/'), '--prompt', 'mentions @openai/codex'],
    })), tool);
  }
});

test('runtime option values and renamed process titles cannot impersonate agents', () => {
  const commands = [
    ['node', '--title', 'qwen', 'report.js'],
    ['node', '--title', 'openclaw', '--eval', 'console.log(1)'],
    ['node', '--conditions', 'cline', 'report.js'],
    ['node', '-C', 'kilo', 'report.js'],
    ['node', '--diagnostic-dir', '/npm/node_modules/@openai/codex', 'report.js'],
    ['node', '--experimental-config-file', 'qwen', 'report.js'],
    ['node', '--experimental-sea-config', 'openclaw', 'report.js'],
    ['node', '--experimental-package-map', 'cline', 'report.js'],
    ['node', '--unknown-runtime-option', 'qwen', 'report.js'],
  ];
  for (const args of commands) {
    assert.equal(detectProcessTool(record(args.join(' '), { arguments: args, name: 'qwen' })), null, args.join(' '));
  }
  for (const name of ['claude', 'codex.exe', 'dsh.exe', 'cursor-agent', 'Antigravity.exe', 'WorkBuddy.exe']) {
    assert.equal(detectProcessTool(record('node report.js', { name })), null, name);
  }
  for (const [tool, entry] of entries) {
    assert.equal(detectProcessTool(record('', { name: 'qwen', arguments: ['node', '--title', 'qwen', entry] })), tool);
  }
});

test('native CLI images and direct PowerShell script files retain their identities', () => {
  for (const tool of ['claude', 'codex', 'dsh'] as const) {
    assert.equal(detectProcessTool(record(`${tool} --prompt "@openai/codex claude-code"`, {
      name: tool, executablePath: `/tools/${tool}`,
    })), tool);
    assert.equal(detectProcessTool(record(`"C:/Tools/${tool}.exe"`, {
      name: `${tool}.exe`, executablePath: `C:/Tools/${tool}.exe`,
    })), tool);
    assert.equal(detectProcessTool(record(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:/npm/${tool}.ps1" --prompt "@openai/codex"`, {
      name: 'powershell.exe', executablePath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    })), tool);
  }
});

test('the observed Codex daemon pid maintenance loop is not a conversation or CLI session', () => {
  const executablePath = '/home/han/.codex/packages/app-server-daemon/releases/0.167.1-x86_64-unknown-linux-musl/bin/codex';
  const maintenance = record('', { pid: 2159, name: 'codex', executablePath,
    arguments: [executablePath, 'app-server', 'daemon', 'pid-update-loop'] });
  assert.equal(detectProcessTool(maintenance), null);
  assert.deepEqual(groupProcesses([maintenance], { distribution: 'Ubuntu-22.04' }), []);
  assert.equal(detectProcessTool({ ...maintenance, arguments: [executablePath, 'app-server', '--listen', 'unix:///run/codex.sock'] }), 'codex');
  assert.equal(detectProcessTool({ ...maintenance, arguments: [executablePath] }), 'codex');
  assert.equal(detectProcessTool({ ...maintenance, arguments: [executablePath, '--prompt', 'app-server daemon pid-update-loop'] }), 'codex');
  assert.equal(detectProcessTool(record('node /npm/node_modules/@openai/codex/bin/codex.js app-server daemon pid-update-loop')), null);
});

test('shell command strings do not establish the identity of the shell process', () => {
  for (const tool of ['claude', 'codex', 'dsh']) {
    const mentions = `/npm/node_modules/@openai/codex/bin/codex.js ${tool}.ps1`;
    for (const [name, commandLine] of [
      ['cmd.exe', `cmd.exe /d /s /c echo "${mentions}"`],
      ['powershell.exe', `powershell.exe -Command "Write-Output '${mentions}'"`],
      ['bash', `bash -c "echo '${mentions}'"`],
    ]) assert.equal(detectProcessTool(record(commandLine, { name, executablePath: `/tools/${name}` })), null, commandLine);
  }
});

test('conflicting configured native identities are still rejected', () => {
  const native = record('team-agent.exe', { name: 'team-agent.exe', executablePath: 'C:/Tools/team-agent.exe' });
  assert.equal(detectProcessTool(native, {
    claudeExecutableNames: ['team-agent.exe'], codexExecutableNames: ['team-agent.exe'], dshExecutableNames: ['team-agent.exe'],
  }), null);
});

test('other files inside a CLI package or repository do not identify its agent', () => {
  for (const entry of ['/npm/node_modules/@openai/codex/docs/report.js', '/npm/node_modules/@openai/codex/bin/runner.js',
    '/npm/node_modules/@anthropic-ai/claude-code/audit.js', '/work/claude-code/docs/report.js',
    '/work/deepseek-harness/apps/cli/lib/bin.js-helper']) {
    assert.equal(detectProcessTool(record(`node "${entry}"`)), null, entry);
  }
});

test('only agent argv can supply a working directory, including Windows quoted prompts', () => {
  const entry = entries[1][1];
  for (const commandLine of [`node -C qwen "${entry}"`, `node --title "--cwd=/fake" "${entry}"`,
    `node "${entry}" --prompt "--cwd=/fake"`, `node "${entry}" -- "--cwd=/fake"`]) {
    assert.equal(groupProcesses([record(commandLine)], { sameUserOnly: false })[0]?.workingDirectory, '/project', commandLine);
  }
  assert.equal(groupProcesses([record(`node -C qwen "${entry}" -C "/real project"`)], { sameUserOnly: false })[0]?.workingDirectory, '/real project');
  const desktop = record('Cursor.exe --prompt "--folder-uri=file:///fake"', {
    name: 'Cursor.exe', executablePath: 'C:/Programs/Cursor/Cursor.exe', workingDirectory: 'C:/project',
  });
  assert.equal(groupProcesses([desktop], { sameUserOnly: false })[0]?.workingDirectory, 'C:/project');
});
