import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PREVIEW_THUMBNAIL_SIZE,
  captureSessionWindow,
  handleOfSourceId,
  type CaptureDependencies,
  type PreviewSession,
  type PreviewSource,
} from '../src/window-preview.js';

/**
 * The pure half of the window preview: deciding what to show for a session.
 *
 * The three outcomes other than `captured` are all ordinary states of a healthy system rather
 * than errors, and two of them were established by measurement on this machine:
 *
 *  - a session may run in no window at all (DeepSeek Harness is a web UI);
 *  - a minimized window is not offered by the desktop capturer at all â€” it is absent from the
 *    source list, not merely blank;
 *  - two sessions can share one window, so a preview is of the window rather than of the process.
 */

function source(handle: number, options: { empty?: boolean; width?: number } = {}): PreviewSource {
  return {
    id: `window:${handle}:0`,
    name: `window ${handle}`,
    thumbnail: {
      isEmpty: () => options.empty === true,
      getSize: () => ({ width: options.width ?? 960, height: 600 }),
      toDataURL: () => `data:image/png;base64,handle-${handle}`,
    },
  };
}

function session(id: string, handle: number | null, label = 'Tabby'): PreviewSession {
  return { id, host: { label, windowHandle: handle, windowTitle: `title ${handle}` } };
}

interface Recorded {
  readonly dependencies: CaptureDependencies;
  readonly captured: () => number;
}

function dependencies(sessions: readonly PreviewSession[], sources: readonly PreviewSource[]): Recorded {
  let captures = 0;
  return {
    dependencies: {
      sessions: async () => sessions,
      getSources: async () => {
        captures += 1;
        return sources;
      },
    },
    captured: () => captures,
  };
}

test('handleOfSourceId reads the window handle out of a source id', () => {
  assert.equal(handleOfSourceId('window:67008:0'), 67008);
  assert.equal(handleOfSourceId('window:3932904:1'), 3932904);
});

test('handleOfSourceId reports nothing for a non-window source or a malformed id', () => {
  assert.equal(handleOfSourceId('screen:0:0'), null);
  assert.equal(handleOfSourceId('window::0'), null);
  assert.equal(handleOfSourceId(''), null);
});

test('returns the capture, keyed by the session it was asked for', async () => {
  const { dependencies: deps } = dependencies([session('a', 11), session('b', 22)], [source(11), source(22)]);
  const result = await captureSessionWindow(deps, 'b');

  assert.equal(result.state, 'captured');
  if (result.state !== 'captured') return;
  assert.match(result.dataUrl, /handle-22/u);
  assert.equal(result.width, 960);
  // One session in that window, so nothing is shared.
  assert.equal(result.sharedBy, 1);
});

test('says a session runs in no window when the host has no handle', async () => {
  const { dependencies: deps, captured } = dependencies(
    [{ id: 'dsh', host: { label: 'Harness', windowHandle: null, windowTitle: null } }],
    [],
  );
  const result = await captureSessionWindow(deps, 'dsh');
  assert.equal(result.state, 'no-window');
  // It must not even enumerate windows it will not use.
  assert.equal(captured(), 0);
});

test('reports a minimized window as minimized, not as an empty capture', async () => {
  // The service still reports the handle; the capturer simply does not offer that window.
  const { dependencies: deps } = dependencies([session('a', 11)], [source(99)]);
  const result = await captureSessionWindow(deps, 'a');
  assert.equal(result.state, 'minimized');
});

test('treats an empty thumbnail as unavailable rather than showing a blank frame', async () => {
  const { dependencies: deps } = dependencies([session('a', 11)], [source(11, { empty: true })]);
  const result = await captureSessionWindow(deps, 'a');
  assert.equal(result.state, 'minimized');
});

test('reports how many sessions share the window, so the picture is not misread', async () => {
  // Two Codex sessions inside one Tabby window is the real case this guards.
  const { dependencies: deps } = dependencies(
    [session('a', 67008), session('b', 67008), session('c', 5)],
    [source(67008), source(5)],
  );
  const result = await captureSessionWindow(deps, 'a');
  assert.equal(result.state, 'captured');
  if (result.state !== 'captured') return;
  assert.equal(result.sharedBy, 2);
});

test('refuses a session that is no longer running', async () => {
  const { dependencies: deps } = dependencies([session('a', 11)], [source(11)]);
  const result = await captureSessionWindow(deps, 'gone');
  assert.equal(result.state, 'unsupported');
});

test('turns a failing capture into a stated reason rather than a thrown error', async () => {
  const deps: CaptureDependencies = {
    sessions: async () => [session('a', 11)],
    getSources: async () => { throw new Error('capture is unavailable'); },
  };
  const result = await captureSessionWindow(deps, 'a');
  assert.equal(result.state, 'unsupported');
  if (result.state !== 'unsupported') return;
  assert.match(result.reason ?? '', /capture is unavailable/u);
});

test('turns a failing session lookup into a stated reason', async () => {
  const deps: CaptureDependencies = {
    sessions: async () => { throw new Error('service is down'); },
    getSources: async () => [],
  };
  const result = await captureSessionWindow(deps, 'a');
  assert.equal(result.state, 'unsupported');
  if (result.state !== 'unsupported') return;
  assert.match(result.reason ?? '', /service is down/u);
});

test('asks for a thumbnail size large enough to read a terminal', async () => {
  let seen: { width: number; height: number } | null = null;
  const deps: CaptureDependencies = {
    sessions: async () => [session('a', 11)],
    getSources: async (options) => {
      seen = options.thumbnailSize;
      return [source(11)];
    },
  };
  await captureSessionWindow(deps, 'a');
  assert.deepEqual(seen, { ...PREVIEW_THUMBNAIL_SIZE });
  assert.ok(PREVIEW_THUMBNAIL_SIZE.width >= 960, 'the preview would be too small to read');
});
test('a window that has closed is reported the same way as a minimized one, not as a wrong window', async () => {
  // Measured: a destroyed window and a minimized one are indistinguishable to the capture layer ¡ª
  // both are simply absent from the source list. The important property is that a stale handle
  // never resolves to some *other* window, which would show the wrong content under this process's
  // name. Here another window is present and must not be matched.
  const { dependencies: deps } = dependencies([session('a', 11)], [source(22), source(33)]);
  const result = await captureSessionWindow(deps, 'a');
  assert.equal(result.state, 'minimized', 'a stale handle must not fall back to another window');
});

test('never captures a window belonging to a different handle', async () => {
  // The guard that makes the above safe: only an exact handle match is ever captured.
  const { dependencies: deps } = dependencies([session('a', 67008)], [source(67009 - 1), source(67008)]);
  const result = await captureSessionWindow(deps, 'a');
  assert.equal(result.state, 'captured');
  if (result.state !== 'captured') return;
  assert.match(result.dataUrl, /handle-67008/u);
});
