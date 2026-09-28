import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import type { EventBridgeEvent } from 'aws-lambda';
import { listConnections, removeConnection } from './connection.js';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const BUCKET = process.env.DATA_BUCKET ?? '';
const WS_ENDPOINT = process.env.WS_ENDPOINT ?? ''; // https://<id>.execute-api...

const s3 = new S3Client({ region: REGION });
const apigw = new ApiGatewayManagementApiClient({
  region: REGION,
  endpoint: WS_ENDPOINT,
});

interface S3ObjectEventDetail {
  bucket: { name: string };
  object: { key: string };
}

/** 解析 key:tenants/<t>/jobs/<jobId>/(steps|status).../ */
function parseKey(
  key: string,
): { tenantId: string; jobId: string; kind: 'step' | 'status' } | null {
  const decoded = decodeURIComponent(key.replace(/\+/g, ' '));
  const m = /^tenants\/([^/]+)\/jobs\/([^/]+)\/(steps\/\d+\.json|status\.json)$/.exec(
    decoded,
  );
  if (!m) return null;
  return {
    tenantId: m[1]!,
    jobId: m[2]!,
    kind: m[3]!.startsWith('steps/') ? 'step' : 'status',
  };
}

/**
 * S3 事件推送(Req 5.5):引擎只寫 S3;此 Lambda 由 EventBridge 於物件寫入時觸發,
 * 讀出內容 → 反查該任務的訂閱連線 → PostToConnection 扇出。引擎全程不碰 WS 端點。
 */
export async function handler(
  event: EventBridgeEvent<'Object Created', S3ObjectEventDetail>,
): Promise<void> {
  const key = event.detail?.object?.key;
  if (!key) return;
  const parsed = parseKey(key);
  if (!parsed) return; // 只推 steps 與 status,其餘忽略

  const { tenantId, jobId, kind } = parsed;

  // 讀出寫入的內容
  let payload: unknown;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await obj.Body?.transformToString();
    payload = text ? JSON.parse(text) : null;
  } catch {
    return;
  }

  const message = JSON.stringify({ type: kind, jobId, data: payload });
  const connections = await listConnections(tenantId, jobId);

  await Promise.all(
    connections.map(async (connectionId) => {
      try {
        await apigw.send(
          new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: Buffer.from(message),
          }),
        );
      } catch (err) {
        // 410 Gone:連線已斷,清掉訂閱
        if (err instanceof Error && err.name === 'GoneException') {
          await removeConnection(tenantId, jobId, connectionId).catch(() => {});
        }
      }
    }),
  );
}
