import { describe, test } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack.js';
import { ExecutionStack } from '../lib/execution-stack.js';
import { SchedulingStack } from '../lib/scheduling-stack.js';
import { ControlPlaneStack } from '../lib/control-plane-stack.js';

const env = { account: '111111111111', region: 'us-east-2' };

function synth() {
  const app = new App();
  const foundation = new FoundationStack(app, 'TestFoundation', { env });
  const execution = new ExecutionStack(app, 'TestExecution', {
    env,
    dataBucket: foundation.dataBucket,
    tenantRole: foundation.tenantDataRole.role,
  });
  const scheduling = new SchedulingStack(app, 'TestScheduling', {
    env,
    engineFn: execution.engineFn,
  });
  const cp = new ControlPlaneStack(app, 'TestControlPlane', {
    env,
    userPool: foundation.userPool,
    userPoolClient: foundation.userPoolClient,
    dataBucket: foundation.dataBucket,
    tenantRole: foundation.tenantDataRole.role,
    dispatchQueue: scheduling.dispatchQueue,
    kbServiceRoleArn: foundation.kbFoundation.serviceRole.roleArn,
    kbVectorBucketPrefix: 'playagent-kb-',
    kbEmbeddingModelId: 'amazon.titan-embed-text-v2:0',
  });
  return Template.fromStack(cp);
}

/**
 * 合成一次,四個測試共用。
 *
 * 每個測試各合成一遍的代價不只是慢:這個檔案會把四個 stack(含所有 Lambda 的 esbuild
 * bundling)重跑四次,實測單檔 60 秒,其中第一個測試就佔 34 秒。單一測試長時間佔住事件迴圈
 * 會讓 vitest 的 worker 來不及回報進度(Timeout calling "onTaskUpdate"),整個 run 以 exit 1
 * 結束 —— 即使所有測試都通過。Template 只被讀取(hasResourceProperties 等斷言),共用不會互相影響。
 */
let cached: Template | undefined;
const template = () => (cached ??= synth());

describe('ControlPlaneStack', () => {
  test('建立 HTTP API', () => {
    // HTTP API + WebSocket API 各一
    template().hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
    });
  });

  test('建立 JWT authorizer', () => {
    template().hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
    });
  });

  test('路由套用 authorizer(非匿名可存取)', () => {
    template().hasResourceProperties('AWS::ApiGatewayV2::Route', {
      AuthorizationType: 'JWT',
    });
  });

  test('API Lambda 使用 Node 22 runtime', () => {
    template().hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    });
  });
});
