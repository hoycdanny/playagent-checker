/**
 * 執行期設定。Cognito 的 pool/client/region 為「公開設計」的 OAuth 客戶端設定
 * (SPA 無法安全存放機密),於建置期經 Vite `VITE_*` 環境變數注入,不硬編碼、不進碼庫。
 */
export interface AppRuntimeConfig {
  cognitoRegion: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  apiUrl: string;
  wsUrl: string;
}

export function getConfig(): AppRuntimeConfig {
  return {
    cognitoRegion: import.meta.env.VITE_COGNITO_REGION ?? '',
    cognitoUserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? '',
    cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? '',
    apiUrl: import.meta.env.VITE_API_URL ?? '',
    wsUrl: import.meta.env.VITE_WS_URL ?? '',
  };
}

/** 是否已配置 Cognito(未配置時登入頁顯示提示,而非拋錯)。 */
export function isAuthConfigured(cfg: AppRuntimeConfig = getConfig()): boolean {
  return Boolean(cfg.cognitoRegion && cfg.cognitoUserPoolId && cfg.cognitoClientId);
}
