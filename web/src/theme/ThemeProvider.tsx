import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'playagent.theme';

interface ThemeContextValue {
  theme: Theme;
  /** 使用者是否曾手動選擇(手動優先於系統偏好,Req 10.9)。 */
  isUserChoice: boolean;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): Theme {
  if (
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }
  return 'light';
}

function readStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const stored = readStoredTheme();
  const [theme, setThemeState] = useState<Theme>(stored ?? systemTheme());
  const [isUserChoice, setIsUserChoice] = useState<boolean>(stored !== null);

  // 套用到 data-theme(與 index.html 的無閃爍腳本一致)。
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // 未手動選擇時,跟隨系統偏好變化(Req 10.9)。
  useEffect(() => {
    if (isUserChoice || typeof window === 'undefined' || !window.matchMedia) {
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      setThemeState(e.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [isUserChoice]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    setIsUserChoice(true);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 忽略持久化失敗
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  const value = useMemo(
    () => ({ theme, isUserChoice, toggleTheme, setTheme }),
    [theme, isUserChoice, toggleTheme, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme 必須在 <ThemeProvider> 內使用');
  return ctx;
}
