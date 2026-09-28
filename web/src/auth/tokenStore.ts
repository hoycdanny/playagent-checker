/**
 * token 存於 sessionStorage(非 localStorage):把泄露窗口限制在分頁生命週期內
 * (關閉分頁即失效),降低多租戶場景下 token 外洩的影響面。
 */
export interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const STORAGE_KEY = 'playagent.auth';

export function saveTokens(tokens: AuthTokens): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  } catch {
    // 忽略持久化失敗
  }
}

export function loadTokens(): AuthTokens | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthTokens;
  } catch {
    return null;
  }
}

export function clearTokens(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}
