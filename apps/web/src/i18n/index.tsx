import { useEffect, useSyncExternalStore } from 'react';
import { appMessages } from './app-messages';
import { componentMessages } from './component-messages';

export const LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja'] as const;
export type Locale = typeof LOCALES[number];
export type MessageParams = Readonly<Record<string, string | number>>;
export type Translations = Readonly<Record<string, { readonly zhTW: string; readonly en: string; readonly ja: string }>>;
export const LOCALE_KEY = 'watchdog-locale';
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語',
};
const CHANGED = 'selbstlauf-locale-changed';
const centralMessages: Translations = {
  '界面语言': { zhTW: '介面語言', en: 'Interface language', ja: '表示言語' },
  '选择界面语言，保存后立即应用到所有窗口。': { zhTW: '選擇介面語言，儲存後立即套用至所有視窗。', en: 'Choose the interface language. Saved changes apply to all windows immediately.', ja: '表示言語を選択します。保存すると、すべてのウィンドウにすぐ反映されます。' },
  '语言保存失败：{detail}': { zhTW: '語言儲存失敗：{detail}', en: 'Could not save language: {detail}', ja: '言語を保存できませんでした：{detail}' },
  '当前浏览器无法保存语言设置。': { zhTW: '目前瀏覽器無法儲存語言設定。', en: 'This browser cannot save the language setting.', ja: 'このブラウザーでは言語設定を保存できません。' },
};
export const messages: Translations = { ...centralMessages, ...appMessages, ...componentMessages };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

let nativeLocale: Locale | undefined;
let nativeGeneration = 0;
let latestSave = 0;

function storedLocale(): Locale {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(LOCALE_KEY) ?? 'null');
    return isLocale(stored) ? stored : 'zh-CN';
  } catch { return 'zh-CN'; }
}

export function getLocale(): Locale { return nativeLocale ?? storedLocale(); }

/** Translate source messages only; process output, user text and paths are data. */
export function translate(source: string, params: MessageParams = {}, locale: Locale = getLocale()): string {
  const entry = messages[source];
  const template = locale === 'zh-CN' || entry === undefined ? source : entry[locale === 'zh-TW' ? 'zhTW' : locale];
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder);
}

function notify() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED));
}
export function applyLocale(locale: Locale): void {
  localStorage.setItem(LOCALE_KEY, JSON.stringify(locale));
  document.documentElement.lang = locale;
  notify();
}

function applyNativeLocale(locale: Locale): void {
  nativeLocale = locale;
  nativeGeneration += 1;
  // Native persistence has already succeeded. Browser storage is only a cache here.
  try { localStorage.setItem(LOCALE_KEY, JSON.stringify(locale)); } catch { /* Use native state. */ }
  document.documentElement.lang = locale;
  notify();
}

/** Desktop preferences are authoritative there; browser preferences elsewhere. */
export async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) throw new Error('Invalid locale');
  const settings = window.selbstlaufDesktop?.settings;
  if (typeof settings?.set === 'function') {
    const request = ++latestSave;
    const generation = nativeGeneration;
    const saved = await settings.set({ locale });
    if (!isLocale((saved as { locale?: unknown }).locale)) throw new Error('Desktop returned an invalid locale');
    const confirmed = (saved as { locale: Locale }).locale;
    if (request === latestSave && (generation === nativeGeneration || nativeLocale === confirmed)) {
      applyNativeLocale(confirmed);
    }
  } else {
    try { applyLocale(locale); }
    catch { throw new Error(translate('当前浏览器无法保存语言设置。')); }
  }
}

function subscribe(listener: () => void): () => void {
  const storageChange = (event: StorageEvent) => {
    if (event.key === LOCALE_KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGED, listener);
  window.addEventListener('storage', storageChange);
  return () => { window.removeEventListener(CHANGED, listener); window.removeEventListener('storage', storageChange); };
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, () => 'zh-CN' as Locale);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  return { locale, setLocale, t: (source: string, params?: MessageParams) => translate(source, params, locale) };
}

/** Mount once per app: native settings remain authoritative even without browser storage. */
export function LocaleBridge() {
  useEffect(() => {
    const settings = window.selbstlaufDesktop?.settings;
    if (typeof settings?.get !== 'function') return;
    let active = true;
    const sync = (saved: { locale?: unknown }) => {
      if (active && isLocale(saved.locale)) applyNativeLocale(saved.locale);
    };
    const generation = nativeGeneration;
    const save = latestSave;
    void settings.get().then((saved) => {
      if (nativeGeneration === generation && latestSave === save) sync(saved);
    }).catch(() => undefined);
    const unsubscribe = settings.onChange?.(sync);
    return () => { active = false; unsubscribe?.(); };
  }, []);
  return null;
}
