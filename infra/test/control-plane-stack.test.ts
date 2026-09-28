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

describe('ControlPlaneStack', () => {
  test('建立 HTTP API', () => {
    // HTTP API + WebSocket API 各一
    synth().hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
    });
  });

  test('建立 JWT authorizer', () => {
    synth().hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
    });
  });

  test('路由套用 authorizer(非匿名可存取)', () => {
    synth().hasResourceProperties('AWS::ApiGatewayV2::Route', {
      AuthorizationType: 'JWT',
    });
  });

  test('API Lambda 使用 Node 22 runtime', () => {
    synth().hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    });
  });
});
