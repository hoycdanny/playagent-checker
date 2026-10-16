import { describe, expect, test } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { UpdaterStack } from '../lib/updater-stack.js';

/**
 * UpdaterStack:runner 映像建置角色由 stack 自己建(新帳號安裝就有、資料桶換名會跟著更新),
 * 而且權限只到兩個 build 專案的 log、兩個 runner ECR repo、資料桶 codebuild/ 下的來源 zip。
 */
function synth() {
  const app = new App();
  const env = { account: '111111111111', region: 'us-west-2' };
  const data = new s3.Bucket(new Stack(app, 'Data', { env }), 'Bucket');
  const stack = new UpdaterStack(app, 'TestUpdater', {
    env,
    projectName: 'PlayAgentTest-self-update',
    logGroupName: '/playagent/PlayAgentTest/update',
    dataBucket: data,
    repo: 'owner/repo',
    targetStacks: ['A', 'B'],
    githubSecretName: 'secret',
    stateParamName: '/playagent/PlayAgentTest/deployed-version',
    imageBuildProjects: ['playagent-runner-build', 'playagent-web-runner-build'],
    imageRepos: ['playagent-exploration-runner', 'playagent-web-runner'],
    frontendConfigStacks: { foundation: 'F', controlPlane: 'C' },
  });
  return Template.fromStack(stack);
}

type Stmt = { Action: string | string[]; Resource: unknown; Condition?: unknown };
function statementsOf(t: Template, roleLogicalIdPrefix: string): Stmt[] {
  const roles = t.findResources('AWS::IAM::Role');
  const roleId = Object.keys(roles).find((k) => k.startsWith(roleLogicalIdPrefix));
  expect(roleId).toBeDefined();
  const policies = t.findResources('AWS::IAM::Policy');
  return Object.values(policies)
    .filter((p) => JSON.stringify(p.Properties.Roles).includes(roleId!))
    .flatMap((p) => p.Properties.PolicyDocument.Statement as Stmt[]);
}
const actions = (s: Stmt) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

describe('UpdaterStack — runner 映像建置角色', () => {
  test('stack 自己建一個只給 CodeBuild 扮的角色', () => {
    const t = synth();
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: 'codebuild.amazonaws.com' } })]),
      }),
      Description: Match.stringLikeRegexp('runner image builds'),
    });
  });

  test('權限只到指定的 log / ECR repo / codebuild/ 前綴(沒有萬用 S3 或 IAM)', () => {
    const t = synth();
    const stmts = statementsOf(t, 'ImageBuildRole');
    const all = stmts.flatMap(actions);
    expect(all.some((a) => a.startsWith('iam:'))).toBe(false);
    expect(all).not.toContain('s3:PutObject');
    for (const s of stmts) {
      const res = JSON.stringify(s.Resource);
      if (actions(s).some((a) => a.startsWith('ecr:') && a !== 'ecr:GetAuthorizationToken')) {
        expect(res).toContain('repository/playagent-exploration-runner');
        expect(res).toContain('repository/playagent-web-runner');
        expect(res).not.toBe('"*"');
      }
      if (actions(s).includes('s3:GetObject')) expect(res).toContain('/codebuild/*');
      if (actions(s).some((a) => a.startsWith('logs:'))) expect(res).toContain('/aws/codebuild/playagent-runner-build');
      if (res === '"*"') expect(actions(s)).toEqual(['ecr:GetAuthorizationToken']);
    }
  });

  test('更新器拿得到角色 ARN,而且只能把它交給 CodeBuild', () => {
    const t = synth();
    t.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({
        EnvironmentVariables: Match.arrayWith([Match.objectLike({ Name: 'PA_IMAGE_BUILD_ROLE_ARN' })]),
      }),
    });
    const pass = statementsOf(t, 'SelfUpdateRole').filter((s) => actions(s).includes('iam:PassRole'));
    expect(pass).toHaveLength(1);
    expect(JSON.stringify(pass[0]!.Resource)).toContain('ImageBuildRole');
    expect(pass[0]!.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'codebuild.amazonaws.com' } });
    t.hasOutput('ImageBuildRoleArn', {});
  });
});
