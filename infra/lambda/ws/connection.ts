import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const BUCKET = process.env.DATA_BUCKET ?? '';

const s3 = new S3Client({ region: REGION });

function connKey(tenantId: string, jobId: string, connectionId: string): string {
  return `tenants/${tenantId}/jobs/${jobId}/connections/${connectionId}`;
}

interface AuthzContext {
  tenantId?: string;
  sub?: string;
}

/**
 * WebSocket 路由 handler:$connect / $disconnect / subscribe。
 * 訂閱以小物件記在 S3 `tenants/<t>/jobs/<jobId>/connections/<connId>`,
 * 供 S3 事件推送 Lambda 反查該任務有哪些連線(Req 5.5)。
 */
export async function handler(
  event: APIGatewayProxyWebsocketEventV2 & {
    requestContext: {
      routeKey: string;
      connectionId: string;
      authorizer?: AuthzContext;
    };
    body?: string;
  },
): Promise<{ statusCode: number }> {
  const { routeKey, connectionId } = event.requestContext;
  const tenantId = event.requestContext.authorizer?.tenantId ?? '';

  if (routeKey === '$connect') {
    // 連線建立(授權已由 authorizer 完成);實際訂閱在 subscribe 訊息時記錄。
    return { statusCode: 200 };
  }

  if (routeKey === '$disconnect') {
    // 盡力清掉此連線在所有任務下的訂閱(掃該租戶 jobs 下的 connections)。
    // 為簡單起見,依賴訂閱物件的自然過期與 PostToConnection 失敗時的清理(見推送 Lambda)。
    return { statusCode: 200 };
  }

  if (routeKey === 'subscribe') {
    const body = event.body ? (JSON.parse(event.body) as { jobId?: string }) : {};
    const jobId = body.jobId ?? '';
    if (tenantId && jobId) {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: connKey(tenantId, jobId, connectionId),
          Body: JSON.stringify({ subscribedAt: new Date().toISOString() }),
          ContentType: 'application/json',
        }),
      );
    }
    return { statusCode: 200 };
  }

  return { statusCode: 200 };
}

/** 供推送 Lambda 使用:列出某任務的所有訂閱連線 id。 */
export async function listConnections(
  tenantId: string,
  jobId: string,
): Promise<string[]> {
  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: `tenants/${tenantId}/jobs/${jobId}/connections/`,
    }),
  );
  return (res.Contents ?? [])
    .map((o) => o.Key?.split('/').pop())
    .filter((k): k is string => Boolean(k));
}

/** 移除失效連線的訂閱(PostToConnection 得 410 時)。 */
export async function removeConnection(
  tenantId: string,
  jobId: string,
  connectionId: string,
): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: connKey(tenantId, jobId, connectionId),
    }),
  );
}
