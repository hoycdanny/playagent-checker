import { useI18n } from '../i18n/I18nProvider.tsx';
import { LOCALE_LABELS, LOCALES, type Locale } from '../i18n/messages.ts';

/** 可重用語系切換器(頂欄與登入頁共用)。 */
export function LanguageSelect({ className }: { className?: string }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <label className={className}>
      <span className="visually-hidden">{t('language.label')}</span>
      <select
        aria-label={t('language.label')}
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
