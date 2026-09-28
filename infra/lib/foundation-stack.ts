import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { CognitoTenantPool } from './constructs/cognito-tenant-pool.js';
import { TenantDataBucket } from './constructs/tenant-data-bucket.js';
import { TenantDataRole } from './constructs/tenant-data-role.js';
import { KnowledgeBaseFoundation } from './constructs/knowledge-base-foundation.js';

/** S3 Vectors 向量桶命名前綴(runtime 建 KB 用;IAM 萬用字元 scope 用)。 */
export const KB_VECTOR_BUCKET_PREFIX = 'playagent-kb-';
/** Bedrock KB embeddings 模型(Titan v2,1024 維)。 */
export const KB_EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';

/**
 * FoundationStack —— 有狀態、極少變更的資源:Cognito User Pool、資料 S3 桶、
 * 以及跨 stack 共用的租戶隔離角色。與頻繁迭代的 control-plane / frontend 分開,
 * 可獨立部署、降低誤動有狀態資源的風險。
 */
export class FoundationStack extends Stack {
  readonly userPool: cognito.IUserPool;
  readonly userPoolClient: cognito.IUserPoolClient;
  readonly dataBucket: s3.IBucket;
  readonly tenantDataRole: TenantDataRole;
  readonly kbFoundation: KnowledgeBaseFoundation;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const auth = new CognitoTenantPool(this, 'Auth');
    this.userPool = auth.userPool;
    this.userPoolClient = auth.userPoolClient;

    const data = new TenantDataBucket(this, 'Data');
    this.dataBucket = data.bucket;

    // 租戶隔離角色(API 與引擎共用,放 foundation 避免跨 stack 循環依賴)。
    this.tenantDataRole = new TenantDataRole(this, 'TenantRole', {
      dataBucket: this.dataBucket,
    });

    // Bedrock KB(S3 Vectors)共用基礎:KB 服務角色(不預建具體 KB,runtime 才建)。
    this.kbFoundation = new KnowledgeBaseFoundation(this, 'KbFoundation', {
      dataBucket: this.dataBucket,
      vectorBucketPrefix: KB_VECTOR_BUCKET_PREFIX,
      embeddingModelId: KB_EMBEDDING_MODEL_ID,
    });

    new CfnOutput(this, 'KbServiceRoleArn', {
      value: this.kbFoundation.serviceRole.roleArn,
      description: 'Bedrock KB 服務角色 ARN(runtime 建 KB 時傳給 Bedrock)',
    });
  }
}
