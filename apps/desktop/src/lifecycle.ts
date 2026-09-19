/**
 * Window and application lifecycle.
 *
 * The app hosts a watchdog service that must keep running when nobody is
 * looking at it, so closing the window hides it to the tray. The only real quit
 * is the tray menu's `退出`, which stops the bundled service, destroys the tray,
 * and then quits. Keeping this logic here — against a small injected window
 * surface — makes the "closing must not stop the service" rule directly
 * testable without launching Electron.
 */

export interface LifecycleWindow {
  hide(): void;
  destroy?(): void;
  isDestroyed?(): boolean;
  show(): void;
  focus(): void;
  isMinimized?(): boolean;
  restore?(): void;
}

export interface CloseEvent {
  preventDefault(): void;
}

export interface ShutdownHooks {
  /** Stop the bundled service host; must be safe to call once. */
  stopService(): Promise<void>;
  /** Destroy the tray so the process can exit. */
  destroyTray(): void;
  /** Final Electron `app.quit()`. */
  quit(): void;
}

export interface LifecycleOptions {
  /** Read at close time; null once the window is gone. */
  readonly window: () => LifecycleWindow | null;
  /** Read at close time, so toggling the setting takes effect immediately. */
  readonly closeToTray: () => boolean;
  readonly shutdown: ShutdownHooks;
  /** True while a tray exists; a window-all-closed event must not quit then. */
  readonly hasTray: () => boolean;
}

export interface Lifecycle {
  /**
   * The window's `close` handler. Returns true when the close was turned into a
   * hide, so callers (and tests) can assert the service was left running.
   */
  handleWindowClose(event: CloseEvent): boolean;
  /**
   * The app's `window-all-closed` handler. Returns true when it started a quit.
   * With a live tray the app stays resident, which is what makes hide-to-tray
   * different from closing every window.
   */
  handleWindowAllClosed(): boolean;
  /** The single clean-shutdown path used by the tray's `退出`. */
  shutdown(): Promise<void>;
}

export function createLifecycle(options: LifecycleOptions): Lifecycle {
  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    // Both `window-all-closed` and the tray item can race here; the service must
    // be stopped once, and the tray destroyed before the process goes away.
    if (shuttingDown) return;
    shuttingDown = true;
    await options.shutdown.stopService().catch(() => undefined);
    options.shutdown.destroyTray();
    options.shutdown.quit();
  };

  return {
    handleWindowClose(event: CloseEvent): boolean {
      if (shuttingDown) return false;
      // Hiding is only meaningful when there is a tray to hide into. On a
      // machine where the tray could not be installed the window closes
      // normally, so the app can never become an invisible, unreachable process.
      if (!options.closeToTray() || !options.hasTray()) return false;
      // The default close would destroy the window and fire window-all-closed,
      // which is exactly what must not happen while the service should survive.
      event.preventDefault();
      options.window()?.hide();
      return true;
    },
    handleWindowAllClosed(): boolean {
      // Two different situations reach this handler:
      //
      //  - close-to-tray is on (the default): the window should never really
      //    close, so if this fires anyway the app is still meant to be
      //    resident. A live tray must not quit and must not stop the service.
      //  - close-to-tray is off: the person asked for ordinary window
      //    behaviour, so a closed window quits through the same clean
      //    shutdown, which destroys the tray on its way out.
      //
      // The `hasTray()` half also covers a machine where the tray could not be
      // installed at all: with no tray and no window the app would be an
      // invisible zombie, so it quits instead.
      if (options.closeToTray() && options.hasTray()) return false;
      void shutdown();
      return true;
    },
    shutdown,
  };
}