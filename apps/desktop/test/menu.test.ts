import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCOUNT_SECTION,
  MENU_LABELS,
  PROJECT_HOMEPAGE,
  RENDERER_COMMANDS,
  buildApplicationMenu,
  type MenuItemTemplate,
} from '../src/menu.js';
import { type DesktopLocale } from '../src/locale.js';

interface Recorder {
  readonly sent: Array<{ command: string; section?: string }>;
  readonly opened: string[];
  readonly hidden: { count: number };
  readonly actions: {
    send(command: string, section?: string): void;
    hide(): void;
    openExternal(url: string): void;
  };
}

function recorder(): Recorder {
  const sent: Array<{ command: string; section?: string }> = [];
  const opened: string[] = [];
  const hidden = { count: 0 };
  return {
    sent,
    opened,
    hidden,
    actions: {
      send: (command: string, section?: string) => {
        sent.push(section === undefined ? { command } : { command, section });
      },
      hide: () => {
        hidden.count += 1;
      },
      openExternal: (url: string) => opened.push(url),
    },
  };
}

function submenuOf(template: readonly MenuItemTemplate[], label: string): readonly MenuItemTemplate[] {
  const item = template.find((entry) => entry.label === label);
  assert.ok(item, `top-level item ${label} exists`);
  assert.ok(item.submenu, `top-level item ${label} has a submenu`);
  return item.submenu;
}

function labels(items: readonly MenuItemTemplate[]): string[] {
  return items.filter((item) => item.type !== 'separator').map((item) => item.label ?? '');
}

test('builds exactly the four top-level labels in order', () => {
  const template = buildApplicationMenu(recorder().actions);
  assert.deepEqual(template.map((item) => item.label), ['文件', '编辑', '视图', '帮助']);
  assert.deepEqual([...MENU_LABELS], ['文件', '编辑', '视图', '帮助']);
});

test('文件 offers 返回应用 and hides to the tray instead of quitting', () => {
  const spy = recorder();
  const template = buildApplicationMenu(spy.actions);
  const file = submenuOf(template, '文件');
  assert.deepEqual(labels(file), ['返回应用', '隐藏到托盘']);
  assert.deepEqual(file.map((item) => item.type ?? 'normal'), ['normal', 'separator', 'normal']);
  // There must be no quit affordance anywhere in the window's own menus; the
  // tray owns the only real exit.
  assert.equal(
    template.some((item) => (item.submenu ?? []).some((entry) => entry.role === 'quit')),
    false,
  );

  const back = file.find((item) => item.label === '返回应用');
  back?.click?.();
  assert.deepEqual(spy.sent, [{ command: RENDERER_COMMANDS.backToApp }]);

  const hide = file.find((item) => item.label === '隐藏到托盘');
  hide?.click?.();
  assert.equal(spy.hidden.count, 1);
});

test('编辑 uses the standard Electron roles', () => {
  const template = buildApplicationMenu(recorder().actions);
  const edit = submenuOf(template, '编辑');
  assert.deepEqual(labels(edit), ['撤销', '重做', '剪切', '复制', '粘贴', '全选']);
  assert.deepEqual(
    edit.filter((item) => item.type !== 'separator').map((item) => item.role),
    ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'],
  );
  // The separator sits between the history pair and the clipboard group.
  assert.equal(edit[2]?.type, 'separator');
});

test('视图 exposes reload, the zoom ladder, and full screen', () => {
  const template = buildApplicationMenu(recorder().actions);
  const view = submenuOf(template, '视图');
  assert.deepEqual(labels(view), ['重新加载', '实际大小', '放大', '缩小', '切换全屏']);
  assert.deepEqual(
    view.filter((item) => item.type !== 'separator').map((item) => item.role),
    ['reload', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen'],
  );
  // Every entry keeps a keyboard shortcut, since the bar itself is not painted.
  for (const item of view.filter((entry) => entry.type !== 'separator')) {
    assert.equal(typeof item.accelerator, 'string', `${item.label} has an accelerator`);
  }
});

test('帮助 opens the project homepage and the about section', () => {
  const spy = recorder();
  const template = buildApplicationMenu(spy.actions);
  const help = submenuOf(template, '帮助');
  assert.deepEqual(labels(help), ['项目主页', '关于 Selbstlauf']);

  help.find((item) => item.label === '项目主页')?.click?.();
  assert.deepEqual(spy.opened, [PROJECT_HOMEPAGE]);
  assert.equal(PROJECT_HOMEPAGE, 'https://github.com/dieWehmut/Selbstlauf');

  help.find((item) => item.label === '关于 Selbstlauf')?.click?.();
  assert.deepEqual(spy.sent, [{ command: RENDERER_COMMANDS.openSettings, section: ACCOUNT_SECTION }]);
  assert.equal(ACCOUNT_SECTION, 'account');
});

for (const [locale, expected] of Object.entries({
  'zh-CN': ['文件', '编辑', '视图', '帮助', '关于 Selbstlauf', '粘贴'],
  'zh-TW': ['檔案', '編輯', '檢視', '說明', '關於 Selbstlauf', '貼上'],
  en: ['File', 'Edit', 'View', 'Help', 'About Selbstlauf', 'Paste'],
  ja: ['ファイル', '編集', '表示', 'ヘルプ', 'Selbstlauf について', '貼り付け'],
})) {
  test(`${locale} localizes native menus while preserving roles, accelerators and actions`, () => {
    const spy = recorder();
    const template = buildApplicationMenu(spy.actions, locale as DesktopLocale);
    assert.deepEqual(template.map((item) => item.label), expected.slice(0, 4));
    assert.equal(template[1]?.submenu?.find((item) => item.role === 'paste')?.label, expected[5]);
    assert.equal(template[3]?.submenu?.at(-1)?.label, expected[4]);
    const behavior = (items: readonly MenuItemTemplate[]): unknown[] => items.map(({ role, accelerator, type, submenu }) => ({ role, accelerator, type, submenu: submenu === undefined ? undefined : behavior(submenu) }));
    assert.deepEqual(behavior(template), behavior(buildApplicationMenu(recorder().actions)));
    template[0]?.submenu?.[0]?.click?.();
    template[3]?.submenu?.at(-1)?.click?.();
    assert.deepEqual(spy.sent, [{ command: RENDERER_COMMANDS.backToApp }, { command: RENDERER_COMMANDS.openSettings, section: ACCOUNT_SECTION }]);
  });
}
