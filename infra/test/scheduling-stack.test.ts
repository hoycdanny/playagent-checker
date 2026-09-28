import { describe, test } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack.js';
import { ExecutionStack } from '../lib/execution-stack.js';
import { SchedulingStack } from '../lib/scheduling-stack.js';

const env = { account: '111111111111', region: 'us-east-2' };

function synthScheduling() {
  const app = new App();
  const foundation = new FoundationStack(app, 'F', { env });
  const execution = new ExecutionStack(app, 'E', {
    env,
    dataBucket: foundation.dataBucket,
    tenantRole: foundation.tenantDataRole.role,
  });
  const scheduling = new SchedulingStack(app, 'S', {
    env,
    engineFn: execution.engineFn,
  });
  return { sched: Template.fromStack(scheduling), exec: Template.fromStack(execution) };
}

describe('SchedulingStack(Req 3.8 兩層排程)', () => {
  test('建立分派佇列 + 死信佇列', () => {
    const { sched } = synthScheduling();
    sched.resourceCountIs('AWS::SQS::Queue', 2);
  });

  test('分派器 Lambda 是 SQS 佇列的消費者(ESM)', () => {
    const { sched } = synthScheduling();
    sched.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
  });

  test('引擎 Lambda 不掛在 SQS ESM 之後(引擎在 execution stack,scheduling 無引擎 ESM 指向它)', () => {
    // 關鍵不變式:唯一的 ESM 在 scheduling(分派器消費佇列);
    // 引擎於 execution stack,scheduling 只透過直接 Invoke 觸發它,故 scheduling 的
    // ESM 目標不應是引擎。此處以「execution stack 完全沒有 EventSourceMapping」佐證
    // 引擎不由任何佇列 ESM 觸發。
    const { exec } = synthScheduling();
    exec.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
  });
});
