/**
 * The system tray.
 *
 * The app is a watchdog host: closing its window must not stop the service, so
 * the window hides and the tray becomes the way back in — and the only way out.
 * Like `navigation.ts`, the controller takes an injected tray/icon factory so it
 * can be unit-tested without Electron, and it degrades to a no-op when either is
 * missing rather than throwing during startup.
 */

import { RENDERER_COMMANDS, ACCOUNT_SECTION, type MenuItemTemplate, type RendererCommand } from './menu.js';

/** The tray's menu, top to bottom. Exported so tests assert the real labels. */
export const TRAY_MENU_LABELS = Object.freeze([
  '打开主界面',
  '设置',
  '开机自启',
  '关于 Selbstlauf',
  '退出',
] as const);

export interface TrayWindow {
  show(): void;
  focus(): void;
  isMinimized?(): boolean;
  restore?(): void;
}

export interface TrayLike {
  setToolTip?(tooltip: string): void;
  setContextMenu(menu: unknown): void;
  on(event: 'click', listener: () => void): void;
  destroy?(): void;
}

export interface TrayDependencies {
  /** Build a tray icon; returning null means "no tray on this machine". */
  createTray(icon: unknown): TrayLike | null;
  /** Build a native menu from a template. */
  buildMenu(template: readonly MenuItemTemplate[]): unknown;
  /** Load the branded icon; null falls back to an empty icon. */
  createIcon(path: string | undefined): unknown;
}

export interface TrayActions {
  /** The window the tray shows; null before one exists or after it is gone. */
  window(): TrayWindow | null;
  /** Tell the renderer to switch page/section. */
  send(command: RendererCommand, section?: string): void;
  /** Read the real startup-task state; null when the service is unreachable. */
  readStartup(): Promise<boolean | null>;
  /** Toggle the startup task and return what the service reports. */
  toggleStartup(installed: boolean): Promise<boolean | null>;
  /** Clean shutdown: stop the bundled service, then quit. */
  quit(): void;
}

export type TrayActionOptions = Pick<TrayActions, 'window' | 'send' | 'readStartup' | 'toggleStartup' | 'quit'>;

export interface TrayControllerOptions {
  readonly dependencies: TrayDependencies;
  readonly actions: TrayActions;
  readonly iconPath?: string;
}

export interface TrayController {
  /** The live tray, or null when the platform has none. */
  readonly tray: TrayLike | null;
  /** Re-read the startup state and repaint the menu checkbox. */
  refreshStartupState(): Promise<void>;
  /** Rebuild the context menu; Windows renders a static menu, so this matters. */
  rebuild(): void;
  destroy(): void;
}

/** The tray menu template.
 *
 * `state.installed` is whatever the service last reported: an unreachable
 * service leaves the box unchecked rather than guessing.
 */
export function buildTrayMenuTemplate(
  actions: Pick<TrayActions, 'window' | 'send' | 'toggleStartup' | 'quit'>,
  state: { readonly installed: boolean | null },
): MenuItemTemplate[] {
  const reveal = () => showWindow(actions.window());
  return [
    { label: TRAY_MENU_LABELS[0], click: reveal },
    { label: TRAY_MENU_LABELS[1], click: () => { reveal(); actions.send(RENDERER_COMMANDS.openSettings); } },
    {
      label: TRAY_MENU_LABELS[2],
      type: 'checkbox',
      checked: state.installed === true,
      click: (item?: { checked?: boolean }) => {
        void (async () => {
          // The item reports its new checked state; the service's answer is what
          // the checkbox ends up showing, so the menu is rebuilt from reality.
          const desired = typeof item?.checked === 'boolean' ? item.checked : state.installed !== true;
          await actions.toggleStartup(desired);
        })();
      },
    },
    { label: TRAY_MENU_LABELS[3], click: () => { reveal(); actions.send(RENDERER_COMMANDS.openSettings, ACCOUNT_SECTION); } },
    { type: 'separator' },
    { label: TRAY_MENU_LABELS[4], click: () => actions.quit() },
  ];
}

/** Bring the window to the foreground, restoring it if it was minimised. */
export function showWindow(window: TrayWindow | null): void {
  if (window === null) return;
  if (window.isMinimized?.() === true) window.restore?.();
  window.show();
  window.focus();
}

/**
 * Install the tray.
 *
 * Returns a controller whose `tray` is null when the platform has no tray
 * support or the icon could not be built — the app must still start and show its
 * window in that case.
 */
export function installTray(options: TrayControllerOptions): TrayController {
  let tray: TrayLike | null = null;
  let startupState: { installed: boolean | null } = { installed: null };
  try {
    // The icon is optional: without it the tray still works, just unbranded.
    const icon = options.dependencies.createIcon(options.iconPath);
    tray = options.dependencies.createTray(icon);
  } catch {
    tray = null;
  }

  const rebuild = (): void => {
    if (tray === null) return;
    try {
      tray.setContextMenu(options.dependencies.buildMenu(buildTrayMenuTemplate(options.actions, startupState)));
    } catch {
      // A tray that cannot render its menu must not take the app down with it.
    }
  };

  if (tray !== null) {
    try {
      tray.setToolTip?.('Selbstlauf');
      // Left click is the "get my window back" gesture on Windows.
      tray.on('click', () => showWindow(options.actions.window()));
      rebuild();
    } catch {
      tray = null;
    }
  }

  return {
    get tray() {
      return tray;
    },
    rebuild,
    async refreshStartupState(): Promise<void> {
      let installed: boolean | null = null;
      try {
        installed = await options.actions.readStartup();
      } catch {
        installed = null;
      }
      startupState = { installed };
      rebuild();
    },
    destroy(): void {
      try {
        tray?.destroy?.();
      } catch {
        // Destroying an already-gone tray is not an error worth surfacing.
      }
      tray = null;
    },
  };
}