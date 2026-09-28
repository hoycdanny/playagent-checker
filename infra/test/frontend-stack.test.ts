import { describe, test } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FrontendStack } from '../lib/frontend-stack.js';

/**
 * FrontendStack 基礎設施不變式(對齊 Req 1.5):
 * 前端桶必須封鎖所有公開存取,且只有 CloudFront 經 OAC 能讀。
 * assetPath 指向不存在目錄 → 不觸發 BucketDeployment,只驗 S3 + CloudFront 骨架。
 */
function synth() {
  const app = new App();
  const stack = new FrontendStack(app, 'TestFrontend', {
    assetPath: '/nonexistent-asset-path-for-test',
  });
  return Template.fromStack(stack);
}

describe('FrontendStack', () => {
  test('前端 S3 桶封鎖所有公開存取', () => {
    const t = synth();
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('桶政策強制 SSL(拒絕非加密傳輸)', () => {
    const t = synth();
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  test('建立 CloudFront distribution 並使用 OAC', () => {
    const t = synth();
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  test('桶政策只允許 CloudFront service principal 讀取', () => {
    const t = synth();
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
          }),
        ]),
      },
    });
  });

  test('CloudFront 預設回退 index.html 供 SPA 路由(403/404 → 200)', () => {
    const t = synth();
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      }),
    });
  });
});
