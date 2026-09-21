import test from 'node:test';
import assert from 'node:assert/strict';

import {
  minimizeWindowAgain,
  resolveRestoreScriptPath,
  showWindowWithoutActivating,
} from '../src/window-restore.js';

/**
 * Showing a minimized window just long enough to capture it.
 *
 * These test the parsing and the failure modes; the actual window behaviour was measured against real
 * windows, because it cannot be exercised without one:
 *
 *   before: minimized=True  foreground=4588322
 *   -Mode show     -> {"changed":true,"nowMinimized":false,"foregroundBefore":4588322,"foregroundAfter":4588322}
 *   -Mode minimize -> {"changed":true,"nowMinimized":true,"foregroundBefore":4588322,"foregroundAfter":4588322}
 *   after:  minimized=True  foreground=4588322
 *
 * The foreground window is identical before and after in both directions, which is the property that makes
 * this acceptable to run while the user is working: a preview never takes the caret.
 */

function runWith(stdout: string, record?: (args: readonly string[]) => void) {
  return async (_executable: string, args: readonly string[]): Promise<string> => {
    record?.(args);
    return stdout;
  };
}

test('reports a shown window as showable', async () => {
  const result = await showWindowWithoutActivating(11, {
    runCommand: runWith('{"ok":true,"changed":true,"nowMinimized":false,"foregroundBefore":5,"foregroundAfter":5}'),
  });
  assert.equal(result, true);
});

test('reports a window that would not appear as not showable', async () => {
  const result = await showWindowWithoutActivating(11, {
    runCommand: runWith('{"ok":true,"changed":true,"nowMinimized":true}'),
  });
  assert.equal(result, false);
});

test('a window that was already rendering needs no restore, and is still capturable', async () => {
  // `changed: false` means it was not minimized; a capture is possible either way.
  const result = await showWindowWithoutActivating(11, {
    runCommand: runWith('{"ok":true,"changed":false,"nowMinimized":false}'),
  });
  assert.equal(result, true);
});

test('reports whether the window is minimized again', async () => {
  const minimized = await minimizeWindowAgain(11, true, {
    runCommand: runWith('{"ok":true,"changed":true,"nowMinimized":true}'),
  });
  assert.equal(minimized, true);

  const failed = await minimizeWindowAgain(11, true, {
    runCommand: runWith('{"ok":true,"changed":true,"nowMinimized":false}'),
  });
  assert.equal(failed, false, 'a window left restored must not be reported as minimized again');
});

test('refuses an invalid handle before spawning anything', async () => {
  let spawned = 0;
  const runCommand = async (): Promise<string> => { spawned += 1; return '{}'; };
  for (const handle of [0, -1, 1.5, Number.NaN]) {
    assert.equal(await showWindowWithoutActivating(handle, { runCommand }), false);
    assert.equal(await minimizeWindowAgain(handle, true, { runCommand }), false);
  }
  assert.equal(spawned, 0, 'an invalid handle must not reach the helper script');
});

test('passes the handle and the mode, so the two directions cannot be confused', async () => {
  const seen: string[][] = [];
  const runCommand = runWith('{"ok":true,"nowMinimized":false}', (args) => { seen.push([...args]); });

  await showWindowWithoutActivating(67008, { runCommand });
  await minimizeWindowAgain(67008, true, { runCommand });

  assert.equal(seen.length, 2);
  for (const args of seen) {
    // A single string parameter, not a repeated one: the same -File binding rule that broke the
    // window-title markers applies to every parameter passed this way.
    assert.equal(args.filter((arg) => arg === '-Handle').length, 1);
    assert.equal(args[args.indexOf('-Handle') + 1], '67008');
    assert.equal(args.filter((arg) => arg === '-Mode').length, 1);
  }
  assert.equal(seen[0]?.[seen[0].indexOf('-Mode') + 1], 'show');
  assert.equal(seen[1]?.[seen[1].indexOf('-Mode') + 1], 'minimize');
});

test('turns a failing helper into a stated false rather than a thrown error', async () => {
  const runCommand = async (): Promise<string> => { throw new Error('powershell is unavailable'); };
  assert.equal(await showWindowWithoutActivating(11, { runCommand }), false);
  assert.equal(await minimizeWindowAgain(11, true, { runCommand }), false);
});

test('turns malformed output into a stated false', async () => {
  for (const stdout of ['', 'not json', '[]', 'null', '{}']) {
    assert.equal(await showWindowWithoutActivating(11, { runCommand: runWith(stdout) }), false, `stdout=${stdout}`);
  }
});

/**
 * A window that was never restored must never be minimized.
 *
 * This is the defect the first version shipped, and it was backwards: `minimize` inferred the state from the
 * window and minimized anything that was *not* minimized. In the preview flow that means a window the user
 * has open, whose first capture happens to fail and so triggers the restore path, would be **minimized on
 * them**. The caller's own record is now the only thing consulted, so with `false` nothing runs at all.
 */
test('never minimizes a window it did not restore', async () => {
  let spawned = 0;
  const runCommand = async (): Promise<string> => {
    spawned += 1;
    return '{"ok":true,"changed":true,"nowMinimized":true}';
  };

  const result = await minimizeWindowAgain(67008, false, { runCommand });

  assert.equal(spawned, 0, 'a window that was not restored must not be touched at all');
  assert.equal(result, true, 'leaving it alone is the correct outcome');
});

test('does minimize a window it did restore, and tells the script so', async () => {
  const seen: string[][] = [];
  const runCommand = async (_e: string, args: readonly string[]): Promise<string> => {
    seen.push([...args]);
    return '{"ok":true,"changed":true,"nowMinimized":true}';
  };

  const result = await minimizeWindowAgain(67008, true, { runCommand });

  assert.equal(result, true);
  assert.equal(seen.length, 1);
  // The flag must reach the script as one plain string, the same `-File` binding rule as everywhere else here.
  assert.equal(seen[0]?.[seen[0].indexOf('-WasMinimized') + 1], 'true');
});

test('the show direction never sends the undo flag', async () => {
  const seen: string[][] = [];
  const runCommand = async (_e: string, args: readonly string[]): Promise<string> => {
    seen.push([...args]);
    return '{"ok":true,"nowMinimized":false}';
  };

  await showWindowWithoutActivating(67008, { runCommand });

  assert.equal(seen[0]?.includes('-WasMinimized'), false);
  assert.equal(seen[0]?.[seen[0].indexOf('-Mode') + 1], 'show');
});

test('resolves the helper from the packaged resources when it is there', () => {
  // The packaged app ships it inside the service tree, so the path must be found without a checkout.
  const path = resolveRestoreScriptPath(process.cwd());
  assert.ok(path.endsWith('window-restore.ps1'), `unexpected path: ${path}`);
});

test('falls back to the source tree outside a packaged build', () => {
  const path = resolveRestoreScriptPath();
  assert.ok(path.endsWith('window-restore.ps1'), `unexpected path: ${path}`);
  assert.ok(path.includes('process'), `the script should live beside the other window helpers: ${path}`);
});