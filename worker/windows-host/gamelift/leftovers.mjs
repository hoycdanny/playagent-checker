// 殘留資源檢查:GameLift stream session / Fargate task / Device Farm session / EC2。
// 本機 AWS CLI 2.17 沒有 gameliftstreams,所以這支用 Node SDK;其餘用 CLI(stderr 丟掉避免污染輸出)。
import { execFileSync } from 'node:child_process';
import { GameLiftStreamsClient, ListStreamSessionsCommand } from '@aws-sdk/client-gameliftstreams';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

// 平台部署在 us-west-2(早期 PoC 在 us-east-2)。查錯的區域,寫錯等於永遠回報「乾淨」。
const REGION = process.env.AWS_REGION ?? 'us-west-2';
const cli = (args) => {
  const raw = execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(raw || 'null');
};
const rows = [];

try {
  const ssm = new SSMClient({ region: REGION });
  const p = await ssm.send(new GetParametersCommand({ Names: ['/playagent/PlayAgentDev-Execution/windows-gls/streamGroupId'] }));
  const sg = p.Parameters?.[0]?.Value;
  const gl = new GameLiftStreamsClient({ region: REGION });
  const r = await gl.send(new ListStreamSessionsCommand({ Identifier: sg }));
  const live = (r.Items ?? []).filter((s) => !['TERMINATED', 'ERROR'].includes(s.Status));
  rows.push([live.length === 0, 'GameLift stream session', live.length === 0 ? `全部已終止(共 ${r.Items?.length ?? 0} 筆歷史)` : live.map((s) => `${s.Description}:${s.Status}`).join(', ')]);
} catch (e) {
  rows.push([false, 'GameLift stream session', e.message]);
}

try {
  const clusters = cli(['ecs', 'list-clusters', '--region', REGION, '--query', 'clusterArns', '--output', 'json']) ?? [];
  const live = [];
  for (const c of clusters) {
    for (const t of cli(['ecs', 'list-tasks', '--cluster', c, '--desired-status', 'RUNNING', '--region', REGION, '--query', 'taskArns', '--output', 'json']) ?? []) live.push(t);
  }
  rows.push([live.length === 0, 'Fargate task', live.length === 0 ? `0 個執行中(檢查了 ${clusters.length} 個 cluster)` : `${live.length} 個還在跑`]);
} catch (e) {
  rows.push([false, 'Fargate task', e.message]);
}

try {
  const projects = cli(['devicefarm', 'list-projects', '--region', 'us-west-2', '--query', 'projects[].arn', '--output', 'json']) ?? [];
  let live = 0;
  for (const p of projects) {
    const r = cli(['devicefarm', 'list-remote-access-sessions', '--arn', p, '--region', 'us-west-2', '--output', 'json']);
    live += (r?.remoteAccessSessions ?? []).filter((s) => s.status === 'RUNNING' || s.status === 'PENDING').length;
  }
  rows.push([live === 0, 'Device Farm session', live === 0 ? `0 個進行中(檢查了 ${projects.length} 個 project)` : `${live} 個還開著`]);
} catch (e) {
  rows.push([false, 'Device Farm session', e.message]);
}

try {
  const ids = cli(['ec2', 'describe-instances', '--region', REGION,
    '--filters', 'Name=instance-state-name,Values=pending,running,stopping,stopped',
    '--query', 'Reservations[].Instances[].InstanceId', '--output', 'json']) ?? [];
  rows.push([ids.length === 0, 'EC2 實例', ids.length === 0 ? '0 台' : ids.join(', ')]);
} catch (e) {
  rows.push([false, 'EC2 實例', e.message]);
}

for (const [good, name, detail] of rows) console.log(`${good ? 'OK  ' : 'FAIL'} ${name} :: ${detail}`);
console.log(`\n${rows.filter((r) => !r[0]).length} 項有殘留 / 共 ${rows.length} 項`);
