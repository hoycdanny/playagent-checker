/**
 * token 存於 localStorage:關掉分頁或重開瀏覽器仍維持登入,直到登入滿 48 小時(SESSION_MAX_MS)。
 * id/access token 本身 1 小時到期,由 AuthProvider 用 refresh token 自動換新;
 * Cognito 端的 refresh token 也設成 48 小時,所以伺服器端同樣會在 48 小時後失效(不只靠前端計時)。
 */
export interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** 這次登入的時間(換新 token 時保留),用來算 48 小時上限。 */
  signedInAt?: number;
}

/** 登入後最長維持時間:48 小時。 */
export const SESSION_MAX_MS = 48 * 60 * 60 * 1000;

const STORAGE_KEY = 'playagent.auth';

function store(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: AuthTokens): void {
  try {
    store()?.setItem(STORAGE_KEY, JSON.stringify(tokens));
    // 舊版存在 sessionStorage,一併清掉避免殘留。
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略持久化失敗
  }
}

export function loadTokens(): AuthTokens | null {
  try {
    const raw = store()?.getItem(STORAGE_KEY) ?? sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthTokens;
  } catch {
    return null;
  }
}

export function clearTokens(): void {
  try {
    store()?.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}

/** 是否已超過 48 小時登入上限(沒有 signedInAt 的舊 token 視為未超過,換新時補上)。 */
export function sessionExpired(t: AuthTokens, now: number = Date.now()): boolean {
  return typeof t.signedInAt === 'number' && now - t.signedInAt >= SESSION_MAX_MS;
}

/** id token 是否快到期(預設 5 分鐘內),需要先換新再呼叫 API。 */
export function needsRefresh(t: AuthTokens, now: number = Date.now(), marginMs = 5 * 60_000): boolean {
  return typeof t.expiresAt === 'number' && t.expiresAt - now < marginMs;
}
