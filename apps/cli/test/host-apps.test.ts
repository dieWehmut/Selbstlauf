import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifySessionHost,
  findHarnessWindow,
  hostAppFor,
  isRealWindow,
  type HostWindowRef,
} from '../src/process/host-apps.js';
import { focusWindow, openLocalUrl } from '../src/process/window-focus.js';

const DSH_HINT = { titleMarkers: ['DeepSeek Harness', 'DSH'], label: 'DeepSeek Harness 网页界面' } as const;

function window(overrides: Partial<HostWindowRef> & Pick<HostWindowRef, 'pid' | 'title'>): HostWindowRef {
  return {
    handle: 65_000 + overrides.pid,
    processName: null,
    className: 'Chrome_WidgetWin_1',
    visible: true,
    ...overrides,
  };
}

test('classifies the terminal a session was launched from', () => {
  const host = classifySessionHost({
    rootPid: 79556,
    rootName: 'node.exe',
    ancestors: [
      { pid: 92944, name: 'cmd.exe' },
      { pid: 31192, name: 'Tabby.exe' },
      { pid: 5292, name: 'explorer.exe' },
    ],
    windows: [
      window({ pid: 31192, processName: 'Tabby.exe', title: ' Orchester' }),
      window({ pid: 92944, processName: 'cmd.exe', title: 'C:\\WINDOWS\\system32\\cmd.exe', className: 'ConsoleWindowClass' }),
    ],
  });

  assert.equal(host?.label, 'Tabby');
  assert.equal(host?.category, 'terminal');
  assert.equal(host?.processId, 31192);
  assert.equal(host?.windowTitle, ' Orchester');
  assert.equal(host?.windowHandle, 65_000 + 31192);
});

test('classifies the Codex desktop app that hosts an app server', () => {
  const host = classifySessionHost({
    rootPid: 62072,
    rootName: 'codex.exe',
    ancestors: [
      { pid: 3752, name: 'ChatGPT.exe' },
      { pid: 5292, name: 'explorer.exe' },
    ],
    windows: [window({ pid: 3752, processName: 'ChatGPT.exe', title: 'ChatGPT' })],
  });

  assert.equal(host?.label, 'Codex 应用');
  assert.equal(host?.category, 'desktop-app');
});

test('classifies the editor that owns the integrated terminal', () => {
  const host = classifySessionHost({
    rootPid: 5132,
    rootName: 'codex.exe',
    ancestors: [
      { pid: 28520, name: 'Code.exe' },
      { pid: 25664, name: 'Code.exe' },
      { pid: 5292, name: 'explorer.exe' },
    ],
    windows: [window({ pid: 25664, processName: 'Code.exe', title: 'config.toml - Visual Studio Code' })],
  });

  assert.equal(host?.label, 'Visual Studio Code');
  assert.equal(host?.category, 'editor');
  assert.equal(host?.windowTitle, 'config.toml - Visual Studio Code');
});

test('falls back to the console when no richer host is in the chain', () => {
  const host = classifySessionHost({
    rootPid: 97368,
    rootName: 'node.exe',
    ancestors: [
      { pid: 44964, name: 'cmd.exe' },
      { pid: 5292, name: 'explorer.exe' },
    ],
    windows: [
      window({ pid: 44964, processName: 'cmd.exe', title: 'C:\\WINDOWS\\system32\\cmd.exe', className: 'ConsoleWindowClass' }),
    ],
  });

  assert.equal(host?.label, '命令提示符');
  assert.equal(host?.category, 'console');
  // The desktop shell outranks nothing, so a bare console still wins over it.
  assert.equal(host?.processId, 44964);
});

test('a nearer terminal wins over a farther one of the same rank', () => {
  const host = classifySessionHost({
    rootPid: 100,
    rootName: 'node.exe',
    ancestors: [
      { pid: 200, name: 'Tabby.exe' },
      { pid: 300, name: 'WindowsTerminal.exe' },
      { pid: 5292, name: 'explorer.exe' },
    ],
    windows: [window({ pid: 200, processName: 'Tabby.exe', title: 'sandkasten' })],
  });

  assert.equal(host?.processId, 200);
});

test('a harness session names the browser showing its WebUI', () => {
  const host = classifySessionHost({
    rootPid: 97368,
    rootName: 'node.exe',
    ancestors: [{ pid: 44964, name: 'cmd.exe' }],
    windows: [
      window({ pid: 44964, processName: 'cmd.exe', title: 'cmd.exe', className: 'ConsoleWindowClass' }),
      window({ pid: 35544, processName: 'msedge.exe', title: 'Reference attachments — DSH' }),
    ],
    harness: DSH_HINT,
  });

  assert.equal(host?.label, 'Microsoft Edge');
  assert.equal(host?.category, 'browser');
  assert.equal(host?.processId, 35544);
  assert.equal(host?.windowTitle, 'Reference attachments — DSH');
});

test('a harness session without a matching window still names the interface', () => {
  const host = classifySessionHost({
    rootPid: 97368,
    rootName: 'node.exe',
    ancestors: [{ pid: 44964, name: 'cmd.exe' }],
    windows: [window({ pid: 44964, processName: 'cmd.exe', title: 'cmd.exe', className: 'ConsoleWindowClass' })],
    harness: DSH_HINT,
  });

  assert.equal(host?.label, 'DeepSeek Harness 网页界面');
  assert.equal(host?.category, 'browser');
  assert.equal(host?.windowHandle, null);
});

test('a window that only mentions the marker is weaker than a browser tab', () => {
  const windows: HostWindowRef[] = [
    window({ pid: 900, processName: 'Code.exe', title: 'notes about DSH.txt - Visual Studio Code' }),
    window({ pid: 901, processName: 'chrome.exe', title: 'some other DSH tab' }),
  ];
  const found = findHarnessWindow(windows, DSH_HINT);
  assert.equal(found?.pid, 901);

  // With no browser candidate the mention is still better than nothing.
  assert.equal(findHarnessWindow([windows[0] as HostWindowRef], DSH_HINT)?.pid, 900);
});

/**
 * The harness window's title in practice does not contain the abbreviation.
 *
 * Measured on this machine: the window showing the harness WebUI is titled
 * `Reference attachments for goal objective — DeepSeek Harness`. With only `DSH` configured the match failed,
 * so the harness session was reported as having no window at all while its window was visibly open — and with
 * it, the window preview and 切换到该窗口 were both lost. The full product name is what actually appears, so
 * both are listed.
 */
test('finds the harness window by its full name, not only the abbreviation', () => {
  const windows: HostWindowRef[] = [
    window({ pid: 44964, processName: 'cmd.exe', title: 'cmd.exe', className: 'ConsoleWindowClass' }),
    window({ pid: 5000, processName: 'msedge.exe', title: 'Reference attachments for goal objective — DeepSeek Harness' }),
  ];

  const found = findHarnessWindow(windows, DSH_HINT);
  assert.equal(found?.pid, 5000, 'the harness window was not found by its real title');

  const host = classifySessionHost({
    rootPid: 7984,
    rootName: 'node.exe',
    ancestors: [{ pid: 44964, name: 'cmd.exe' }],
    windows,
    harness: DSH_HINT,
  });
  assert.equal(host?.category, 'browser');
  assert.equal(host?.processId, 5000);
  assert.ok(host?.windowHandle !== null, 'the harness session must keep a window handle to preview and reveal');
  assert.equal(host?.windowTitle, 'Reference attachments for goal objective — DeepSeek Harness');
});

test('the abbreviation alone still matches, so neither marker is required', () => {
  // A title that uses the short name must keep working.
  const windows = [window({ pid: 77, processName: 'chrome.exe', title: 'DSH session' })];
  assert.equal(findHarnessWindow(windows, DSH_HINT)?.pid, 77);
});

test('input-method and shell plumbing windows are never chosen', () => {
  const windows: HostWindowRef[] = [
    window({ pid: 25664, title: 'MSCTFIME UI', className: 'MSCTFIME UI' }),
    window({ pid: 25664, title: 'Default IME', className: 'IME' }),
    window({ pid: 5292, title: 'Program Manager', className: 'Progman' }),
    window({ pid: 5292, title: '任务切换', className: 'XamlExplorerHostIslandWindow' }),
    window({ pid: 5292, title: '系统托盘溢出窗口。', className: 'TopLevelWindowForOverflowXamlIsland' }),
  ];
  assert.ok(windows.every((entry) => !isRealWindow(entry)));
  assert.equal(classifySessionHost({
    rootPid: 100,
    rootName: 'node.exe',
    ancestors: [{ pid: 5292, name: 'explorer.exe' }],
    windows,
  })?.windowTitle ?? null, null);
});

test('a session with no recognized host and no window reports nothing', () => {
  assert.equal(classifySessionHost({
    rootPid: 100,
    rootName: 'node.exe',
    ancestors: [{ pid: 200, name: 'svchost.exe' }],
    windows: [],
  }), null);
});

test('hostAppFor only matches known image names', () => {
  assert.equal(hostAppFor('Tabby.exe')?.label, 'Tabby');
  assert.equal(hostAppFor('  tabby.exe ')?.label, 'Tabby');
  assert.equal(hostAppFor('not-a-host.exe'), null);
});

test('focusWindow forwards a validated handle and parses the result', async () => {
  const calls: Array<{ readonly executable: string; readonly args: readonly string[] }> = [];
  const runCommand = async (executable: string, args: readonly string[]) => {
    calls.push({ executable, args: [...args] });
    return '{"ok":true,"title":"Orchester","processId":31192}';
  };

  const result = await focusWindow(65_001, { runCommand, scriptPath: 'C:\\watchdog\\window-focus.ps1' });
  assert.deepEqual(result, { ok: true, title: 'Orchester', processId: 31192 });
  assert.deepEqual(calls[0]?.args.slice(-2), ['-Handle', '65001']);

  assert.deepEqual(await focusWindow(0, { runCommand }), { ok: false, reason: 'invalid-window-handle' });
  assert.deepEqual(await focusWindow(Number.NaN, { runCommand }), { ok: false, reason: 'invalid-window-handle' });
});

test('focusWindow reports a refusal and a broken provider without throwing', async () => {
  const refused = await focusWindow(65_001, {
    runCommand: async () => '{"ok":false,"reason":"foreground-refused"}',
    scriptPath: 'x.ps1',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'foreground-refused');

  const broken = await focusWindow(65_001, {
    runCommand: async () => 'not json',
    scriptPath: 'x.ps1',
  });
  assert.deepEqual(broken, { ok: false, reason: 'invalid-response' });

  const failed = await focusWindow(65_001, {
    runCommand: async () => { throw new Error('fixture failure'); },
    scriptPath: 'x.ps1',
  });
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /focus-command-failed/u);
});

test('openLocalUrl refuses anything that is not a loopback interface', async () => {
  const calls: string[] = [];
  const runCommand = async (_executable: string, args: readonly string[]) => {
    calls.push(args[args.length - 1] ?? '');
    return '{"ok":true}';
  };
  const options = { runCommand, scriptPath: 'x.ps1' };

  assert.deepEqual(await openLocalUrl('http://127.0.0.1:3080', options), { ok: true });
  assert.equal(calls[0], 'http://127.0.0.1:3080/');

  assert.deepEqual(await openLocalUrl('not a url', options), { ok: false, reason: 'invalid-url' });
  assert.deepEqual(await openLocalUrl('file:///C:/windows/system32', options), { ok: false, reason: 'unsupported-url' });
  assert.deepEqual(await openLocalUrl('https://example.com', options), { ok: false, reason: 'non-loopback-url' });
  assert.deepEqual(await openLocalUrl('http://192.168.1.10:8080', options), { ok: false, reason: 'non-loopback-url' });
  assert.equal(calls.length, 1);
});
/**
 * This application is never where a session runs.
 *
 * Its window is an ancestor of every CLI the watchdog continues - the service and the sessions it spawns
 * live inside it - so it was picked as the host and the process list filled with rows labelled
 * 运行位置: Selbstlauf. Measured on this machine: 19 of 25 rows, none of them a place a person works, and
 * all of them long-dead processes that only appeared at all because of it. "Inside Selbstlauf" is never the
 * useful answer, so that executable is excluded from host resolution entirely rather than merely ranked low.
 */
test('never reports this application as the host of a session', () => {
  assert.equal(hostAppFor('Selbstlauf.exe'), null);
  assert.equal(hostAppFor('SELBSTLAUF.EXE'), null);

  // Even directly in the ancestor chain, with a window of its own, it is not chosen.
  const host = classifySessionHost({
    rootPid: 16240,
    rootName: 'node.exe',
    ancestors: [
      { pid: 9900, name: 'Selbstlauf.exe' },
      { pid: 5292, name: 'explorer.exe' },
    ],
    windows: [
      window({ pid: 9900, processName: 'Selbstlauf.exe', title: 'Continuation Watchdog' }),
    ],
  });
  assert.notEqual(host?.label, 'Selbstlauf');
  assert.notEqual(host?.executableName, 'Selbstlauf.exe');
});


