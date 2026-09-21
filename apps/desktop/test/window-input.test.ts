import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_TYPED_LENGTH,
  parseWindowInputResult,
  resolveInputScriptPath,
  typeIntoWindow,
  typingRefusal,
} from '../src/window-input.js';

/**
 * Typing text into a session's window.
 *
 * The delivery itself was measured against windows created for the purpose, never a user application — typing
 * into one destroyed unsaved work earlier in this project, so that is never repeated. What is tested here is the
 * validation and the refusals, which is the part that decides whether anything is typed at all.
 */

function recorder() {
  const calls: { args: readonly string[]; stdin: string }[] = [];
  return {
    calls,
    runCommand: async (_executable: string, args: readonly string[], stdin: string): Promise<string> => {
      calls.push({ args: [...args], stdin });
      return '{"ok":true,"title":"a window","typed":3,"sentInputs":3}';
    },
  };
}

test('types the text and reports what happened', async () => {
  const { calls, runCommand } = recorder();
  const result = await typeIntoWindow(67008, '继续', false, { runCommand });
  assert.equal(result.ok, true);
  assert.equal(result.title, 'a window');
  assert.equal(calls.length, 1);
  // The text travels on stdin, never as an argument: a `-File` parameter cannot bind an array, cannot bind a
  // Boolean, and mangles non-ASCII through the console code page.
  assert.equal(calls[0]?.stdin, '继续');
  const args = calls[0]?.args ?? [];
  assert.equal(args[args.indexOf('-Handle') + 1], '67008');
  assert.equal(args[args.indexOf('-Mode') + 1], 'type');
});

test('asks for Enter only when submitting', async () => {
  const plain = recorder();
  await typeIntoWindow(11, 'x', false, { runCommand: plain.runCommand });
  assert.equal(plain.calls[0]?.args.includes('-SubmitKey'), false);

  const withEnter = recorder();
  await typeIntoWindow(11, 'x', true, { runCommand: withEnter.runCommand });
  const args = withEnter.calls[0]?.args ?? [];
  assert.equal(args[args.indexOf('-SubmitKey') + 1], 'enter');
});

test('refuses an empty line before spawning anything', async () => {
  // A window receiving a bare Enter can submit whatever is already in it, so empty text is refused outright.
  for (const text of ['', '   ', '\t']) {
    const { calls, runCommand } = recorder();
    const result = await typeIntoWindow(11, text, true, { runCommand });
    assert.equal(result.ok, false, `text ${JSON.stringify(text)} should be refused`);
    assert.equal(result.reason, 'empty-text');
    assert.equal(calls.length, 0, 'nothing should be spawned for empty text');
  }
});

test('refuses multi-line text, because a newline would submit early', async () => {
  const { calls, runCommand } = recorder();
  const result = await typeIntoWindow(11, 'first\nsecond', false, { runCommand });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'multi-line-text');
  assert.equal(calls.length, 0);
});

test('refuses text longer than the service would accept', async () => {
  const { runCommand } = recorder();
  assert.equal((await typeIntoWindow(11, 'x'.repeat(MAX_TYPED_LENGTH), false, { runCommand })).ok, true);
  const tooLong = await typeIntoWindow(11, 'x'.repeat(MAX_TYPED_LENGTH + 1), false, { runCommand });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, 'text-too-long');
});

test('refuses an invalid window handle', async () => {
  const { calls, runCommand } = recorder();
  for (const handle of [0, -1, 1.5, Number.NaN]) {
    const result = await typeIntoWindow(handle, 'x', false, { runCommand });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-window-handle');
  }
  assert.equal(calls.length, 0);
});

test('a helper that refuses becomes a stated reason, not a thrown error', async () => {
  // The helper refuses when it cannot take focus; that is a healthy outcome the UI must state.
  const runCommand = async (): Promise<string> =>
    '{"ok":false,"reason":"could-not-take-focus","title":"w","typed":0}';
  const result = await typeIntoWindow(11, 'x', false, { runCommand });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'could-not-take-focus');
});

test('a failing helper or unreadable output is a stated reason', async () => {
  const throwing = async (): Promise<string> => { throw new Error('powershell is unavailable'); };
  assert.equal((await typeIntoWindow(11, 'x', false, { runCommand: throwing })).ok, false);

  for (const stdout of ['', 'not json', '[]', 'null']) {
    const result = await typeIntoWindow(11, 'x', false, { runCommand: async () => stdout });
    assert.equal(result.ok, false, `stdout ${JSON.stringify(stdout)} should not look like success`);
  }
});

test('parses the helper result and drops fields it did not report', () => {
  assert.deepEqual(parseWindowInputResult('{"ok":true,"typed":20,"submitted":true}'), {
    ok: true,
    typed: 20,
    submitted: true,
  });
  assert.equal(parseWindowInputResult('') , null);
  assert.equal(parseWindowInputResult('garbage'), null);
});

/**
 * A window hosting several sessions must never be typed into.
 *
 * Measured on this machine: two Tabby Codex sessions share window handle 67008. Text typed into that window goes
 * to whichever terminal pane currently holds the focus inside it, which need not be the session the person
 * selected — a silent wrong-target failure. Nothing in the window's state reveals which pane that is, so the only
 * safe answer is to decline.
 */
test('refuses a window that hosts more than one monitored session', () => {
  const refusal = typingRefusal(2);
  assert.ok(refusal, 'a shared window must be refused');
  assert.match(String(refusal), /2/u);
  assert.match(String(refusal), /无法确定/u);
});

test('allows a window that hosts exactly one session', () => {
  assert.equal(typingRefusal(1), null);
  assert.equal(typingRefusal(0), null);
});

test('resolves the helper from the packaged resources when it is there', () => {
  const path = resolveInputScriptPath();
  assert.ok(path.endsWith('window-input.ps1'), `unexpected path: ${path}`);
  assert.ok(path.includes('process'), `the script should live beside the other window helpers: ${path}`);
});