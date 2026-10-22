/** The sandboxed desktop bridge; plain browsers have no bridge. */
type DesktopLocale = 'zh-CN' | 'zh-TW' | 'en' | 'ja';
interface DesktopPreferences {
  readonly closeToTray: boolean;
  readonly preferredTerminal: string | null;
  readonly locale: DesktopLocale;
}
interface Window {
  readonly selbstlaufDesktop?: {
    readonly platform: string;
    readonly versions: { readonly chrome: string; readonly electron: string };
    readonly settings: {
      get(): Promise<DesktopPreferences>;
      set(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
      onChange(listener: (preferences: DesktopPreferences) => void): () => void;
    };
    readonly shell: {
      reload(): void;
      toggleFullScreen(): void;
      zoom(delta: number): void;
      quit(): void;
      undo(): void;
      redo(): void;
      cut(): void;
      copy(): void;
      paste(): void;
      selectAll(): void;
      openExternal(url: string): Promise<void>;
      setTitleBarOverlay(colors: { color: string; symbolColor?: string }): void;
      windowPreview(sessionId: string): Promise<import('./App').WindowPreviewResult>;
      windowType(sessionId: string, text: string, submit: boolean): Promise<import('./App').WindowTypeResult>;
      openAgentWindow(sessionId: string): Promise<void>;
      openTerminal(sessionId: string): Promise<{ ok: boolean; reason?: string; terminal?: string }>;
    };
    onCommand(listener: (payload: { command?: string; section?: string }) => void): () => void;
  };
}
