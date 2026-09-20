/**
 * Capturing a preview of the window a watched session runs in.
 *
 * Two facts about the OS capture layer drove this design, and both were established by
 * measurement on this machine rather than assumed:
 *
 *  1. **A minimized window is not enumerated at all.** It is not an empty thumbnail — the
 *     window is absent from `desktopCapturer.getSources` entirely, and reappears when restored.
 *     So "the session is minimized" is a distinct outcome the UI must name, not a blank frame.
 *  2. **An occluded window captures perfectly.** A window fully covered by another still comes
 *     back with its own content intact, which is what makes a preview worth having: it shows a
 *     session the user cannot currently see. (A window the user *is* looking at needs no preview.)
 *
 * A pass over `getSources` costs roughly 300ms and holds flat as windows are added, because it
 * enumerates and captures every window and we keep one. That is why the preview is fetched on
 * demand and cached by the caller rather than refreshed on a timer.
 *
 * The window is looked up by *session id* through the service's own session list. The renderer
 * never names a window handle, so this capability cannot be pointed at an arbitrary window.
 */

/** The subset of a captured source this module needs, so tests can supply plain objects. */
export interface PreviewSource {
  readonly id: string;
  readonly name: string;
  readonly thumbnail: {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
    toDataURL(): string;
  };
}

export interface PreviewSessionHost {
  readonly label: string;
  readonly windowHandle: number | null;
  readonly windowTitle: string | null;
}

export interface PreviewSession {
  readonly id: string;
  readonly host: PreviewSessionHost | null;
}

export type PreviewOutcome =
  | {
    readonly state: 'captured';
    readonly dataUrl: string;
    readonly width: number;
    readonly height: number;
    readonly sharedBy: number;
  }
  | { readonly state: 'no-window' }
  | { readonly state: 'minimized' }
  | { readonly state: 'unsupported'; readonly reason: string };

/** The `window:<handle>:<n>` id shape Electron uses for a window source. */
export function handleOfSourceId(id: string): number | null {
  const parts = id.split(':');
  if (parts[0] !== 'window') return null;
  const handle = Number.parseInt(parts[1] ?? '', 10);
  return Number.isFinite(handle) ? handle : null;
}

/**
 * How wide a capture to request.
 *
 * A terminal needs enough resolution to be read; 960 wide was chosen because it keeps text
 * legible in the detail column while holding the payload near the frame the pane displays.
 */
export const PREVIEW_THUMBNAIL_SIZE = Object.freeze({ width: 960, height: 600 });

export interface CaptureDependencies {
  /** The capturer, injected so the lookup logic is testable without Electron. */
  readonly getSources: (options: {
    types: readonly string[];
    thumbnailSize: { width: number; height: number };
    fetchWindowIcons?: boolean;
  }) => Promise<readonly PreviewSource[]>;
  /** The watched sessions, as the service reports them. */
  readonly sessions: () => Promise<readonly PreviewSession[]>;
}

/**
 * Produce a preview for one watched session.
 *
 * Returns a discriminated outcome rather than throwing, because every failure here is an
 * ordinary state of a healthy system that the UI should describe in words.
 */
export async function captureSessionWindow(
  dependencies: CaptureDependencies,
  sessionId: string,
  thumbnailSize: { width: number; height: number } = PREVIEW_THUMBNAIL_SIZE,
): Promise<PreviewOutcome> {
  let sessions: readonly PreviewSession[];
  try {
    sessions = await dependencies.sessions();
  } catch (error) {
    return { state: 'unsupported', reason: `could not list sessions: ${error instanceof Error ? error.message : String(error)}` };
  }

  const session = sessions.find((entry) => entry.id === sessionId);
  if (session === undefined) return { state: 'unsupported', reason: 'that session is no longer running' };

  const handle = session.host?.windowHandle ?? null;
  // DeepSeek Harness is a web UI with no window of its own, which is a real and expected state.
  if (handle === null) return { state: 'no-window' };

  const sharedBy = sessions.filter((entry) => (entry.host?.windowHandle ?? null) === handle).length;

  let sources: readonly PreviewSource[];
  try {
    sources = await dependencies.getSources({ types: ['window'], thumbnailSize, fetchWindowIcons: false });
  } catch (error) {
    return { state: 'unsupported', reason: `capture failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const source = sources.find((entry) => handleOfSourceId(entry.id) === handle);
  // The window exists (the service reports a handle for it) but the capture layer does not offer
  // it. Measured behaviour: that is what a minimized window looks like. A window that has closed
  // would instead have had its handle dropped from the session by the service.
  if (source === undefined) return { state: 'minimized' };

  const image = source.thumbnail;
  if (image.isEmpty()) return { state: 'minimized' };
  const size = image.getSize();
  return {
    state: 'captured',
    dataUrl: image.toDataURL(),
    width: size.width,
    height: size.height,
    sharedBy,
  };
}