import { describe, test } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack.js';

/**
 * FoundationStack 不變式(對齊 Req 1 / CDK 有狀態資源保護):
 * User Pool 保留、含 custom:tenantId、app client 啟用 USER_PASSWORD_AUTH。
 */
function synth() {
  const app = new App();
  const stack = new FoundationStack(app, 'TestFoundation');
  return Template.fromStack(stack);
}

describe('FoundationStack', () => {
  test('建立單一 Cognito User Pool', () => {
    const t = synth();
    t.resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  test('User Pool 設 RETAIN(有狀態資源不隨 destroy 刪除)', () => {
    const t = synth();
    t.hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('User Pool 含不可變的 custom:tenantId 屬性', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([
        Match.objectLike({
          Name: 'tenantId',
          Mutable: false,
        }),
      ]),
    });
  });

  test('關閉自助註冊(僅管理者建立使用者)', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
  });

  test('app client 啟用 USER_PASSWORD_AUTH 且無 client secret', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH']),
      GenerateSecret: false,
    });
  });
});
