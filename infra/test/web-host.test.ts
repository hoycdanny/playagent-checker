import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * webHost 把任務設定轉成 Fargate 容器的環境變數。這一層沒測到的話,前端讓使用者選了
 * 決策/輔助 Agent 模型,卻可能整路靜默地沒傳進 runner —— 功能看起來在、實際沒作用。
 */

const sent: Array<{ input: Record<string, unknown> }> = [];

vi.mock('@aws-sdk/client-ecs', () => {
  class RunTaskCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class ECSClient {
    async send(cmd: { input: Record<string, unknown> }) {
      sent.push(cmd);
      return { tasks: [{ taskArn: 'arn:aws:ecs:us-west-2:1:task/abc' }] };
    }
  }
  return { ECSClient, RunTaskCommand };
});

/** webHost 在模組載入時讀 CDK 注入的環境變數,所以要先設好再 import。 */
async function loadWebHost() {
  process.env.WEB_ECS_CLUSTER = 'cluster-1';
  process.env.WEB_ECS_TASK_DEF = 'taskdef-1';
  process.env.WEB_ECS_SUBNETS = 'subnet-a,subnet-b';
  process.env.WEB_ECS_CONTAINER = 'web-runner';
  vi.resetModules();
  return import('../lambda/engine/webHost.js');
}

const BASE = {
  tenantId: 't-001',
  jobId: 'job-1',
  appId: 'app-1',
  bucket: 'bucket-1',
  prefix: 'tenants/t-001/jobs/job-1',
  url: 'https://example.test/',
};

/** 取出送進容器的環境變數,整理成 name → value。 */
function envOf(call: { input: Record<string, unknown> }): Record<string, string> {
  const overrides = call.input.overrides as {
    containerOverrides: Array<{ name: string; environment: Array<{ name: string; value: string }> }>;
  };
  const out: Record<string, string> = {};
  for (const e of overrides.containerOverrides[0]!.environment) out[e.name] = e.value;
  return out;
}

beforeEach(() => {
  sent.length = 0;
});

describe('startWebRun:三個 Agent 席位的模型要傳進容器', () => {
  test('選了決策與輔助 Agent → PA_AGENT_MODEL / PA_SUBAGENT_MODEL 帶進去', async () => {
    const { startWebRun } = await loadWebHost();
    await startWebRun({
      ...BASE,
      vlmModel: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      agentModel: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
      subagentModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      caseTask: '登入並進入主畫面',
    });
    const env = envOf(sent[0]!);
    expect(env.PA_VLM).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(env.PA_AGENT_MODEL).toBe('us.anthropic.claude-opus-4-5-20251101-v1:0');
    expect(env.PA_SUBAGENT_MODEL).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(env.PA_TASK).toBe('登入並進入主畫面');
  });

  test('沒選席位 → 兩個變數是空字串,runner 據此退回單一 VLM 行為', async () => {
    const { startWebRun } = await loadWebHost();
    await startWebRun({ ...BASE, vlmModel: 'us.amazon.nova-lite-v1:0' });
    const env = envOf(sent[0]!);
    // 必須存在且為空:runner 用 (AGENT_MODEL || SUBAGENT_MODEL) 判斷要不要啟用席位,
    // 空字串剛好是「不啟用」。
    expect(env.PA_AGENT_MODEL).toBe('');
    expect(env.PA_SUBAGENT_MODEL).toBe('');
  });

  test('只選決策 Agent → 輔助留空(兩個席位可以獨立開關)', async () => {
    const { startWebRun } = await loadWebHost();
    await startWebRun({ ...BASE, agentModel: 'us.amazon.nova-pro-v1:0' });
    const env = envOf(sent[0]!);
    expect(env.PA_AGENT_MODEL).toBe('us.amazon.nova-pro-v1:0');
    expect(env.PA_SUBAGENT_MODEL).toBe('');
  });
});

describe('startWebRun:既有行為不能被改壞', () => {
  test('基本 S3 位置與起始網址照舊', async () => {
    const { startWebRun } = await loadWebHost();
    await startWebRun({ ...BASE });
    const env = envOf(sent[0]!);
    expect(env.PA_URL).toBe('https://example.test/');
    expect(env.PA_JOB).toBe('job-1');
    expect(env.PA_TENANT).toBe('t-001');
    expect(env.PA_APP).toBe('app-1');
    expect(env.PA_BUCKET).toBe('bucket-1');
    expect(env.PA_PREFIX).toBe('tenants/t-001/jobs/job-1');
  });

  test('沒設步數上限就不注入 PA_MAXSTEPS(runner 端 = 無上限)', async () => {
    const { startWebRun } = await loadWebHost();
    await startWebRun({ ...BASE });
    expect(envOf(sent[0]!).PA_MAXSTEPS).toBeUndefined();
  });

  test('設了步數上限才注入', async () => {
    const { startWebRun } = await loadWebHost();
    await startWebRun({ ...BASE, maxSteps: 50 });
    expect(envOf(sent[0]!).PA_MAXSTEPS).toBe('50');
  });

  test('回傳 ECS task ARN', async () => {
    const { startWebRun } = await loadWebHost();
    const res = await startWebRun({ ...BASE });
    expect(res.ecsTaskArn).toBe('arn:aws:ecs:us-west-2:1:task/abc');
  });
});
