import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AuthTokens } from './tokenStore.ts';

/**
 * Cognito 登入 —— 用 USER_PASSWORD_AUTH:SPA 以帳密直接登入,無需 client secret。
 */
export async function login(
  client: CognitoIdentityProviderClient,
  clientId: string,
  username: string,
  password: string,
): Promise<AuthTokens> {
  const res = await client.send(
    new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: clientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  const r = res.AuthenticationResult;
  if (!r?.IdToken || !r.AccessToken) {
    throw new Error('Cognito 登入成功但未回傳 token');
  }
  return {
    idToken: r.IdToken,
    accessToken: r.AccessToken,
    refreshToken: r.RefreshToken ?? '',
    expiresAt: Date.now() + (r.ExpiresIn ?? 3600) * 1000,
  };
}

export function makeCognitoClient(region: string): CognitoIdentityProviderClient {
  return new CognitoIdentityProviderClient({ region });
}

interface IdTokenClaims {
  email?: string;
  'custom:tenantId'?: string;
  [k: string]: unknown;
}

/**
 * 僅供顯示地解碼 idToken(不做簽名驗證):讓頂欄能顯示 email 與租戶,不需 round-trip。
 * 真正的授權在控制面由 API Gateway JWT authorizer 完成,前端從不信任此本地解碼值。
 */
export function decodeIdToken(idToken: string): {
  email: string | null;
  tenantId: string | null;
  isAdmin: boolean;
} {
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return { email: null, tenantId: null, isAdmin: false };
    const json = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    ) as IdTokenClaims;
    // cognito:groups 可能是陣列;含 "admins" 即為管理員(僅供 UI 顯示,真正授權在後端)。
    const groups = json['cognito:groups'];
    const isAdmin = Array.isArray(groups) && groups.includes('admins');
    return {
      email: typeof json.email === 'string' ? json.email : null,
      tenantId:
        typeof json['custom:tenantId'] === 'string'
          ? json['custom:tenantId']
          : null,
      isAdmin,
    };
  } catch {
    return { email: null, tenantId: null, isAdmin: false };
  }
}
