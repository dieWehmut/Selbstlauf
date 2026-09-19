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

export interface DesktopSettings {
  /** Hide to the tray instead of quitting when the window is closed. */
  readonly closeToTray: boolean;
  /** Preferred terminal for "open in terminal"; null means "not chosen yet". */
  readonly preferredTerminal: string | null;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = Object.freeze({
  closeToTray: true,
  preferredTerminal: null,
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
  const entry = value as { closeToTray?: unknown; preferredTerminal?: unknown };
  return {
    closeToTray: typeof entry.closeToTray === 'boolean' ? entry.closeToTray : fallback.closeToTray,
    preferredTerminal:
      typeof entry.preferredTerminal === 'string' && entry.preferredTerminal.trim().length > 0
        ? entry.preferredTerminal
        : entry.preferredTerminal === null
          ? null
          : fallback.preferredTerminal,
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
  const temporary = `${destination}.${process.pid}.tmp`;
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
export async function updateDesktopSettings(
  stateDirectory: string,
  patch: unknown,
): Promise<DesktopSettings> {
  const current = await readDesktopSettings(stateDirectory);
  // Unknown keys and wrong types are dropped rather than written through.
  const safePatch = normalizeDesktopSettings(
    { ...current, ...(patch !== null && typeof patch === 'object' ? (patch as object) : {}) },
    current,
  );
  return writeDesktopSettings(stateDirectory, safePatch);
}