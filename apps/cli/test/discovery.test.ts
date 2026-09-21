import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  WindowsProcessProvider,
  parseWindowsProcessJson,
  type RawProcessRecord,
} from '../src/process/process-provider.js';
import {
  detectProcessTool,
  groupProcesses,
} from '../src/process/discovery.js';
import {
  currentUserSid,
  windowsProcessFixture,
} from './fixtures/windows-processes.js';

test('groupProcesses attaches each native Codex child to its Node root', () => {
  const records = parseWindowsProcessJson(JSON.stringify(windowsProcessFixture));

  const sessions = groupProcesses(records, { currentUserSid });

  assert.deepEqual(
    sessions.map(({ tool, rootPid, childPids }) => ({ tool, rootPid, childPids })),
    [
      { tool: 'claude', rootPid: 110, childPids: [] },
      { tool: 'codex', rootPid: 210, childPids: [211] },
      { tool: 'codex', rootPid: 220, childPids: [221] },
    ],
  );
  assert.ok(sessions.every((session) => session.transportHint === 'unknown'));
});

test('groupProcesses excludes matching records owned by a different user', () => {
  const records = parseWindowsProcessJson(JSON.stringify(windowsProcessFixture));

  const sessions = groupProcesses(records, { currentUserSid });

  assert.equal(sessions.length, 3);
  assert.ok(sessions.every((session) => session.userSid === currentUserSid));
  assert.ok(sessions.every((session) => session.rootPid !== 310));
});

test('groupProcesses can include matching records from every user explicitly', () => {
  const records = parseWindowsProcessJson(JSON.stringify(windowsProcessFixture));

  const sessions = groupProcesses(records, { sameUserOnly: false });

  assert.deepEqual(sessions.map((session) => session.rootPid), [110, 210, 220, 310]);
});

test('groupProcesses extracts a process working directory from supported CLI flags', () => {
  const base: RawProcessRecord = {
    pid: 1,
    parentPid: 0,
    name: 'claude.ps1',
    commandLine: null,
    executablePath: null,
    creationTimeMs: 1,
    userSid: currentUserSid,
  };
  const commandLines = [
    'claude.ps1 --cwd "C:\\work\\quoted project"',
    "claude.ps1 --directory='C:\\work\\single-quoted'",
    'codex.exe -C C:\\work\\codex-project',
  ];

  assert.deepEqual(commandLines.map((commandLine, index) => {
    const record = {
      ...base,
      pid: index + 1,
      name: index === 2 ? 'codex.exe' : 'claude.ps1',
      commandLine,
    };
    return groupProcesses([record], { currentUserSid })[0]?.workingDirectory;
  }), [
    'C:\\work\\quoted project',
    'C:\\work\\single-quoted',
    'C:\\work\\codex-project',
  ]);
});

test('groupProcesses fails closed when same-user grouping has no current SID', () => {
  const records = parseWindowsProcessJson(JSON.stringify(windowsProcessFixture));

  assert.throws(() => groupProcesses(records, {}), /currentUserSid/);
});

test('groupProcesses derives the current SID from the watchdog process record', () => {
  const records = parseWindowsProcessJson(JSON.stringify(windowsProcessFixture));
  const baseRecord = records[0];
  assert.ok(baseRecord);
  const watchdogRecord = {
    ...baseRecord,
    pid: 424_242,
    name: 'node.exe',
    commandLine: 'node.exe watchdog.js',
  };

  const sessions = groupProcesses(
    [...records, watchdogRecord],
    { currentProcessId: 424_242 },
  );

  assert.equal(sessions.length, 3);
  assert.ok(sessions.every((session) => session.userSid === currentUserSid));
});

/**
 * The watchdog must not monitor its own transport.
 *
 * It runs a `codex app-server` child to continue Codex sessions. That child carries a codex signature on its
 * command line, so discovery found it and listed the watchdog's own transport as a session — labelled
 * 命令提示符 after the `cmd.exe` that wraps it, and reported by the user as "命令提示符监控了自身". Measured
 * on a real machine, the tree was:
 *
 *   Selbstlauf.exe -> cmd.exe (call "codex" "app-server" --listen stdio://) -> node.exe codex.js app-server
 *
 * Descendants are excluded, not just the process itself, because the signature is on the child rather than
 * on the app, and the `cmd.exe` in between carries no signature of its own.
 */
test('groupProcesses never lists the watchdog itself or anything it spawned', () => {
  const watchdogPid = 31_932;
  const records: RawProcessRecord[] = [
    {
      pid: watchdogPid,
      parentPid: 28_548,
      name: 'Selbstlauf.exe',
      commandLine: '"C:\\Programs\\Selbstlauf.exe"',
      executablePath: 'C:\\Programs\\Selbstlauf.exe',
      creationTimeMs: 1,
      userSid: currentUserSid,
      ancestors: [{ pid: 28_548, name: 'explorer.exe' }],
      windows: [],
    },
    {
      pid: 36_608,
      parentPid: watchdogPid,
      name: 'cmd.exe',
      commandLine: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c call "codex" "app-server" "--listen" "stdio://"',
      executablePath: 'C:\\WINDOWS\\system32\\cmd.exe',
      creationTimeMs: 2,
      userSid: currentUserSid,
      ancestors: [{ pid: watchdogPid, name: 'Selbstlauf.exe' }],
      windows: [],
    },
    {
      pid: 19_436,
      parentPid: 36_608,
      name: 'node.exe',
      commandLine: '"node" "...\\@openai\\codex\\bin\\codex.js" "app-server" "--listen" "stdio://"',
      executablePath: 'C:\\node.exe',
      creationTimeMs: 3,
      userSid: currentUserSid,
      ancestors: [
        { pid: 36_608, name: 'cmd.exe' },
        { pid: watchdogPid, name: 'Selbstlauf.exe' },
      ],
      windows: [],
    },
  ];

  const sessions = groupProcesses(records, { currentProcessId: watchdogPid, currentUserSid });

  assert.deepEqual(sessions, [], 'the watchdog transport was listed as a session');
});

test('groupProcesses still finds a real Codex session that is not a descendant', () => {
  // The exclusion must not swallow ordinary sessions: this one's chain ends at a terminal.
  const records: RawProcessRecord[] = [
    {
      pid: 30_780,
      parentPid: 18_632,
      name: 'node.exe',
      commandLine: '"node" "...\\@openai\\codex\\bin\\codex.js" ',
      executablePath: 'C:\\node.exe',
      creationTimeMs: 1,
      userSid: currentUserSid,
      ancestors: [
        { pid: 18_632, name: 'cmd.exe' },
        { pid: 19_272, name: 'Tabby.exe' },
      ],
      windows: [],
    },
  ];

  const sessions = groupProcesses(records, { currentProcessId: 31_932, currentUserSid });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.rootPid, 30_780);
});

/**
 * One conversation must not appear as two processes.
 *
 * A codex process started underneath a codex session but separated by a process carrying no signature
 * became its own root, and therefore its own row. Measured on a real machine: a Tabby Codex conversation was
 * listed twice — once for the CLI `node.exe … codex.js`, and once for the `codex.exe app-server` it spawned,
 * reached through `node_repl.exe` and a `cua-repl` node — and **both rows resolved to the same conversation
 * id**. The user reported it as "tabby重复监控了".
 */
test('groupProcesses folds a signatureless-broken descendant into its session', () => {
  const records: RawProcessRecord[] = [
    {
      pid: 30_780,
      parentPid: 18_632,
      name: 'node.exe',
      commandLine: '"node" "...\\@openai\\codex\\bin\\codex.js" ',
      executablePath: 'C:\\node.exe',
      creationTimeMs: 1,
      userSid: currentUserSid,
      ancestors: [
        { pid: 18_632, name: 'cmd.exe' },
        { pid: 19_272, name: 'Tabby.exe' },
      ],
      windows: [],
    },
    // The real codex binary, a child of the CLI.
    {
      pid: 21_856,
      parentPid: 30_780,
      name: 'codex.exe',
      commandLine: 'C:\\...\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
      executablePath: 'C:\\...\\codex.exe',
      creationTimeMs: 2,
      userSid: currentUserSid,
      ancestors: [
        { pid: 30_780, name: 'node.exe' },
        { pid: 18_632, name: 'cmd.exe' },
        { pid: 19_272, name: 'Tabby.exe' },
      ],
      windows: [],
    },
    // A process with no signature, between the session and the app-server below it.
    {
      pid: 19_284,
      parentPid: 30_876,
      name: 'node_repl.exe',
      commandLine: 'C:\\...\\cua_node\\node_repl.exe',
      executablePath: 'C:\\...\\node_repl.exe',
      creationTimeMs: 3,
      userSid: currentUserSid,
      ancestors: [
        { pid: 30_876, name: 'node.exe' },
        { pid: 21_856, name: 'codex.exe' },
        { pid: 30_780, name: 'node.exe' },
      ],
      windows: [],
    },
    // The app-server, which carries a codex signature and was listed as its own session.
    {
      pid: 17_448,
      parentPid: 19_284,
      name: 'codex.exe',
      commandLine: '"C:\\...\\OpenAI\\Codex\\bin\\codex.exe" app-server --listen stdio://',
      executablePath: 'C:\\...\\codex.exe',
      creationTimeMs: 4,
      userSid: currentUserSid,
      ancestors: [
        { pid: 19_284, name: 'node_repl.exe' },
        { pid: 30_876, name: 'node.exe' },
        { pid: 21_856, name: 'codex.exe' },
        { pid: 30_780, name: 'node.exe' },
      ],
      windows: [],
    },
  ];

  const sessions = groupProcesses(records, { currentUserSid });

  assert.equal(sessions.length, 1, 'the same conversation was listed as more than one session');
  assert.equal(sessions[0]?.rootPid, 30_780);
  /**
   * The descendants carrying a signature are recorded as children of that one session.
   *
   * `node_repl.exe` is deliberately absent: it carries no tool signature, so it is never a session
   * candidate. It only matters because it sits between the session and the app-server below it, which is
   * what made the app-server look like its own root.
   */
  assert.deepEqual(sessions[0]?.childPids, [17_448, 21_856]);
});

test('groupProcesses keeps two independent sessions of the same tool apart', () => {
  // Two Codex conversations in two different terminals share no ancestor, so they stay two rows.
  const mk = (pid: number, cmdPid: number, tabPid: number): RawProcessRecord => ({
    pid,
    parentPid: cmdPid,
    name: 'node.exe',
    commandLine: '"node" "...\\@openai\\codex\\bin\\codex.js" ',
    executablePath: 'C:\\node.exe',
    creationTimeMs: pid,
    userSid: currentUserSid,
    ancestors: [
      { pid: cmdPid, name: 'cmd.exe' },
      { pid: tabPid, name: 'Tabby.exe' },
    ],
    windows: [],
  });

  const sessions = groupProcesses(
    [mk(30_780, 18_632, 19_272), mk(14_976, 24_036, 19_272)],
    { currentUserSid },
  );

  assert.deepEqual(sessions.map((session) => session.rootPid), [14_976, 30_780]);
});

test('groupProcesses keeps an orphan native process as a separate unknown session', () => {
  const records = parseWindowsProcessJson(JSON.stringify(windowsProcessFixture));
  const native = records.find((record) => record.pid === 211);
  assert.ok(native);

  const sessions = groupProcesses(
    [{ ...native, parentPid: 9_999 }],
    { currentUserSid },
  );

  assert.deepEqual(sessions, [
    {
      tool: 'codex',
      rootPid: 211,
      childPids: [],
      commandLine: native.commandLine,
      executablePath: native.executablePath,
      creationTimeMs: native.creationTimeMs,
      userSid: currentUserSid,
      transportHint: 'unknown',
    },
  ]);
});

test('detectProcessTool recognizes configured executable names exactly', () => {
  const record = {
    pid: 400,
    parentPid: 100,
    name: 'team-agent.exe',
    commandLine: '"C:\\Tools\\team-agent.exe" --interactive',
    executablePath: 'C:\\Tools\\team-agent.exe',
    creationTimeMs: Date.UTC(2026, 7, 19),
    userSid: currentUserSid,
  };

  assert.equal(
    detectProcessTool(record, { claudeExecutableNames: ['team-agent.exe'] }),
    'claude',
  );
  assert.equal(
    detectProcessTool(
      {
        ...record,
        name: 'team-agent-helper.exe',
        commandLine: '"C:\\Tools\\team-agent-helper.exe" --interactive',
        executablePath: 'C:\\Tools\\team-agent-helper.exe',
      },
      { claudeExecutableNames: ['team-agent.exe'] },
    ),
    null,
  );
});

test('detectProcessTool accepts slash-separated package paths and rejects near misses', () => {
  const base: RawProcessRecord = {
    pid: 401,
    parentPid: 100,
    name: 'node.exe',
    commandLine: null,
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    creationTimeMs: Date.UTC(2026, 7, 19),
    userSid: currentUserSid,
  };
  const signatures = [
    ['node C:/tools/@openai/codex/bin/runner.js', 'codex'],
    ['node "C:\\tools\\@openai\\codex\\bin\\runner.js"', 'codex'],
    ['node C:/tools/claude-code/cli.js', 'claude'],
    ['node C:/tools/codexXjs', null],
    ['node C:/tools/notclaude-code/cli.js', null],
    ['node C:/tools/claude-code-helper/cli.js', null],
    ['node C:/tools/@openai/codex-helper/bin/runner.js', null],
    ['node C:/tools/prefix@openai/codex/bin/runner.js', null],
    ['node C:/tools/dsh.cmd', 'dsh'],
    ['node C:/tools/dsh.ps1', 'dsh'],
    ['node C:/tools/dshXcmd', null],
    ['node C:/tools/dshXps1', null],
  ] as const;

  assert.deepEqual(
    signatures.map(([commandLine]) => detectProcessTool({ ...base, commandLine })),
    signatures.map(([, expected]) => expected),
  );
});

test('parseWindowsProcessJson converts DMTF dates to epoch milliseconds', () => {
  const [record] = parseWindowsProcessJson(JSON.stringify(windowsProcessFixture[1]));

  assert.ok(record);
  assert.equal(record.creationTimeMs, Date.parse('2026-08-19T15:00:00.000Z'));
});

test('parseWindowsProcessJson rejects malformed process fields', () => {
  const malformed = { ...windowsProcessFixture[1], pid: '110' };

  assert.throws(() => parseWindowsProcessJson(JSON.stringify(malformed)), /pid/);
});

test('WindowsProcessProvider invokes PowerShell non-interactively and parses one document', async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const provider = new WindowsProcessProvider({
    powershellPath: 'fixture-powershell.exe',
    scriptPath: 'C:\\watchdog\\windows-processes.ps1',
    runCommand: async (executable, args) => {
      calls.push({ executable, args: [...args] });
      return JSON.stringify([windowsProcessFixture[1]]);
    },
  });

  const records = await provider.listProcesses();

  assert.deepEqual(calls, [
    {
      executable: 'fixture-powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'C:\\watchdog\\windows-processes.ps1',
      ],
    },
  ]);
  assert.equal(records[0]?.pid, 110);
});

test('WindowsProcessProvider forwards configured executable names to the provider', async () => {
  let receivedArgs: readonly string[] = [];
  const provider = new WindowsProcessProvider({
    scriptPath: 'C:\\watchdog\\windows-processes.ps1',
    includeExecutableNames: ['team-agent.exe'],
    runCommand: async (_executable, args) => {
      receivedArgs = [...args];
      return '[]';
    },
  });

  await provider.listProcesses();

  assert.deepEqual(receivedArgs.slice(-2), ['-IncludeExecutableName', 'team-agent.exe']);
});

test('WindowsProcessProvider forwards the watchdog PID so its owner SID is always reported', async () => {
  let receivedArgs: readonly string[] = [];
  const provider = new WindowsProcessProvider({
    scriptPath: 'C:\\watchdog\\windows-processes.ps1',
    includeProcessIds: [4242, 0, -1],
    runCommand: async (_executable, args) => {
      receivedArgs = [...args];
      return '[]';
    },
  });

  await provider.listProcesses();

  assert.deepEqual(receivedArgs.slice(-2), ['-IncludeProcessId', '4242']);
});

/**
 * Window-title markers must be sent as ONE comma-separated argument.
 *
 * This seam broke twice, in opposite directions, and neither failure was catchable from the pure
 * classification tests because they never exercise how Node marshals arguments into PowerShell:
 *
 *   1. `-WindowTitleMarker a -WindowTitleMarker b` -> PowerShell raises "parameter is specified more than
 *      once", the provider call throws, and the app discovers NOTHING at all. It shipped in 0.9.2 and the
 *      installer check caught it with "the installed app never discovered probe PID ... it listed 0
 *      session(s)".
 *   2. `-WindowTitleMarker "a,b"` against a `[string[]]` parameter -> binds the whole thing as the single
 *      string "a,b", which matches no window, so the harness session reported no window and lost its
 *      preview and 切换到该窗口.
 *
 * The script now takes a single string and splits it, so this pins the form the caller must use.
 */
test('WindowsProcessProvider sends title markers as one comma-separated argument', async () => {
  let receivedArgs: readonly string[] = [];
  const provider = new WindowsProcessProvider({
    scriptPath: 'C:\\watchdog\\windows-processes.ps1',
    windowTitleMarkers: ['DeepSeek Harness', 'DSH'],
    runCommand: async (_executable, args) => {
      receivedArgs = [...args];
      return '[]';
    },
  });

  await provider.listProcesses();

  const occurrences = receivedArgs.filter((arg) => arg === '-WindowTitleMarker');
  assert.equal(occurrences.length, 1, 'the parameter must appear exactly once, or PowerShell rejects it');
  assert.equal(
    receivedArgs[receivedArgs.indexOf('-WindowTitleMarker') + 1],
    'DeepSeek Harness,DSH',
    'the markers must be one comma-separated value for the script to split',
  );
});

test('WindowsProcessProvider omits the marker argument entirely when none are configured', async () => {
  // An empty argument would be split into zero markers, but sending `-WindowTitleMarker ""` relies on
  // PowerShell binding an empty string, which is needless when there is nothing to say.
  let receivedArgs: readonly string[] = [];
  const provider = new WindowsProcessProvider({
    scriptPath: 'C:\\watchdog\\windows-processes.ps1',
    windowTitleMarkers: ['  ', ''],
    runCommand: async (_executable, args) => {
      receivedArgs = [...args];
      return '[]';
    },
  });

  await provider.listProcesses();

  assert.equal(receivedArgs.filter((arg) => arg === '-WindowTitleMarker').length, 0);
});

test('WindowsProcessProvider cancels an in-flight PowerShell discovery', async () => {
  let started!: () => void;
  const commandStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  const provider = new WindowsProcessProvider({
    runCommand: async (_executable, _args, signal) => {
      started();
      return await new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true });
      });
    },
  });

  const discovery = provider.listProcesses();
  await commandStarted;
  provider.cancelPending();
  await assert.rejects(discovery, /fixture aborted/);
});

test('WindowsProcessProvider reads the working directory of a live same-user process', {
  skip: process.platform !== 'win32',
  timeout: 60_000,
}, async () => {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'watchdog-process-cwd-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
    cwd: workingDirectory,
    windowsHide: true,
    stdio: 'ignore',
  });
  try {
    await once(child, 'spawn');
    assert.ok(child.pid);

    const records = await new WindowsProcessProvider().listProcesses();
    const record = records.find((candidate) => candidate.pid === child.pid);

    assert.ok(record, `expected process ${child.pid} in the WMI result`);
    assert.equal(resolve(record.workingDirectory ?? ''), resolve(workingDirectory));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(workingDirectory, { recursive: true, force: true });
  }
});
