// 看一個 Windows 任務的 stream session 狀態(找不到 session ARN 時,從 stream group 列出最近的 session)。
// 用法:node watch.mjs <jobId>
import { GameLiftStreamsClient, ListStreamSessionsCommand, GetStreamSessionCommand } from '@aws-sdk/client-gameliftstreams';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

const REGION = process.env.AWS_REGION ?? 'us-east-2';
const STACK = process.env.PA_STACK ?? 'PlayAgentDev-Execution';
const jobId = process.argv[2];
const ssm = new SSMClient({ region: REGION });
const p = await ssm.send(new GetParametersCommand({ Names: [`/playagent/${STACK}/windows-gls/streamGroupId`] }));
const sg = p.Parameters?.[0]?.Value;
const gl = new GameLiftStreamsClient({ region: REGION });
const list = await gl.send(new ListStreamSessionsCommand({ Identifier: sg }));
const items = (list.Items ?? []).sort((a, b) => String(b.CreatedAt ?? '').localeCompare(String(a.CreatedAt ?? '')));
for (const s of items.slice(0, 5)) {
  const hit = !jobId || s.Description === jobId;
  const d = await gl.send(new GetStreamSessionCommand({ Identifier: sg, StreamSessionIdentifier: s.Arn }));
  console.log(hit ? '>' : ' ', d.Description, d.Status, d.StatusReason ?? '', d.CreatedAt?.toISOString() ?? '', d.LogFileLocationUri ?? '');
}
