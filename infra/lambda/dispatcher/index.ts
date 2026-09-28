import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { SQSEvent } from 'aws-lambda';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const ENGINE_FN_ARN = process.env.ENGINE_FN_ARN ?? '';

const lambda = new LambdaClient({ region: REGION });

/**
 * 分派器(Req 3.8):SQS 佇列的消費者,負責「放行」——目前併發控制從簡(依賴 SQS
 * 與 Lambda 並發上限),放行方式是**直接非同步 Invoke 引擎 Lambda**(Event 型),
 * 而不是把引擎掛在 SQS 事件來源映射之後。這刻意保留「引擎不受 15 分鐘 ESM 壓縮」
 * 的擴充路徑:日後引擎換成 AgentCore 長工作時,分派器改呼叫 AgentCore,調度契約不變。
 */
export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    // 原樣轉發整個訊息(含 vlmModel 等額外欄位),不解構丟棄。
    const msg = JSON.parse(record.body) as Record<string, unknown>;
    await lambda.send(
      new InvokeCommand({
        FunctionName: ENGINE_FN_ARN,
        InvocationType: 'Event', // 非同步:放行後不等引擎跑完
        Payload: Buffer.from(JSON.stringify(msg)),
      }),
    );
  }
}
