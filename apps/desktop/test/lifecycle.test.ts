import test from 'node:test';
import assert from 'node:assert/strict';

import { createLifecycle, type CloseEvent } from '../src/lifecycle.js';

interface WindowSpy {
  hidden: number;
  shown: number;
  focused: number;
  restored: number;
}

function fakeWindow(): WindowSpy {
  return { hidden: 0, shown: 0, focused: 0, restored: 0 };
}

function closeEvent(): CloseEvent & { prevented: number } {
  const event = {
    prevented: 0,
    preventDefault() {
      event.prevented += 1;
    },
  };
  return event;
}

function lifecycleWith(options: { closeToTray?: boolean; hasTray?: boolean } = {}) {
  const window = fakeWindow();
  const log = { stopped: 0, trayDestroyed: 0, quit: 0 };
  const lifecycle = createLifecycle({
    window: () => ({
      hide: () => {
        window.hidden += 1;
      },
      show: () => {
        window.shown += 1;
      },
      focus: () => {
        window.focused += 1;
      },
      isMinimized: () => false,
      restore: () => {
        window.restored += 1;
      },
    }),
    closeToTray: () => options.closeToTray ?? true,
    hasTray: () => options.hasTray ?? true,
    shutdown: {
      stopService: async () => {
        log.stopped += 1;
      },
      destroyTray: () => {
        log.trayDestroyed += 1;
      },
      quit: () => {
        log.quit += 1;
      },
    },
  });
  return { lifecycle, window, log };
}

test('closing the window hides it instead of quitting, and leaves the service running', () => {
  const { lifecycle, window, log } = lifecycleWith({ closeToTray: true, hasTray: true });
  const event = closeEvent();
  assert.equal(lifecycle.handleWindowClose(event), true);
  assert.equal(event.prevented, 1, 'the default close is cancelled');
  assert.equal(window.hidden, 1);
  // The whole point of hide-to-tray: the bundled watchdog must not be stopped.
  assert.equal(log.stopped, 0);
  assert.equal(log.quit, 0);
});

test('a live tray keeps the app resident when every window is gone', () => {
  const { lifecycle, log } = lifecycleWith({ hasTray: true });
  assert.equal(lifecycle.handleWindowAllClosed(), false, 'window-all-closed must not quit while the tray lives');
  assert.equal(log.quit, 0);
  assert.equal(log.stopped, 0, 'the service keeps running for a resident app');
});

test('quitting from the tray stops the service, destroys the tray, then quits', async () => {
  const { lifecycle, log } = lifecycleWith({ hasTray: true });
  await lifecycle.shutdown();
  assert.deepEqual(log, { stopped: 1, trayDestroyed: 1, quit: 1 });
});

test('the clean shutdown runs its work exactly once when paths race', async () => {
  const { lifecycle, log } = lifecycleWith({ hasTray: false });
  await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]);
  assert.equal(log.stopped, 1, 'the service is stopped once, not twice');
  assert.equal(log.quit, 1);
});

test('closeToTray false quits through the normal path', async () => {
  const { lifecycle, window, log } = lifecycleWith({ closeToTray: false, hasTray: true });
  const event = closeEvent();
  assert.equal(lifecycle.handleWindowClose(event), false, 'the close proceeds normally');
  assert.equal(event.prevented, 0);
  assert.equal(window.hidden, 0);
  // With the close allowed through, the window is destroyed and the app-level
  // handler performs the same clean shutdown the app always did.
  assert.equal(lifecycle.handleWindowAllClosed(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(log.stopped, 1);
  assert.equal(log.quit, 1);
});

test('without a tray the window closes normally so the app cannot go invisible', () => {
  const { lifecycle, window, log } = lifecycleWith({ closeToTray: true, hasTray: false });
  const event = closeEvent();
  assert.equal(lifecycle.handleWindowClose(event), false, 'there is nothing to hide into');
  assert.equal(event.prevented, 0);
  assert.equal(window.hidden, 0);
  assert.equal(lifecycle.handleWindowAllClosed(), true, 'no tray and no window means quit');
  assert.equal(log.stopped, 1);
});

test('an in-flight shutdown does not hide the window again', async () => {
  const { lifecycle, window } = lifecycleWith({ closeToTray: true, hasTray: true });
  await lifecycle.shutdown();
  const event = closeEvent();
  assert.equal(lifecycle.handleWindowClose(event), false);
  assert.equal(event.prevented, 0);
  assert.equal(window.hidden, 0);
});