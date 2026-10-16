import { getConfig } from '../config.ts';
import { loadTokens, type AuthTokens } from '../auth/tokenStore.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 全域未授權(401)處理器。token 失效時由 API 層統一觸發,
 * 讓 auth 層清除 token 並導回登入頁——避免使用者卡在「載入失敗」而無法重新登入。
 * 由 AuthProvider 於掛載時註冊,保持 client 不直接依賴 auth 模組(維持分層)。
 */
let onUnauthorized: (() => void) | null = null;

/**
 * 取得「可用的」token(快到期時先換新)。由 AuthProvider 註冊;未註冊時直接讀儲存的 token。
 * 讓所有 API 呼叫在 id token 1 小時到期前自動換新,使用者可以維持登入到 48 小時上限。
 */
let tokenProvider: (() => Promise<AuthTokens | null>) | null = null;
export function setTokenProvider(fn: (() => Promise<AuthTokens | null>) | null): void {
  tokenProvider = fn;
}
async function currentTokens(): Promise<AuthTokens | null> {
  if (tokenProvider) {
    try { return await tokenProvider(); } catch { return loadTokens(); }
  }
  return loadTokens();
}
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/** 統一處理非 2xx 回應:401 觸發全域登出;其餘拋 ApiError。 */
async function handleErrorResponse(res: Response): Promise<never> {
  let msg = `HTTP ${res.status}`;
  try {
    const b = (await res.json()) as { error?: string };
    if (b.error) msg = b.error;
  } catch {
    /* 忽略解析失敗 */
  }
  if (res.status === 401) {
    // token 失效:清除並回登入頁。
    onUnauthorized?.();
  }
  throw new ApiError(res.status, msg);
}

/**
 * 呼叫控制面 API,自動附上 Bearer idToken。
 * 401(token 失效)會觸發全域未授權處理器(清 token + 回登入頁)後再拋 ApiError(401)。
 */
export async function apiGet<T>(path: string): Promise<T> {
  const { apiUrl } = getConfig();
  if (!apiUrl) throw new ApiError(0, 'API 未配置');
  const tokens = await currentTokens();
  const res = await fetch(`${apiUrl}${path}`, {
    headers: tokens ? { authorization: `Bearer ${tokens.idToken}` } : {},
  });
  if (!res.ok) return handleErrorResponse(res);
  return (await res.json()) as T;
}

/** Device Farm 真機池的一台裝置(對齊後端 CloudDevice)。 */
export interface CloudDevice {
  /** 裝置 ARN(提交任務時明確指定要跑哪台真機)。 */
  arn?: string;
  name: string;
  /** 裝置平台(舊後端沒帶時視為 android)。 */
  platform?: 'android' | 'ios';
  os: string;
  arch: string;
  manufacturer: string;
  formFactor: string;
  availability?: string;
  /** 螢幕解析度(如 "1080x2340")。 */
  resolution?: string;
  /** 記憶體(位元組)。 */
  memoryBytes?: number;
  /** CPU 描述(架構 + 時脈)。 */
  cpu?: string;
}

export interface ListResponse<T = { key: string }> {
  items: T[];
}

/** 帶 Bearer token 的 POST(JSON)。 */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const { apiUrl } = getConfig();
  if (!apiUrl) throw new ApiError(0, 'API 未配置');
  const tokens = await currentTokens();
  const res = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(tokens ? { authorization: `Bearer ${tokens.idToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return handleErrorResponse(res);
  return (await res.json()) as T;
}

/** 帶 Bearer token 的 PUT(JSON)。 */
export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiSend<T>('PUT', path, body);
}

/** 帶 Bearer token 的 DELETE。 */
export async function apiDelete<T>(path: string): Promise<T> {
  return apiSend<T>('DELETE', path);
}

async function apiSend<T>(
  method: 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const { apiUrl } = getConfig();
  if (!apiUrl) throw new ApiError(0, 'API 未配置');
  const tokens = await currentTokens();
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(tokens ? { authorization: `Bearer ${tokens.idToken}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) return handleErrorResponse(res);
  return (await res.json()) as T;
}

export interface UploadTarget {
  url: string;
  key: string;
  artifactId: string;
}

/**
 * 直傳檔案到 S3(presigned PUT)—— 位元組不經過 API,直達 S3(Req 2.1/2.4)。
 * 以 XMLHttpRequest 取得上傳進度。
 */
export function uploadToS3(
  url: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // 不設 content-type:presigned URL 未綁 ContentType,設了反而可能與簽章不符導致 403。
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new ApiError(xhr.status, `上傳失敗 HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new ApiError(0, '上傳網路錯誤'));
    xhr.send(file);
  });
}
