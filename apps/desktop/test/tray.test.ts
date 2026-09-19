import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRAY_MENU_LABELS,
  installTray,
  showWindow,
  type TrayActionOptions,
  type TrayWindow,
} from '../src/tray.js';
import { ACCOUNT_SECTION, RENDERER_COMMANDS, type MenuItemTemplate } from '../src/menu.js';

interface WindowSpy extends TrayWindow {
  shown: number;
  focused: number;
  restored: number;
  minimised: boolean;
}

function windowSpy(): WindowSpy {
  return {
    shown: 0,
    focused: 0,
    restored: 0,
    minimised: false,
    show() {
      this.shown += 1;
    },
    focus() {
      this.focused += 1;
    },
    isMinimized() {
      return this.minimised;
    },
    restore() {
      this.restored += 1;
    },
  };
}

interface TrayHarness {
  readonly menus: MenuItemTemplate[][];
  readonly tooltips: string[];
  readonly clicks: Array<() => void>;
  readonly destroyed: { count: number };
  readonly window: WindowSpy;
  readonly sent: Array<{ command: string; section?: string }>;
  readonly toggles: boolean[];
  readonly quits: { count: number };
  /** What the service reports; the menu checkbox must follow this. */
  serviceInstalled: boolean | null;
  readonly controller: ReturnType<typeof installTray>;
  labels(): string[];
  item(label: string): MenuItemTemplate | undefined;
  template(): MenuItemTemplate[];
}

function harness(options: { tray?: boolean; trayThrows?: boolean } = {}): TrayHarness {
  const menus: MenuItemTemplate[][] = [];
  const tooltips: string[] = [];
  const clicks: Array<() => void> = [];
  const destroyed = { count: 0 };
  const sent: Array<{ command: string; section?: string }> = [];
  const toggles: boolean[] = [];
  const quits = { count: 0 };
  const window = windowSpy();
  const state: { serviceInstalled: boolean | null } = { serviceInstalled: false };

  const actions: TrayActionOptions = {
    window: () => window,
    send: (command, section) => {
      sent.push(section === undefined ? { command } : { command, section });
    },
    readStartup: async () => state.serviceInstalled,
    toggleStartup: async (installed) => {
      toggles.push(installed);
      // The service is the source of truth and re-reads after the toggle.
      state.serviceInstalled = installed;
      return state.serviceInstalled;
    },
    quit: () => {
      quits.count += 1;
    },
  };

  const controller = installTray({
    dependencies: {
      createIcon: (path) => path ?? null,
      createTray: (icon) => {
        if (options.tray === false) return null;
        if (options.trayThrows === true) throw new Error('no tray on this platform');
        assert.equal(icon, 'build/icon.ico');
        return {
          setToolTip: (tooltip: string) => tooltips.push(tooltip),
          setContextMenu: (menu: unknown) => menus.push(menu as MenuItemTemplate[]),
          on: (_event: 'click', listener: () => void) => clicks.push(listener),
          destroy: () => {
            destroyed.count += 1;
          },
        };
      },
      buildMenu: (template) => [...template],
    },
    actions,
    iconPath: 'build/icon.ico',
  });

  const template = () => menus.at(-1) ?? [];
  return {
    menus,
    tooltips,
    clicks,
    destroyed,
    window,
    sent,
    toggles,
    quits,
    controller,
    get serviceInstalled() {
      return state.serviceInstalled;
    },
    set serviceInstalled(value: boolean | null) {
      state.serviceInstalled = value;
    },
    labels: () => template().filter((entry) => entry.type !== 'separator').map((entry) => entry.label ?? ''),
    item: (label: string) => template().find((entry) => entry.label === label),
    template,
  };
}

test('offers the tray menu with its labels in order', () => {
  const spy = harness();
  assert.deepEqual([...TRAY_MENU_LABELS], ['打开主界面', '设置', '开机自启', '关于 Selbstlauf', '退出']);
  assert.deepEqual(spy.labels(), ['打开主界面', '设置', '开机自启', '关于 Selbstlauf', '退出']);
  // The separator sits between the actions and the exit.
  assert.equal(spy.template().at(-2)?.type, 'separator');
  assert.equal(spy.template().at(-1)?.label, '退出');
  assert.deepEqual(spy.tooltips, ['Selbstlauf']);
});

test('left click shows and focuses the window, restoring it when minimised', () => {
  const spy = harness();
  assert.equal(spy.clicks.length, 1, 'the click handler is registered');
  spy.clicks[0]!();
  assert.deepEqual(
    { show: spy.window.shown, focus: spy.window.focused, restore: spy.window.restored },
    { show: 1, focus: 1, restore: 0 },
  );

  spy.window.minimised = true;
  spy.clicks[0]!();
  assert.equal(spy.window.restored, 1, 'a minimised window is restored first');
  assert.equal(spy.window.shown, 2);
});

test('设置 and 关于 Selbstlauf reveal the window and send the right commands', () => {
  const spy = harness();
  spy.item('设置')?.click?.();
  assert.deepEqual(spy.sent, [{ command: RENDERER_COMMANDS.openSettings }]);
  assert.equal(spy.window.shown, 1);

  spy.item('关于 Selbstlauf')?.click?.();
  assert.deepEqual(spy.sent.at(-1), { command: RENDERER_COMMANDS.openSettings, section: ACCOUNT_SECTION });
  assert.equal(ACCOUNT_SECTION, 'account');
  assert.equal(spy.window.shown, 2);
  assert.equal(spy.window.focused, 2);

  spy.item('打开主界面')?.click?.();
  assert.equal(spy.window.shown, 3);
  assert.deepEqual(spy.sent.length, 2, 'opening the main window sends no command');
});

test('退出 is the only quit, and it runs the clean shutdown', () => {
  const spy = harness();
  assert.equal(spy.quits.count, 0, 'installing the tray does not quit');
  spy.item('退出')?.click?.();
  assert.equal(spy.quits.count, 1);
});

test('the 开机自启 checkbox follows what the service reports', async () => {
  const spy = harness();
  assert.equal(spy.item('开机自启')?.checked, false);

  // The service reports "installed": the repaint shows it, not the click.
  spy.serviceInstalled = true;
  await spy.controller.refreshStartupState();
  assert.equal(spy.item('开机自启')?.checked, true);

  // Toggling off asks for the uninstall path and the box follows the service.
  spy.item('开机自启')?.click?.({ checked: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(spy.toggles, [false]);
  assert.equal(spy.serviceInstalled, false);
});

test('the checkbox is not repainted optimistically by the click alone', async () => {
  const spy = harness();
  assert.equal(spy.item('开机自启')?.checked, false);
  // The install fails silently: the service still reports "not installed".
  spy.controller.rebuild();
  assert.equal(spy.item('开机自启')?.checked, false, 'the menu never shows a requested-but-unconfirmed state');
  const before = spy.menus.length;
  spy.item('开机自启')?.click?.({ checked: true });
  await new Promise((resolve) => setImmediate(resolve));
  // The click itself does not build a menu; main.ts refreshes after the toggle,
  // which is what repaints the box from the service's answer.
  assert.equal(spy.menus.length, before);
});

test('an unreachable service leaves the checkbox unchecked but clickable', async () => {
  const spy = harness();
  spy.serviceInstalled = null;
  await spy.controller.refreshStartupState();
  const item = spy.item('开机自启');
  assert.equal(item?.checked, false, 'an unreachable service is not guessed at');
  assert.notEqual(item?.enabled, false, 'the item stays clickable for a later retry');
});

test('a missing Tray class or a throwing tray never breaks startup', () => {
  const noTrayClass = harness({ tray: false });
  assert.equal(noTrayClass.menus.length, 0, 'no menu is built without a tray');
  assert.equal(noTrayClass.controller.tray, null);
  assert.equal(noTrayClass.quits.count, 0);

  const throwing = harness({ trayThrows: true });
  assert.equal(throwing.controller.tray, null, 'a throwing Tray degrades to no tray');
  assert.equal(throwing.menus.length, 0);
});

test('an unreadable icon still yields a working tray', () => {
  const controller = installTray({
    dependencies: {
      createIcon: () => null,
      createTray: () => ({
        setContextMenu: () => undefined,
        on: () => undefined,
        destroy: () => undefined,
      }),
      buildMenu: () => null,
    },
    actions: {
      window: () => null,
      send: () => undefined,
      readStartup: async () => null,
      toggleStartup: async () => null,
      quit: () => undefined,
    },
  });
  assert.notEqual(controller.tray, null);
  controller.destroy();
});

test('destroying the tray is idempotent', () => {
  const spy = harness();
  spy.controller.destroy();
  spy.controller.destroy();
  assert.equal(spy.destroyed.count, 1);
  assert.equal(spy.controller.tray, null);
});

test('showWindow does nothing without a window', () => {
  showWindow(null);
});