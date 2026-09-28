/**
 * Device Farm endpoint 刷新(供 Fargate 容器內的 explorationRunner 用)。
 * remoteDriverEndpoint 是預簽名 URL,約 15 分後失效,必須重新呼叫 GetRemoteAccessSession
 * 取得新 URL(不能複用/改寫舊 URL)。
 */
import { GetRemoteAccessSessionCommand } from '@aws-sdk/client-device-farm';

/** @param {import('@aws-sdk/client-device-farm').DeviceFarmClient} client */
export async function refreshRemoteDriverEndpoint(client, sessionArn) {
  const resp = await client.send(new GetRemoteAccessSessionCommand({ arn: sessionArn }));
  const session = resp.remoteAccessSession;
  if (!session) throw new Error(`Device Farm session ${sessionArn} 不存在`);
  if (session.status !== 'RUNNING') {
    throw new Error(`session 無法刷新 endpoint(status=${session.status ?? 'UNKNOWN'})`);
  }
  const endpoint = session.endpoints?.remoteDriverEndpoint;
  if (!endpoint) throw new Error('session 運行中但無 remoteDriverEndpoint');
  return endpoint;
}
