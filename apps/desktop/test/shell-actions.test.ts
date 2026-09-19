import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHELL_ACTIONS,
  applyShellAction,
  isHexColor,
  isShellAction,
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
  assert.deepEqual(
    [...SHELL_ACTIONS],
    ['reload', 'toggleFullScreen', 'zoom', 'quit', 'openExternal', 'setTitleBarOverlay'],
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