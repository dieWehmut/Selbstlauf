import { useState } from 'react';
import { Languages } from 'lucide-react';
import { LOCALES, LOCALE_NAMES, useI18n, type Locale } from './index';

export function LanguageSection() {
  const { locale, setLocale, t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (next: Locale) => {
    setPending(true);
    setError(null);
    try { await setLocale(next); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return (
    <section className="settings-section settings-section--wide">
      <div className="section-title"><div><span className="eyebrow">{t('界面语言')}</span><h2>{t('界面语言')}</h2></div><Languages size={20} /></div>
      <p className="section-hint">{t('选择界面语言，保存后立即应用到所有窗口。')}</p>
      <div className="segmented segmented--labels" role="group" aria-label={t('界面语言')} aria-busy={pending}>
        {LOCALES.map((language) => (
          <button key={language} className={language === locale ? 'segmented__option is-active' : 'segmented__option'}
            type="button" aria-pressed={language === locale} disabled={pending}
            onClick={() => { void change(language); }}>{LOCALE_NAMES[language]}</button>
        ))}
      </div>
      {error && <p className="settings-error" role="status">{t('语言保存失败：{detail}', { detail: error })}</p>}
    </section>
  );
}

export default LanguageSection;
