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
import { setUnauthorizedHandler } from '../api/client.ts';
import {
  decodeIdToken,
  login as cognitoLogin,
  makeCognitoClient,
} from './cognitoClient.ts';
import {
  clearTokens,
  loadTokens,
  saveTokens,
  type AuthTokens,
} from './tokenStore.ts';

/** 載入已存 token,但若已過期(或即將於 30 秒內過期)則視為無效,回 null。 */
function loadValidTokens(): AuthTokens | null {
  const t = loadTokens();
  if (!t) return null;
  if (typeof t.expiresAt === 'number' && t.expiresAt - Date.now() < 30_000) {
    clearTokens();
    return null;
  }
  return t;
}

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
