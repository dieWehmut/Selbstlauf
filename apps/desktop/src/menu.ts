import { DEFAULT_DESKTOP_LOCALE, nativeMessage, type DesktopLocale } from './locale.js';

/**
 * The application menu template.
 *
 * With a hidden title bar the native menu bar is not painted, so the same items
 * are mirrored by the renderer's own `文件 编辑 视图 帮助` row. The template is
 * still installed because it keeps the standard accelerators (Ctrl+C, Ctrl+R,
 * zoom, F11) alive and because Alt reveals it as an escape hatch.
 *
 * The builder is pure and dependency-injected: it returns a plain template and
 * never imports Electron, so it is unit-testable and the main process owns the
 * `Menu.buildFromTemplate` call.
 */

/** Absolute http(s) links only; anything else is refused before it reaches the OS. */
export const PROJECT_HOMEPAGE = 'https://github.com/dieWehmut/Selbstlauf';

/** Renderer commands the desktop shell may send over the preload bridge. */
export const RENDERER_COMMANDS = Object.freeze({
  /** Land on the process overview page and close the drawer. */
  backToApp: 'back-to-app',
  /** Open the settings page, optionally focused on one section. */
  openSettings: 'open-settings',
} as const);

export type RendererCommand = (typeof RENDERER_COMMANDS)[keyof typeof RENDERER_COMMANDS];

/** The settings section the tray's "about" entry focuses. */
export const ACCOUNT_SECTION = 'account';

export interface ApplicationMenuActions {
  /** Hand a named command to the renderer; the preload bridge relays it. */
  send(command: RendererCommand, section?: string): void;
  /** Hide the window to the tray; this replaces the old in-window quit item. */
  hide(): void;
  /** Open an absolute http(s) URL in the user's normal browser. */
  openExternal(url: string): void;
}

/**
 * A plain Electron menu item.
 *
 * Only the members this app actually builds are modelled, which keeps the
 * template checkable without pulling in Electron's type definitions.
 */
export interface MenuItemTemplate {
  readonly label?: string;
  /** A built-in Electron behaviour; `label` localises it. */
  readonly role?: string;
  readonly type?: 'normal' | 'separator' | 'checkbox';
  readonly accelerator?: string;
  readonly checked?: boolean;
  readonly enabled?: boolean;
  /** Electron passes the built menu item; checkbox items read `checked` back. */
  readonly click?: (item?: { checked?: boolean }) => void;
  readonly submenu?: readonly MenuItemTemplate[];
}

/** The four top-level labels, in the order the reference layout presents them. */
export const MENU_LABELS = Object.freeze(['文件', '编辑', '视图', '帮助'] as const);

/**
 * Build the application menu template.
 *
 * `文件` deliberately has no quit item: closing the window hides it to the tray,
 * and the only real quit affordance is the tray menu's `退出`.
 */
export function buildApplicationMenu(actions: ApplicationMenuActions, locale: DesktopLocale = DEFAULT_DESKTOP_LOCALE): MenuItemTemplate[] {
  const t = (key: Parameters<typeof nativeMessage>[1]) => nativeMessage(locale, key);
  const editItems: readonly MenuItemTemplate[] = [
    { label: t('undo'), role: 'undo' },
    { label: t('redo'), role: 'redo' },
    { type: 'separator' },
    { label: t('cut'), role: 'cut' },
    { label: t('copy'), role: 'copy' },
    { label: t('paste'), role: 'paste' },
    { label: t('selectAll'), role: 'selectAll' },
  ];
  // Accelerators are declared explicitly so the items keep working even though
  // the bar itself is not painted behind the custom title bar.
  const viewItems: readonly MenuItemTemplate[] = [
    { label: t('reload'), role: 'reload', accelerator: 'CmdOrCtrl+R' },
    { type: 'separator' },
    { label: t('actualSize'), role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
    { label: t('zoomIn'), role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' },
    { label: t('zoomOut'), role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
    { type: 'separator' },
    { label: t('fullscreen'), role: 'togglefullscreen', accelerator: 'F11' },
  ];

  return [
    {
      label: t('file'),
      submenu: [
        { label: t('back'), click: () => actions.send(RENDERER_COMMANDS.backToApp) },
        { type: 'separator' },
        { label: t('hide'), click: () => actions.hide() },
      ],
    },
    { label: t('edit'), submenu: [...editItems] },
    { label: t('view'), submenu: [...viewItems] },
    {
      label: t('help'),
      submenu: [
        { label: t('homepage'), click: () => actions.openExternal(PROJECT_HOMEPAGE) },
        {
          label: t('about'),
          click: () => actions.send(RENDERER_COMMANDS.openSettings, ACCOUNT_SECTION),
        },
      ],
    },
  ];
}