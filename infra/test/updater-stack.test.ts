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

/** 合成一次,整個檔案共用(理由見 control-plane-stack.test.ts)。Template 只被讀取。 */
let cached: Template | undefined;
const template = () => (cached ??= synth());

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
    const t = template();
    t.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: 'codebuild.amazonaws.com' } })]),
      }),
      Description: Match.stringLikeRegexp('runner image builds'),
    });
  });

  test('權限只到指定的 log / ECR repo / codebuild/ 前綴(沒有萬用 S3 或 IAM)', () => {
    const t = template();
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
    const t = template();
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

/**
 * 部署閘門:三個 workspace 的測試都要跑過才部署。
 *
 * 為什麼要把這件事釘在測試裡:infra 的測試原本被排除在閘門之外(理由是「有幾個與本功能
 * 無關的既有失敗」),而 infra 佔這個 repo 的大半 —— 等於最大的一塊完全沒有閘門。
 * 實測有 5 個斷言從 userdata 拆分那個 commit 起就在測一個已經不含該邏輯的檔案,
 * 連續好幾次部署都沒被擋下來。把清單釘住,下次有人因為「測試很慢」或「有個失敗很煩」
 * 想拿掉某一個 workspace 時,會先撞到這個測試。
 */
describe('UpdaterStack — 部署前的測試閘門', () => {
  function buildSpecOf(t: Template): string {
    const projects = t.findResources('AWS::CodeBuild::Project');
    const p = Object.values(projects)[0];
    expect(p).toBeDefined();
    // BuildSpec 是一段 JSON 字串(CDK 會把它內嵌);直接比字串就夠,不需要解析結構。
    return JSON.stringify(p!.Properties.Source.BuildSpec);
  }

  test('web / worker / infra 三組測試都在閘門裡', () => {
    const spec = buildSpecOf(synth());
    for (const s of ['npm run test:web', 'npm run test:worker', 'npm run test:infra']) {
      expect(spec, `部署閘門少了 ${s}`).toContain(s);
    }
  });

  test('三個 workspace 的型別檢查也在閘門裡(vitest 不做型別檢查)', () => {
    const spec = buildSpecOf(synth());
    for (const s of ['npm run typecheck:web', 'npm run typecheck:worker', 'npm run typecheck:infra']) {
      expect(spec, `部署閘門少了 ${s}`).toContain(s);
    }
  });

  test('型別檢查排在測試之前(先擋掉編不過的程式再跑測試)', () => {
    const spec = buildSpecOf(synth());
    expect(spec.indexOf('npm run typecheck:web')).toBeLessThan(spec.indexOf('npm run test:web'));
  });

  test('測試不過就不部署(用 && 串,不是 ; 或 ||)', () => {
    const spec = buildSpecOf(synth());
    // `;` 會讓失敗被忽略、照樣往下部署,那就不是閘門了。
    expect(spec).toContain('npm run test:web && npm run test:worker && npm run test:infra');
  });

  test('PA_RUN_TESTS=0 仍可跳過(救急用,預設是 1)', () => {
    const t = template();
    expect(buildSpecOf(t)).toContain('$PA_RUN_TESTS');
    t.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({
        EnvironmentVariables: Match.arrayWith([
          Match.objectLike({ Name: 'PA_RUN_TESTS', Value: '1' }),
        ]),
      }),
    });
  });
});
