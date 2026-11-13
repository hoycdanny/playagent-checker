import { detectInitialLocale } from './I18nProvider.tsx';
import { CATALOGS, FALLBACK_LOCALE, type MessageKey } from './messages.ts';
/**
 * Translation for non-React modules (API clients, class components): reads the
 * stored locale on every call and falls back like I18nProvider's `t`.
 */
export function tStatic(key: MessageKey): string {
  const primary = CATALOGS[detectInitialLocale()][key];
  if (primary !== undefined && primary !== '') return primary;
  return CATALOGS[FALLBACK_LOCALE][key] ?? key;
}
