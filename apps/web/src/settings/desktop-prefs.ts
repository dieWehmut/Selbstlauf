import { useCallback, useState } from 'react';

/**
 * Tiny local-preference layer for the desktop settings sections.
 *
 * Everything in this file is deliberately boring: values live in `localStorage`
 * as JSON, reads never throw, and a missing, corrupt, or malformed value always
 * falls back to a caller-supplied default. The panel owns no server state here.
 */

/** Namespaced storage keys, so no section can collide with another one. */
export const PREF_KEYS = Object.freeze({
  notifications: 'watchdog-notifications',
  profile: 'watchdog-profile',
  parental: 'watchdog-parental',
  voice: 'watchdog-voice',
  trustedContact: 'watchdog-trusted-contact',
  personalization: 'watchdog-personalization',
  pet: 'watchdog-pet',
  computerControl: 'watchdog-computer-control',
  plugins: 'watchdog-plugins',
  codexHistory: 'watchdog-codex-history',
} as const);

/** Returns the storage object, or null when the environment does not expose one. */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Accessing `localStorage` can itself throw in hardened browser contexts.
    return null;
  }
}

/**
 * Reads a JSON-encoded preference. Never throws: a missing key, unparseable
 * text, or a value rejected by `validate` all yield `fallback`.
 */
export function readPref<T>(key: string, fallback: T, validate: (value: unknown) => value is T): T {
  const store = storage();
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Writes a JSON-encoded preference. Silent when storage is unavailable or full. */
export function writePref(key: string, value: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled: preferences are best-effort.
  }
}

/** React state bound to one preference key, written through on every change. */
export function usePref<T>(
  key: string,
  fallback: T,
  validate: (value: unknown) => value is T,
): readonly [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback, validate));
  const update = useCallback(
    (next: T) => {
      setValue(next);
      writePref(key, next);
    },
    [key],
  );
  return [value, update] as const;
}

/* ------------------------------------------------------------------ */
/* Preference shapes and their validators                              */
/* ------------------------------------------------------------------ */

export interface NotificationsPref {
  readonly inPanel: boolean;
  readonly onSuccess: boolean;
  readonly onError: boolean;
  readonly timelineLimit: number;
}

export interface ProfilePref {
  readonly displayName: string;
  readonly note: string;
  readonly avatar: 'default' | 'light' | 'dark';
}

export interface ParentalPref {
  readonly enabled: boolean;
  /** The obfuscated PIN (see `hashPin`); never the plaintext PIN. */
  readonly pinHash: string | null;
  readonly allowlist: readonly string[];
}

export type TrustedContactCondition = 'severe' | 'any' | 'always';

export interface TrustedContactPref {
  readonly name: string;
  readonly email: string;
  readonly condition: TrustedContactCondition;
}

export interface VoicePref {
  readonly enabled: boolean;
  readonly rate: number;
  readonly voice: string | null;
}

export type Density = 'comfortable' | 'compact';

export interface PersonalizationPref {
  readonly density: Density;
}

export type PetForm = 'dot' | 'square' | 'ring';

export interface PetPref {
  readonly enabled: boolean;
  readonly form: PetForm;
}

export interface PluginsPref {
  readonly prompts: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNotificationsPref(value: unknown): value is NotificationsPref {
  if (!isRecord(value)) return false;
  return typeof value.inPanel === 'boolean'
    && typeof value.onSuccess === 'boolean'
    && typeof value.onError === 'boolean'
    && typeof value.timelineLimit === 'number'
    && Number.isFinite(value.timelineLimit);
}

export function isProfilePref(value: unknown): value is ProfilePref {
  if (!isRecord(value)) return false;
  return typeof value.displayName === 'string'
    && typeof value.note === 'string'
    && (value.avatar === 'default' || value.avatar === 'light' || value.avatar === 'dark');
}

export function isParentalPref(value: unknown): value is ParentalPref {
  if (!isRecord(value)) return false;
  return typeof value.enabled === 'boolean'
    && (value.pinHash === null || typeof value.pinHash === 'string')
    && Array.isArray(value.allowlist)
    && value.allowlist.every((entry) => typeof entry === 'string');
}

export function isTrustedContactPref(value: unknown): value is TrustedContactPref {
  if (!isRecord(value)) return false;
  return typeof value.name === 'string'
    && typeof value.email === 'string'
    && (value.condition === 'severe' || value.condition === 'any' || value.condition === 'always');
}

export function isVoicePref(value: unknown): value is VoicePref {
  if (!isRecord(value)) return false;
  return typeof value.enabled === 'boolean'
    && typeof value.rate === 'number'
    && Number.isFinite(value.rate)
    && (value.voice === null || typeof value.voice === 'string');
}

export function isPersonalizationPref(value: unknown): value is PersonalizationPref {
  if (!isRecord(value)) return false;
  return value.density === 'comfortable' || value.density === 'compact';
}

export function isPetPref(value: unknown): value is PetPref {
  if (!isRecord(value)) return false;
  return typeof value.enabled === 'boolean'
    && (value.form === 'dot' || value.form === 'square' || value.form === 'ring');
}

export function isPluginsPref(value: unknown): value is PluginsPref {
  if (!isRecord(value)) return false;
  return Array.isArray(value.prompts) && value.prompts.every((entry) => typeof entry === 'string');
}

export const NOTIFICATIONS_DEFAULTS: NotificationsPref = Object.freeze({
  inPanel: true,
  onSuccess: true,
  onError: true,
  timelineLimit: 100,
});

export const PROFILE_DEFAULTS: ProfilePref = Object.freeze({
  displayName: '',
  note: '',
  avatar: 'default',
});

export const PARENTAL_DEFAULTS: ParentalPref = Object.freeze({
  enabled: false,
  pinHash: null,
  allowlist: [],
});

export const TRUSTED_CONTACT_DEFAULTS: TrustedContactPref = Object.freeze({
  name: '',
  email: '',
  condition: 'severe',
});

export const VOICE_DEFAULTS: VoicePref = Object.freeze({
  enabled: false,
  rate: 1,
  voice: null,
});

export const PERSONALIZATION_DEFAULTS: PersonalizationPref = Object.freeze({
  density: 'comfortable',
});

export const PET_DEFAULTS: PetPref = Object.freeze({
  enabled: false,
  form: 'dot',
});

export const PLUGINS_DEFAULTS: PluginsPref = Object.freeze({
  prompts: [],
});

/**
 * Local, NON-CRYPTOGRAPHIC obfuscation of a PIN (FNV-1a, 32-bit, hex).
 *
 * This is a UI convenience lock only: it exists so a casual click cannot flip
 * the parental switch back off, and so the plaintext PIN is never written to
 * disk. It is **not** a security boundary — the value is trivially reversible
 * by brute force over a 4-8 digit space, and anyone with access to this
 * browser profile can edit `localStorage` directly. Do not reuse it to protect
 * anything that matters.
 */
export function hashPin(pin: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < pin.length; index += 1) {
    hash ^= pin.charCodeAt(index);
    // 32-bit FNV prime multiplication without overflowing the double mantissa.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}