import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';

const USER_POOL_ID = process.env.USER_POOL_ID ?? '';
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID ?? '';
const REGION = process.env.AWS_REGION ?? 'us-east-2';
const BUCKET = process.env.DATA_BUCKET ?? '';

const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: 'id',
  clientId: CLIENT_ID,
});

const s3 = new S3Client({ region: REGION });

interface WsAuthorizerEvent {
  methodArn: string;
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
}

/**
 * Attached 本地代理連線授權(Req 13.1):代理帶 tenantId + deviceId + deviceToken 撥出。
 * 讀 tenants/<tenantId>/devices/<deviceId>.json 比對 tokenHash(SHA-256)。
 * 通過即以裝置身分(帶 tenantId + deviceId + role=agent 進 context)放行。
 */
async function verifyAgent(
  tenantId: string,
  deviceId: string,
  token: string,
): Promise<boolean> {
  if (!tenantId || !deviceId || !token) return false;
  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: `tenants/${tenantId}/devices/${deviceId}.json`,
      }),
    );
    const text = (await res.Body?.transformToString()) ?? '';
    if (!text) return false;
    const record = JSON.parse(text) as { tokenHash?: string };
    const hash = createHash('sha256').update(token).digest('hex');
    return record.tokenHash === hash;
  } catch {
    return false;
  }
}

interface PolicyResponse {
  principalId: string;
  policyDocument: {
    Version: string;
    Statement: Array<{ Action: string; Effect: string; Resource: string }>;
  };
  context?: Record<string, string>;
}

function policy(effect: 'Allow' | 'Deny', arn: string, principalId: string, context?: Record<string, string>): PolicyResponse {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: arn }],
    },
    ...(context ? { context } : {}),
  };
}

/**
 * WebSocket $connect 的 Lambda authorizer(Req 5.5 前置)。
 * WebSocket authorizer 必須回傳 IAM policy(非 HTTP API 的 simple response)。
 * token 走 query string `?token=<idToken>`(瀏覽器無法對 WS 設標頭)。
 * tenantId/sub 放進 context 供後續 handler 使用。
 */
export async function handler(event: WsAuthorizerEvent): Promise<PolicyResponse> {
  const q = event.queryStringParameters ?? {};

  // 路徑 A:attached 本地代理連線(裝置 token)。
  // 代理帶 deviceId + tenantId,token 由 deviceToken 或共用的 token query 提供
  // (identitySource 仍是 token,故代理需把裝置 token 放在 token= 以觸發 authorizer)。
  const deviceId = q['deviceId'];
  const agentTenant = q['tenantId'];
  const deviceToken = q['deviceToken'] ?? q['token'];
  if (deviceId && deviceToken && agentTenant) {
    const ok = await verifyAgent(agentTenant, deviceId, deviceToken);
    if (ok) {
      return policy('Allow', event.methodArn, `agent:${deviceId}`, {
        tenantId: agentTenant,
        role: 'agent',
        deviceId,
      });
    }
    return policy('Deny', event.methodArn, 'unknown');
  }

  // 路徑 B:前端使用者連線(Cognito JWT)。
  const token =
    q['token'] ??
    event.headers?.['Authorization']?.replace(/^Bearer\s+/i, '') ??
    '';

  try {
    const payload = await verifier.verify(token);
    const tenantId = (payload['custom:tenantId'] as string | undefined) ?? '';
    if (!tenantId) return policy('Deny', event.methodArn, 'unknown');
    return policy('Allow', event.methodArn, String(payload.sub), {
      tenantId,
      sub: String(payload.sub),
      role: 'user',
    });
  } catch {
    return policy('Deny', event.methodArn, 'unknown');
  }
}
