import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AuthTokens } from './tokenStore.ts';

/**
 * 管理員用臨時密碼(邀請信)第一次登入:Cognito 要求先設定新密碼。
 * 帶著 session 交給登入頁,讓使用者輸入新密碼後呼叫 completeNewPassword。
 */
export class NewPasswordRequiredError extends Error {
  constructor(readonly session: string, readonly username: string) {
    super('需要設定新密碼');
    this.name = 'NewPasswordRequiredError';
  }
}

function toTokens(r: AuthenticationResultType | undefined): AuthTokens {
  if (!r?.IdToken || !r.AccessToken) throw new Error('Cognito 登入成功但未回傳 token');
  return {
    idToken: r.IdToken,
    accessToken: r.AccessToken,
    refreshToken: r.RefreshToken ?? '',
    expiresAt: Date.now() + (r.ExpiresIn ?? 3600) * 1000,
    signedInAt: Date.now(),
  };
}

/** 用臨時密碼登入後設定新密碼(NEW_PASSWORD_REQUIRED),成功即完成登入。 */
export async function completeNewPassword(
  client: CognitoIdentityProviderClient,
  clientId: string,
  username: string,
  newPassword: string,
  session: string,
): Promise<AuthTokens> {
  const res = await client.send(
    new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: session,
      ChallengeResponses: { USERNAME: username, NEW_PASSWORD: newPassword },
    }),
  );
  return toTokens(res.AuthenticationResult);
}

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
  if (res.ChallengeName === 'NEW_PASSWORD_REQUIRED' && res.Session) {
    // 以 email 當帳號的使用者池,回應挑戰要用 Cognito 內部帳號(USER_ID_FOR_SRP)
    throw new NewPasswordRequiredError(res.Session, res.ChallengeParameters?.USER_ID_FOR_SRP ?? username);
  }
  return toTokens(res.AuthenticationResult);
}

/**
 * 用 refresh token 換新的 id/access token(REFRESH_TOKEN_AUTH)。Cognito 不會回新的 refresh token,沿用舊的;
 * signedInAt 也沿用,48 小時上限從第一次登入起算。refresh token 過期或被撤銷會丟錯。
 */
export async function refresh(
  client: CognitoIdentityProviderClient,
  clientId: string,
  current: AuthTokens,
): Promise<AuthTokens> {
  const res = await client.send(
    new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: clientId,
      AuthParameters: { REFRESH_TOKEN: current.refreshToken },
    }),
  );
  const r = res.AuthenticationResult;
  if (!r?.IdToken || !r.AccessToken) throw new Error('Cognito 換新 token 失敗');
  return {
    idToken: r.IdToken,
    accessToken: r.AccessToken,
    refreshToken: r.RefreshToken ?? current.refreshToken,
    expiresAt: Date.now() + (r.ExpiresIn ?? 3600) * 1000,
    signedInAt: current.signedInAt ?? Date.now(),
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
