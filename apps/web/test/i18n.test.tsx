import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type I18n = typeof import('../src/i18n');
let i18n: I18n;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function Probe() {
  const { locale, t } = i18n.useI18n();
  return <output data-testid="locale">{locale}|{t('界面语言')}</output>;
}
beforeEach(async () => {
  Reflect.deleteProperty(window, 'selbstlaufDesktop');
  localStorage.clear();
  document.documentElement.lang = 'zh-CN';
  vi.resetModules();
  i18n = await import('../src/i18n');
});
afterEach(() => { vi.restoreAllMocks(); Reflect.deleteProperty(window, 'selbstlaufDesktop'); });

describe('locale persistence and synchronization', () => {
  it.each(['zh-TW', 'en', 'ja'] as const)('translates and persists %s immediately', async (locale) => {
    render(<Probe />);
    await act(() => i18n.setLocale(locale));
    expect(screen.getByTestId('locale')).toHaveTextContent(`${locale}|${i18n.translate('界面语言', {}, locale)}`);
    expect(document.documentElement.lang).toBe(locale);
    expect(JSON.parse(localStorage.getItem(i18n.LOCALE_KEY)!)).toBe(locale);
    expect(i18n.getLocale()).toBe(locale);
  });
  it('rejects unavailable browser storage without changing the saved language', async () => {
    await i18n.setLocale('en');
    render(<Probe />);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    await expect(i18n.setLocale('ja')).rejects.toThrow('This browser cannot save the language setting.');
    expect(i18n.getLocale()).toBe('en');
    expect(screen.getByTestId('locale')).toHaveTextContent('en|Interface language');
    expect(document.documentElement.lang).toBe('en');
  });
  it.each(['null', '"unsupported"', '{broken'])('falls back for invalid stored locale: %s', (saved) => {
    localStorage.setItem(i18n.LOCALE_KEY, saved);
    expect(i18n.getLocale()).toBe('zh-CN');
  });
  it('updates mounted messages and html language after another window changes or clears storage', () => {
    render(<Probe />);
    localStorage.setItem(i18n.LOCALE_KEY, JSON.stringify('ja'));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: i18n.LOCALE_KEY })));
    expect(screen.getByTestId('locale')).toHaveTextContent('ja|表示言語');
    expect(document.documentElement.lang).toBe('ja');
    localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
    expect(screen.getByTestId('locale')).toHaveTextContent('zh-CN|界面语言');
  });
  it('interpolates parameters as text while preserving user data', () => {
    const detail = '用户\'s /路径/<script>$&{other}';
    expect(i18n.translate('语言保存失败：{detail}', { detail }, 'en')).toBe(`Could not save language: ${detail}`);
    expect(i18n.translate(detail, {}, 'en')).toBe(detail);
    expect(i18n.translate('语言保存失败：{detail}', {}, 'ja')).toBe('言語を保存できませんでした：{detail}');
  });
  it('waits for a native confirmed write and preserves locale when it fails', async () => {
    const write = deferred<{ locale: 'en' }>();
    Object.assign(window, { selbstlaufDesktop: { settings: { set: vi.fn(() => write.promise) } } });
    render(<Probe />);
    const save = i18n.setLocale('en');
    expect(i18n.getLocale()).toBe('zh-CN');
    write.reject(new Error('permission denied'));
    await expect(save).rejects.toThrow('permission denied');
    expect(i18n.getLocale()).toBe('zh-CN');
    expect(localStorage.getItem(i18n.LOCALE_KEY)).toBeNull();
  });
  it('uses confirmed native persistence even if the browser cache cannot be written', async () => {
    Object.assign(window, { selbstlaufDesktop: { settings: { set: vi.fn(async () => ({ locale: 'en' })) } } });
    render(<Probe />);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    await act(() => i18n.setLocale('en'));
    expect(screen.getByTestId('locale')).toHaveTextContent('en|Interface language');
    expect(document.documentElement.lang).toBe('en');
  });
  it('loads native locale and accepts native changes without depending on browser storage', async () => {
    let onChange!: (saved: { locale: string }) => void;
    const unsubscribe = vi.fn();
    Object.assign(window, { selbstlaufDesktop: { settings: {
      get: async () => ({ locale: 'ja' }),
      onChange: (listener: typeof onChange) => { onChange = listener; return unsubscribe; },
    } } });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const view = render(<><i18n.LocaleBridge /><Probe /></>);
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('ja|表示言語'));
    act(() => onChange({ locale: 'zh-TW' }));
    expect(screen.getByTestId('locale')).toHaveTextContent('zh-TW|介面語言');
    localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
    expect(i18n.getLocale()).toBe('zh-TW');
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('does not let an old initial native read overwrite a new write or native change', async () => {
    const read = deferred<{ locale: string }>();
    const write = deferred<{ locale: string }>();
    let onChange!: (saved: { locale: string }) => void;
    Object.assign(window, { selbstlaufDesktop: { settings: {
      get: () => read.promise, set: () => write.promise,
      onChange: (listener: typeof onChange) => { onChange = listener; return () => undefined; },
    } } });
    render(<><i18n.LocaleBridge /><Probe /></>);
    const save = i18n.setLocale('en');
    await act(async () => { read.resolve({ locale: 'zh-CN' }); await read.promise; });
    await act(async () => { write.resolve({ locale: 'en' }); await save; });
    expect(i18n.getLocale()).toBe('en');
    act(() => onChange({ locale: 'ja' }));
    expect(i18n.getLocale()).toBe('ja');
  });
  it('ignores a late save response after a newer native broadcast', async () => {
    const write = deferred<{ locale: string }>();
    let onChange!: (saved: { locale: string }) => void;
    Object.assign(window, { selbstlaufDesktop: { settings: {
      get: async () => ({ locale: 'zh-CN' }), set: () => write.promise,
      onChange: (listener: typeof onChange) => { onChange = listener; return () => undefined; },
    } } });
    render(<><i18n.LocaleBridge /><Probe /></>);
    await act(async () => {});
    const save = i18n.setLocale('en');
    act(() => onChange({ locale: 'ja' }));
    await act(async () => { write.resolve({ locale: 'en' }); await save; });
    expect(i18n.getLocale()).toBe('ja');
  });
  it('keeps only the newest of concurrent native save responses', async () => {
    const older = deferred<{ locale: string }>();
    const newer = deferred<{ locale: string }>();
    const set = vi.fn().mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    Object.assign(window, { selbstlaufDesktop: { settings: { set } } });
    const first = i18n.setLocale('en');
    const second = i18n.setLocale('ja');
    newer.resolve({ locale: 'ja' }); await second;
    older.resolve({ locale: 'en' }); await first;
    expect(i18n.getLocale()).toBe('ja');
  });
  it('keeps all four language choices enabled and reports a failed save with a retry', async () => {
    const { LanguageSection } = await import('../src/i18n/LanguageSection');
    render(<LanguageSection />);
    for (const name of Object.values(i18n.LOCALE_NAMES)) expect(screen.getByRole('button', { name })).toBeEnabled();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    await screen.findByRole('status');
    expect(screen.getByRole('button', { name: '简体中文' })).toHaveAttribute('aria-pressed', 'true');
    write.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Interface language' })).toBeVisible());
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('language before the application bundle loads', () => {
  const boot = readFileSync(resolve('public/theme-boot.js'), 'utf8');
  it.each(['zh-CN', 'zh-TW', 'en', 'ja'] as const)('applies saved %s to the first paint', (locale) => {
    localStorage.setItem(i18n.LOCALE_KEY, JSON.stringify(locale));
    Function(boot)();
    expect(document.documentElement.lang).toBe(locale);
  });
  it('sets the default language even if browser storage access fails', () => {
    document.documentElement.lang = 'en';
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    Function(boot)();
    expect(document.documentElement.lang).toBe('zh-CN');
  });
});
