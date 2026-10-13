import { describe, expect, it, vi } from 'vitest';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { completeNewPassword, login, NewPasswordRequiredError } from './cognitoClient.ts';
import { meetsPasswordPolicy } from '../pages/LoginPage.tsx';

function fakeClient(responses: unknown[]) {
  const sent: { input: Record<string, unknown> }[] = [];
  const send = vi.fn(async (cmd: { input: Record<string, unknown> }) => {
    sent.push(cmd);
    return responses.shift();
  });
  return { client: { send } as unknown as CognitoIdentityProviderClient, sent };
}

const auth = { IdToken: 'id', AccessToken: 'acc', RefreshToken: 'ref', ExpiresIn: 3600 };

describe('邀請信臨時密碼第一次登入', () => {
  it('Cognito 要求換密碼時丟 NewPasswordRequiredError,帶 session 與內部帳號', async () => {
    const { client } = fakeClient([
      { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'sess-1', ChallengeParameters: { USER_ID_FOR_SRP: 'uuid-123' } },
    ]);
    const err = await login(client, 'cid', 'a@example.com', 'Temp#1234').catch((e) => e);
    expect(err).toBeInstanceOf(NewPasswordRequiredError);
    expect(err.name).toBe('NewPasswordRequiredError');
    expect(err.session).toBe('sess-1');
    expect(err.username).toBe('uuid-123');
  });

  it('沒有 USER_ID_FOR_SRP 時沿用輸入的帳號', async () => {
    const { client } = fakeClient([{ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's' }]);
    const err = await login(client, 'cid', 'a@example.com', 'x').catch((e) => e);
    expect(err.username).toBe('a@example.com');
  });

  it('completeNewPassword 回應挑戰並回傳 token', async () => {
    const { client, sent } = fakeClient([{ AuthenticationResult: auth }]);
    const t = await completeNewPassword(client, 'cid', 'uuid-123', 'NewPass123', 'sess-1');
    expect(t.idToken).toBe('id');
    expect(t.refreshToken).toBe('ref');
    expect(sent[0]!.input).toMatchObject({
      ClientId: 'cid',
      ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: 'sess-1',
      ChallengeResponses: { USERNAME: 'uuid-123', NEW_PASSWORD: 'NewPass123' },
    });
  });

  it('一般登入仍直接回 token', async () => {
    const { client } = fakeClient([{ AuthenticationResult: auth }]);
    const t = await login(client, 'cid', 'a@example.com', 'pw');
    expect(t.accessToken).toBe('acc');
  });

  it('密碼規則:8 碼以上,含大寫、小寫與數字', () => {
    expect(meetsPasswordPolicy('Abcdefg1')).toBe(true);
    expect(meetsPasswordPolicy('abcdefg1')).toBe(false);
    expect(meetsPasswordPolicy('ABCDEFG1')).toBe(false);
    expect(meetsPasswordPolicy('Abcdefgh')).toBe(false);
    expect(meetsPasswordPolicy('Abc1')).toBe(false);
  });
});
