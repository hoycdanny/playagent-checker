import { describe, test } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack.js';
import { ExecutionStack } from '../lib/execution-stack.js';
import { SchedulingStack } from '../lib/scheduling-stack.js';
import { ControlPlaneStack } from '../lib/control-plane-stack.js';

const env = { account: '111111111111', region: 'us-east-2' };

function synthControlPlane() {
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
  const cp = new ControlPlaneStack(app, 'CP', {
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

describe('WsApi(Req 5 即時串流)', () => {
  test('建立 WebSocket API', () => {
    const t = synthControlPlane();
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'WEBSOCKET',
    });
  });

  test('$connect 套用 Lambda authorizer(JWT 驗)', () => {
    const t = synthControlPlane();
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'REQUEST',
      IdentitySource: ['route.request.querystring.token'],
    });
  });

  test('推送由 EventBridge 規則觸發(引擎不直接對 WS 通訊)', () => {
    const t = synthControlPlane();
    // steps/*.json 與 status.json 各一條規則
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.s3'],
        'detail-type': ['Object Created'],
      }),
    });
  });
});
