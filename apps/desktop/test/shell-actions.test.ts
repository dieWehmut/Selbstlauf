import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHELL_ACTIONS,
  applyAsyncShellAction,
  applyShellAction,
  isAsyncShellAction,
  isHexColor,
  isShellAction,
  isWindowPreviewResult,
  isZoomDelta,
  parseShellRequest,
  type ShellActionContext,
} from '../src/shell-actions.js';

interface Harness {
  readonly context: ShellActionContext;
  readonly reloads: number;
  readonly fullScreens: number;
  readonly levels: number[];
  readonly opened: string[];
  readonly quits: number;
  readonly overlays: Array<{ color: string; symbolColor?: string }>;
  zoomLevel(): number;
}

function harness(options: { zoomable?: boolean } = {}): Harness {
  const state = { reloads: 0, fullScreens: 0, opened: [] as string[], quits: 0, current: 0 };
  const levels: number[] = [];
  const overlays: Array<{ color: string; symbolColor?: string }> = [];
  const zoomable = options.zoomable ?? true;
  const context: ShellActionContext = {
    window: {
      reload: () => {
        state.reloads += 1;
      },
      toggleFullScreen: () => {
        state.fullScreens += 1;
      },
      ...(zoomable
        ? {
            webContents: {
              getZoomLevel: () => state.current,
              setZoomLevel: (level: number) => {
                state.current = level;
                levels.push(level);
              },
            },
          }
        : {}),
    },
    quit: () => {
      state.quits += 1;
    },
    openExternal: (url: string) => {
      state.opened.push(url);
    },
    setTitleBarOverlay: (colors) => {
      overlays.push(colors);
    },
  };
  return {
    context,
    overlays,
    get reloads() {
      return state.reloads;
    },
    get fullScreens() {
      return state.fullScreens;
    },
    get opened() {
      return state.opened;
    },
    get quits() {
      return state.quits;
    },
    levels,
    zoomLevel: () => state.current,
  };
}

test('maps each action name to its Electron call', () => {
  const spy = harness();
  applyShellAction(spy.context, { action: 'reload' });
  assert.equal(spy.reloads, 1);

  applyShellAction(spy.context, { action: 'toggleFullScreen' });
  assert.equal(spy.fullScreens, 1);

  applyShellAction(spy.context, { action: 'quit' });
  assert.equal(spy.quits, 1);
});

test('walks the zoom ladder additively and resets to zero', () => {
  const spy = harness();
  applyShellAction(spy.context, { action: 'zoom', delta: 1 });
  applyShellAction(spy.context, { action: 'zoom', delta: 1 });
  applyShellAction(spy.context, { action: 'zoom', delta: -1 });
  assert.deepEqual(spy.levels, [1, 2, 1]);
  applyShellAction(spy.context, { action: 'zoom', delta: 0 });
  assert.equal(spy.zoomLevel(), 0, '实际大小 goes back to 100%');
  // A malformed delta is treated as "reset" rather than throwing.
  applyShellAction(spy.context, { action: 'zoom', delta: 42 });
  assert.equal(spy.zoomLevel(), 0);
});

test('opens absolute http(s) URLs externally', () => {
  const spy = harness();
  applyShellAction(spy.context, { action: 'openExternal', url: 'https://github.com/dieWehmut/Selbstlauf' });
  applyShellAction(spy.context, { action: 'openExternal', url: 'http://127.0.0.1:48920/' });
  assert.deepEqual(spy.opened, ['https://github.com/dieWehmut/Selbstlauf', 'http://127.0.0.1:48920/']);
});

test('refuses every non-http(s) URL before it reaches the OS', () => {
  const spy = harness();
  const refused = [
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'javascript:alert(1)',
    'ms-settings:',
    'data:text/html,<h1>hi</h1>',
    '',
    'not a url',
  ];
  for (const url of refused) {
    assert.throws(
      () => applyShellAction(spy.context, { action: 'openExternal', url }),
      /non-http\(s\) URL/u,
      `${url} is refused`,
    );
  }
  assert.deepEqual(spy.opened, [], 'nothing was handed to the OS browser');
});

test('rejects unknown actions and malformed payloads', () => {
  // Pinned so the renderer's reachable surface cannot grow without this test being updated.
  //
  // `windowType` is a deliberate addition: the user asked for the ability to drive a window's contents, and chose
  // to accept that it takes the foreground briefly. It goes through the same session-id indirection as
  // `windowPreview`, so the renderer still never names a window.
  assert.deepEqual(
    [...SHELL_ACTIONS],
    ['reload', 'toggleFullScreen', 'zoom', 'quit', 'openExternal', 'setTitleBarOverlay', 'windowPreview', 'windowType'],
  );
  assert.equal(isShellAction('reload'), true);
  assert.equal(isShellAction('eval'), false);
  assert.equal(isShellAction(null), false);
  assert.deepEqual([isZoomDelta(1), isZoomDelta(-1), isZoomDelta(0)], [true, true, true]);
  assert.equal(isZoomDelta(2), false);

  assert.throws(() => parseShellRequest(null), /must be an object/u);
  assert.throws(() => parseShellRequest({ action: 'exec' }), /unknown shell action/u);
  assert.deepEqual(parseShellRequest({ action: 'zoom', delta: -1 }), { action: 'zoom', delta: -1 });
  assert.deepEqual(parseShellRequest({ action: 'reload' }), { action: 'reload' });
  assert.throws(
    () => applyShellAction(harness().context, { action: 'nope' } as never),
    /unknown shell action/u,
  );
});

/**
 * Regression: the page title bar is painted from the live palette, so it changes
 * with the theme, the contrast slider and the accent. A fixed overlay colour left
 * the OS-drawn window buttons on a visibly different strip — measured on a real
 * window as #0B1120 against a #1A1E22 bar. The renderer now reports the colour it
 * actually painted.
 */
test('repaints the native window-button strip with the renderer-supplied colours', () => {
  const spy = harness();
  applyShellAction(spy.context, { action: 'setTitleBarOverlay', color: '#1a1e22', symbolColor: '#e9eef0' });
  assert.deepEqual(spy.overlays, [{ color: '#1a1e22', symbolColor: '#e9eef0' }]);

  // The symbol colour is optional; the strip colour alone is enough.
  applyShellAction(spy.context, { action: 'setTitleBarOverlay', color: '#eef2f1' });
  assert.deepEqual(spy.overlays[1], { color: '#eef2f1' });

  assert.deepEqual(parseShellRequest({ action: 'setTitleBarOverlay', color: '#112233' }), {
    action: 'setTitleBarOverlay',
    color: '#112233',
  });
});

test('refuses a malformed overlay colour instead of repainting the strip', () => {
  const spy = harness();
  assert.equal(isHexColor('#1a1e22'), true);
  assert.equal(isHexColor('#AABBCC'), true);
  assert.equal(isHexColor('#12345'), false);
  assert.equal(isHexColor(null), false);
  for (const color of ['#12345', '1a1e22', '#gggggg', 'red', 'rgb(1,2,3)', '']) {
    assert.throws(
      () => applyShellAction(spy.context, { action: 'setTitleBarOverlay', color }),
      /non-#rrggbb overlay colour/u,
      `${JSON.stringify(color)} is refused`,
    );
  }
  // A bad symbol colour is refused rather than silently applied.
  assert.throws(
    () => applyShellAction(spy.context, { action: 'setTitleBarOverlay', color: '#1a1e22', symbolColor: 'white' }),
    /non-#rrggbb overlay symbol colour/u,
  );
  assert.deepEqual(spy.overlays, [], 'nothing was repainted');
});

test('a window that cannot repaint its overlay is left alone rather than throwing', () => {
  const context = harness().context;
  const withoutOverlay: ShellActionContext = {
    window: context.window,
    quit: context.quit,
    openExternal: context.openExternal,
  };
  applyShellAction(withoutOverlay, { action: 'setTitleBarOverlay', color: '#1a1e22' });
});

test('a window without a zoom target is left alone rather than throwing', () => {
  const spy = harness({ zoomable: false });
  applyShellAction(spy.context, { action: 'zoom', delta: 1 });
  assert.deepEqual(spy.levels, []);
  assert.equal(spy.quits, 0);
});
/**
 * The window-preview action is dispatched asynchronously, so it is exercised separately.
 *
 * It is the one action that must await a capture, and it is keyed by session id rather than by a
 * window handle: the main process resolves the window through the service's own session list, so
 * the renderer can never name an arbitrary window on the machine.
 */
test('windowPreview takes a session id and returns the capture', async () => {
  const asked: string[] = [];
  const context: ShellActionContext = {
    window: { reload: () => undefined },
    quit: () => undefined,
    openExternal: () => undefined,
    previewWindow: (sessionId) => {
      asked.push(sessionId);
      return { state: 'captured', dataUrl: 'data:image/png;base64,abc', width: 960, height: 600, sharedBy: 1 };
    },
  };

  const result = await applyAsyncShellAction(context, { action: 'windowPreview', sessionId: 'codex:1' });
  assert.ok(isWindowPreviewResult(result), 'expected a preview result');
  assert.deepEqual(asked, ['codex:1']);
  assert.equal(result.state, 'captured');
});

test('windowPreview refuses an empty session id instead of previewing some default window', async () => {
  let called = 0;
  const context: ShellActionContext = {
    window: { reload: () => undefined },
    quit: () => undefined,
    openExternal: () => undefined,
    previewWindow: () => {
      called += 1;
      return { state: 'no-window' };
    },
  };

  for (const sessionId of ['', undefined]) {
    const result = await applyAsyncShellAction(context, { action: 'windowPreview', ...(sessionId === undefined ? {} : { sessionId }) });
  assert.ok(isWindowPreviewResult(result), 'expected a preview result');
    assert.equal(result.state, 'unsupported');
  }
  assert.equal(called, 0, 'no lookup was attempted without a session id');
});

test('windowPreview reports itself unavailable when the shell has no capturer', async () => {
  const context: ShellActionContext = {
    window: { reload: () => undefined },
    quit: () => undefined,
    openExternal: () => undefined,
  };
  const result = await applyAsyncShellAction(context, { action: 'windowPreview', sessionId: 'a' });
  assert.ok(isWindowPreviewResult(result), 'expected a preview result');
  assert.equal(result.state, 'unsupported');
});

test('a throwing capturer becomes a stated outcome rather than crossing IPC as an error', async () => {
  const context: ShellActionContext = {
    window: { reload: () => undefined },
    quit: () => undefined,
    openExternal: () => undefined,
    previewWindow: () => { throw new Error('capture exploded'); },
  };
  const result = await applyAsyncShellAction(context, { action: 'windowPreview', sessionId: 'a' });
  assert.ok(isWindowPreviewResult(result), 'expected a preview result');
  assert.equal(result.state, 'unsupported');
  if (result.state !== 'unsupported') return;
  assert.match(result.reason ?? '', /capture exploded/u);
});

test('the asynchronous dispatcher refuses a synchronous action', async () => {
  await assert.rejects(
    () => applyAsyncShellAction(harness().context, { action: 'reload' }),
    /not an async shell action/u,
  );
});

test('the synchronous dispatcher refuses the asynchronous action', () => {
  // Reaching here would mean a caller skipped the await, which is a programming error.
  assert.throws(
    () => applyShellAction(harness().context, { action: 'windowPreview', sessionId: 'a' }),
    /windowPreview is asynchronous/u,
  );
  assert.equal(isAsyncShellAction('windowPreview'), true);
  assert.equal(isAsyncShellAction('reload'), false);
});
