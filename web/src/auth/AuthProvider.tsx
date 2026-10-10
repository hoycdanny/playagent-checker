import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { getConfig } from '../config.ts';
import { setTokenProvider, setUnauthorizedHandler } from '../api/client.ts';
import {
  decodeIdToken,
  login as cognitoLogin,
  makeCognitoClient,
  refresh as cognitoRefresh,
} from './cognitoClient.ts';
import {
  clearTokens,
  loadTokens,
  needsRefresh,
  saveTokens,
  sessionExpired,
  type AuthTokens,
} from './tokenStore.ts';

/**
 * 載入已存 token。超過 48 小時上限就清掉;id token 過期但還有 refresh token 的,
 * 先保留(馬上會由 ensureFresh 換新),沒有 refresh token 的才當作無效。
 */
function loadValidTokens(): AuthTokens | null {
  const t = loadTokens();
  if (!t) return null;
  if (sessionExpired(t) || (!t.refreshToken && needsRefresh(t, Date.now(), 30_000))) {
    clearTokens();
    return null;
  }
  return t;
}

/** 檢查換新的間隔:分頁開著時每分鐘看一次,讓 WebSocket 等直接讀儲存 token 的地方也拿到新的。 */
const REFRESH_CHECK_MS = 60_000;

interface AuthContextValue {
  tokens: AuthTokens | null;
  email: string | null;
  tenantId: string | null;
  isAdmin: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [tokens, setTokens] = useState<AuthTokens | null>(() => loadValidTokens());
  const cfg = getConfig();

  const login = useCallback(
    async (username: string, password: string) => {
      const client = makeCognitoClient(cfg.cognitoRegion);
      const t = await cognitoLogin(client, cfg.cognitoClientId, username, password);
      saveTokens(t);
      setTokens(t);
    },
    [cfg.cognitoRegion, cfg.cognitoClientId],
  );

  const logout = useCallback(() => {
    clearTokens();
    setTokens(null);
  }, []);

  // 取得可用 token:快到期就用 refresh token 換新(同時間只換一次);超過 48 小時或換新失敗 → 登出。
  // 換新時以 storage 為準(其他分頁可能已經換過)。
  useEffect(() => {
    let inflight: Promise<AuthTokens | null> | null = null;
    const ensureFresh = async (): Promise<AuthTokens | null> => {
      const t = loadTokens();
      if (!t) return null;
      if (sessionExpired(t)) { logout(); return null; }
      if (!needsRefresh(t)) return t;
      if (!t.refreshToken) return t;
      inflight ??= (async () => {
        try {
          const next = await cognitoRefresh(makeCognitoClient(cfg.cognitoRegion), cfg.cognitoClientId, t);
          saveTokens(next);
          setTokens(next);
          return next;
        } catch {
          logout();
          return null;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    };
    setTokenProvider(ensureFresh);
    void ensureFresh();
    const id = setInterval(() => void ensureFresh(), REFRESH_CHECK_MS);
    // 其他分頁登出 / 換新時同步。
    const onStorage = (e: StorageEvent) => { if (e.key === 'playagent.auth') setTokens(loadValidTokens()); };
    window.addEventListener('storage', onStorage);
    return () => {
      setTokenProvider(null);
      clearInterval(id);
      window.removeEventListener('storage', onStorage);
    };
  }, [cfg.cognitoRegion, cfg.cognitoClientId, logout]);

  // 註冊全域 401 處理器:任何 API 因 token 失效回 401 時,自動登出回登入頁,
  // 避免使用者卡在「載入失敗」而無法重新取得 token。
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearTokens();
      setTokens(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const { email, tenantId, isAdmin } = useMemo(
    () =>
      tokens
        ? decodeIdToken(tokens.idToken)
        : { email: null, tenantId: null, isAdmin: false },
    [tokens],
  );

  const value = useMemo(
    () => ({
      tokens,
      email,
      tenantId,
      isAdmin,
      isAuthenticated: tokens !== null,
      login,
      logout,
    }),
    [tokens, email, tenantId, isAdmin, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必須在 <AuthProvider> 內使用');
  return ctx;
}
