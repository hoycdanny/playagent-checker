import { describe, expect, test } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack.js';
import {
  ExecutionStack,
  HOST_LIFECYCLE_TAG,
  HOST_LIFECYCLE_PER_JOB,
} from '../lib/execution-stack.js';

const env = { account: '111111111111', region: 'us-east-2' };

function synthExecution(runnerImageTag?: string, useExistingRunnerRepos = false) {
  const app = new App();
  const foundation = new FoundationStack(app, 'F', { env });
  const execution = new ExecutionStack(app, 'E', {
    env,
    dataBucket: foundation.dataBucket,
    tenantRole: foundation.tenantDataRole.role,
    ...(runnerImageTag ? { runnerImageTag } : {}),
    ...(useExistingRunnerRepos ? { useExistingRunnerRepos: true } : {}),
  });
  return Template.fromStack(execution);
}

describe('ExecutionStack — 裝置主機生命週期(Req 4.3/4.5/4.6)', () => {
  test('建立裝置 VPC(natGateways:0,無 NAT 計費)', () => {
    const t = synthExecution();
    t.resourceCountIs('AWS::EC2::VPC', 1);
    // natGateways:0 → 不應建立任何 NAT Gateway。
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
  });

  test('建立 emulator 與 windows 兩台每任務主機的角色 + SG,加上 Device Farm 與 Web Fargate task 的 SG', () => {
    const t = synthExecution();
    // emulator host、windows host 各一 SG + Device Farm 探索 Fargate SG + Web 探索 Fargate SG = 4。
    t.resourceCountIs('AWS::EC2::SecurityGroup', 4);
  });

  test('建立 Device Farm 與 Web 探索的 ECS 叢集 / Fargate task 定義 / ECR repo', () => {
    const t = synthExecution();
    // 共用一個 cluster;Device Farm + Web 各一個 task def 與 ECR repo。
    t.resourceCountIs('AWS::ECS::Cluster', 1);
    t.resourceCountIs('AWS::ECS::TaskDefinition', 2);
    t.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'playagent-exploration-runner',
    });
    t.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'playagent-web-runner',
    });
  });

  test('Device Farm runner 有足夠資源在容器內合併數百 MB 的 XAPK(2 vCPU / 8 GB / 40 GiB)', () => {
    const t = synthExecution();
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '2048',
      Memory: '8192',
      EphemeralStorage: { SizeInGiB: 40 },
      ContainerDefinitions: Match.arrayWith([Match.objectLike({ Name: 'exploration-runner' })]),
    });
  });

  test('指定 Git SHA 時,兩個 Fargate task definition 都鎖定不可變 tag', () => {
    const body = JSON.stringify(synthExecution('0123456789abcdef').toJSON());
    expect(body.match(/:0123456789abcdef/g)).toHaveLength(2);
  });

  test('destroy 後可匯入 Retain 的 ECR,不再建立同名 repository', () => {
    const t = synthExecution('git-sha', true);
    t.resourceCountIs('AWS::ECR::Repository', 0);
    t.resourceCountIs('AWS::ECS::TaskDefinition', 2);
    expect(JSON.stringify(t.toJSON()).match(/:git-sha/g)).toHaveLength(2);
  });

  test('引擎可終結主機,但僅限帶 per-job 生命週期標籤的實例(常駐機受保護,Req 4.5)', () => {
    const t = synthExecution();
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['ec2:TerminateInstances']),
            Condition: {
              StringEquals: {
                [`aws:ResourceTag/${HOST_LIFECYCLE_TAG}`]: HOST_LIFECYCLE_PER_JOB,
              },
            },
          }),
        ]),
      },
    });
  });

  test('引擎起主機須以 per-job 標籤(RequestTag 條件)', () => {
    const t = synthExecution();
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ec2:RunInstances',
            Condition: {
              StringEquals: {
                [`aws:RequestTag/${HOST_LIFECYCLE_TAG}`]: HOST_LIFECYCLE_PER_JOB,
              },
            },
          }),
        ]),
      },
    });
  });

  test('S3 Gateway Endpoint 存在(主機經內網存取 S3,不需 NAT)', () => {
    const t = synthExecution();
    t.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
    });
  });
});
