import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  CATALOGS,
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  LOCALES,
  type Locale,
  type MessageKey,
} from './messages.ts';

const STORAGE_KEY = 'playagent.locale';

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function isLocale(value: string | null): value is Locale {
  return value !== null && (LOCALES as readonly string[]).includes(value);
}

/**
 * 決定初始語系:已記憶選擇 > 瀏覽器語言(可對應者)> 預設 zh-Hant。
 * 瀏覽器語言無對應翻譯時回退 en(Req 10.8)。
 */
export function detectInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // localStorage 不可用時忽略
  }

  const nav = typeof navigator !== 'undefined' ? navigator.languages ?? [] : [];
  for (const lang of nav) {
    if (isLocale(lang)) return lang;
    // 語言主標籤對應(如 "zh-TW" → zh-Hant,"zh-CN" → zh-Hans)
    const lower = lang.toLowerCase();
    if (lower.startsWith('zh')) {
      if (lower.includes('tw') || lower.includes('hant') || lower.includes('hk')) {
        return 'zh-Hant';
      }
      if (lower.includes('cn') || lower.includes('hans')) return 'zh-Hans';
    }
    const base = lower.split('-')[0];
    if (base === 'en') return 'en';
    if (base === 'ja') return 'ja';
    if (base === 'ko') return 'ko';
  }
  return DEFAULT_LOCALE;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 忽略持久化失敗
    }
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('lang', next);
    }
  }, []);

  const t = useCallback(
    (key: MessageKey): string => {
      const primary = CATALOGS[locale][key];
      if (primary !== undefined && primary !== '') return primary;
      // 缺該 key → 回退語系(Req 10.8)
      return CATALOGS[FALLBACK_LOCALE][key] ?? key;
    },
    [locale],
  );

  const value = useMemo(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n 必須在 <I18nProvider> 內使用');
  return ctx;
}
