import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type * as iam from 'aws-cdk-lib/aws-iam';
import { HttpApiLambda } from './constructs/http-api-lambda.js';
import { WsApi } from './constructs/ws-api.js';

export interface ControlPlaneStackProps extends StackProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  dataBucket: s3.IBucket;
  tenantRole: iam.IRole;
  dispatchQueue: sqs.IQueue;
  /** Bedrock KB 服務角色 ARN(runtime 建 KB 時 PassRole 給 Bedrock)。 */
  kbServiceRoleArn: string;
  /** S3 Vectors 向量桶命名前綴(IAM scope 用)。 */
  kbVectorBucketPrefix: string;
  /** KB embeddings 模型 id。 */
  kbEmbeddingModelId: string;
}

/**
 * ControlPlaneStack —— 控制面:HTTP API + Cognito JWT authorizer + API Lambda。
 * 租戶隔離角色與分派佇列由其他 stack 建立,經 props 直接參照傳入。
 * 階段 6 再加 WebSocket。
 */
export class ControlPlaneStack extends Stack {
  readonly api: HttpApiLambda;
  readonly ws: WsApi;

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);

    this.api = new HttpApiLambda(this, 'Api', {
      userPool: props.userPool,
      userPoolClient: props.userPoolClient,
      dataBucket: props.dataBucket,
      tenantRole: props.tenantRole,
      dispatchQueue: props.dispatchQueue,
      region: this.region,
      kbServiceRoleArn: props.kbServiceRoleArn,
      kbVectorBucketPrefix: props.kbVectorBucketPrefix,
      kbEmbeddingModelId: props.kbEmbeddingModelId,
    });

    // 即時串流(WebSocket + S3 事件推送)。
    this.ws = new WsApi(this, 'Ws', {
      userPool: props.userPool,
      userPoolClient: props.userPoolClient,
      dataBucket: props.dataBucket,
      region: this.region,
    });
  }
}
