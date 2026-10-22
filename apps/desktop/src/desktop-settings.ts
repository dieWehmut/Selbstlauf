/**
 * Desktop-only preferences.
 *
 * These belong to the window shell rather than the watchdog service, so they
 * live beside the service's state (`desktop-settings.json` in the same state
 * directory) instead of in the service's own config. Writes are atomic — a temp
 * file in the same directory followed by a rename — so a crash mid-write cannot
 * leave a half-parsed file that would reset the user's choices.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DESKTOP_LOCALE, isDesktopLocale, type DesktopLocale } from './locale.js';

export interface DesktopSettings {
  /** Hide to the tray instead of quitting when the window is closed. */
  readonly closeToTray: boolean;
  /** Preferred terminal for "open in terminal"; null means "not chosen yet". */
  readonly preferredTerminal: string | null;
  /** Also used by the native application menu and system tray. */
  readonly locale: DesktopLocale;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = Object.freeze({
  closeToTray: true,
  preferredTerminal: null,
  locale: DEFAULT_DESKTOP_LOCALE,
});

export const DESKTOP_SETTINGS_FILE = 'desktop-settings.json';

export function resolveDesktopSettingsPath(stateDirectory: string): string {
  return join(stateDirectory, DESKTOP_SETTINGS_FILE);
}

/**
 * Coerce a parsed file (or an untrusted patch) into the settings shape.
 *
 * Every field falls back on its own, so a file written by an older build — or a
 * patch naming one unknown key — keeps whatever it did understand.
 */
export function normalizeDesktopSettings(
  value: unknown,
  fallback: DesktopSettings = DEFAULT_DESKTOP_SETTINGS,
): DesktopSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const entry = value as { closeToTray?: unknown; preferredTerminal?: unknown; locale?: unknown };
  return {
    closeToTray: typeof entry.closeToTray === 'boolean' ? entry.closeToTray : fallback.closeToTray,
    preferredTerminal:
      typeof entry.preferredTerminal === 'string' && entry.preferredTerminal.trim().length > 0
        ? entry.preferredTerminal
        : entry.preferredTerminal === null
          ? null
          : fallback.preferredTerminal,
    locale: isDesktopLocale(entry.locale) ? entry.locale : fallback.locale,
  };
}

/** A missing, unreadable, or corrupt file simply means "still on defaults". */
export async function readDesktopSettings(stateDirectory: string): Promise<DesktopSettings> {
  let text: string;
  try {
    text = await readFile(resolveDesktopSettingsPath(stateDirectory), 'utf8');
  } catch {
    return DEFAULT_DESKTOP_SETTINGS;
  }
  try {
    return normalizeDesktopSettings(JSON.parse(text) as unknown);
  } catch {
    return DEFAULT_DESKTOP_SETTINGS;
  }
}

/**
 * Persist settings atomically.
 *
 * The temp file is created in the destination directory so the rename stays on
 * one volume and is therefore atomic on Windows too.
 */
export async function writeDesktopSettings(
  stateDirectory: string,
  settings: DesktopSettings,
): Promise<DesktopSettings> {
  const normalized = normalizeDesktopSettings(settings);
  await mkdir(stateDirectory, { recursive: true });
  const destination = resolveDesktopSettingsPath(stateDirectory);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return normalized;
}

/** Merge a partial patch over what is on disk and store the result. */
const pendingUpdates = new Map<string, Promise<DesktopSettings>>();

export async function updateDesktopSettings(
  stateDirectory: string,
  patch: unknown,
): Promise<DesktopSettings> {
  const destination = resolveDesktopSettingsPath(stateDirectory);
  const previous = pendingUpdates.get(destination);
  const update = (async () => {
    // Independent windows can save different fields at the same time. Read the
    // latest file only after the previous update finishes, preserving both edits.
    await previous?.catch(() => undefined);
    const current = await readDesktopSettings(stateDirectory);
    const safePatch = normalizeDesktopSettings(
      { ...current, ...(patch !== null && typeof patch === 'object' && !Array.isArray(patch) ? (patch as object) : {}) },
      current,
    );
    return writeDesktopSettings(stateDirectory, safePatch);
  })();
  pendingUpdates.set(destination, update);
  try { return await update; }
  finally { if (pendingUpdates.get(destination) === update) pendingUpdates.delete(destination); }
}
