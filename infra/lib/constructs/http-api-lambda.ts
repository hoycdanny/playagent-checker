import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export interface HttpApiLambdaProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  dataBucket: s3.IBucket;
  /** 共用的租戶隔離角色(foundation 建立)。 */
  tenantRole: iam.IRole;
  /** 分派佇列(提交任務時 enqueue;scheduling 建立)。 */
  dispatchQueue: sqs.IQueue;
  region: string;
  /** Bedrock KB 服務角色 ARN(runtime 建 KB 時 PassRole)。 */
  kbServiceRoleArn: string;
  /** S3 Vectors 向量桶命名前綴。 */
  kbVectorBucketPrefix: string;
  /** KB embeddings 模型 id。 */
  kbEmbeddingModelId: string;
}

/**
 * HttpApiLambda —— 控制面 API(Req 1)。
 *
 * 組成:
 * - Node zip Lambda(純 Request→Response 核心)承載 API。
 * - HTTP API + Cognito JWT authorizer:未帶合法 JWT 一律 401(Req 1.1)。
 * - 租戶資料角色 `TenantDataRole`:信任本 Lambda 角色 AssumeRole,IAM 政策用
 *   條件鍵 `${aws:PrincipalTag/tenantId}` 把 S3 存取釘死在 `tenants/<tenantId>/*`
 *   —— 即使請求偽造 tenantId 也跨不了租戶(Req 1.2/1.3)。
 */
export class HttpApiLambda extends Construct {
  readonly httpApi: apigwv2.HttpApi;
  readonly apiFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: HttpApiLambdaProps) {
    super(scope, id);

    // API Lambda(Node zip,核心為純函式)。
    this.apiFn = new NodejsFunction(this, 'ApiFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(currentDir, '..', '..', 'lambda', 'api', 'handler.ts'),
      handler: 'handler',
      // 建 Bedrock KB / 向量桶 + 索引 + KB + DataSource 為同步序列,15s 常不夠(會 timeout,
      // 留下已建的向量桶但沒寫回座標的殘僵狀態)。放寬到 60s 讓 provision 能一次完成。
      timeout: Duration.seconds(60),
      memorySize: 256,
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        TENANT_ROLE_ARN: props.tenantRole.roleArn,
        DISPATCH_QUEUE_URL: props.dispatchQueue.queueUrl,
        // 成員管理(admin 專用):對本 user pool 做 Admin* 操作。
        USER_POOL_ID: props.userPool.userPoolId,
        // Bedrock KB(Stage B):runtime 建 KB 用。
        KB_SERVICE_ROLE_ARN: props.kbServiceRoleArn,
        KB_VECTOR_BUCKET_PREFIX: props.kbVectorBucketPrefix,
        KB_EMBEDDING_MODEL_ID: props.kbEmbeddingModelId,
      },
      // 建 KB / ingestion 可能較久;放寬 timeout(建 KB 動作序含多次 API 呼叫)。
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
      },
    });

    // 讓 API Lambda 能扮演租戶角色,並以 tenantId 作 session tag。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [props.tenantRole.roleArn],
      }),
    );

    // 共用知識庫(跨租戶,所有登入使用者共用)存於 shared/ 前綴,不經租戶隔離角色,
    // 由 API Lambda 自身角色直接存取。範圍嚴格限縮在 shared/* 前綴。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [`${props.dataBucket.bucketArn}/shared/*`],
      }),
    );
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [props.dataBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['shared/*'] } },
      }),
    );

    // ── Bedrock KB(Stage B):runtime 建/刪整座 KB + 向量桶 + ingestion ──
    const acct = Stack.of(this).account;
    const rgn = props.region;
    // Bedrock KnowledgeBase + DataSource + ingestion(scope 到本專案 KB 命名空間)。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:CreateKnowledgeBase',
          'bedrock:DeleteKnowledgeBase',
          'bedrock:GetKnowledgeBase',
          'bedrock:CreateDataSource',
          'bedrock:DeleteDataSource',
          'bedrock:GetDataSource',
          'bedrock:StartIngestionJob',
          'bedrock:GetIngestionJob',
          'bedrock:ListIngestionJobs',
          // CreateKnowledgeBase 帶 tags 需要 TagResource;缺這個 provision 會 AccessDenied。
          'bedrock:TagResource',
        ],
        resources: [`arn:aws:bedrock:${rgn}:${acct}:knowledge-base/*`],
      }),
    );
    // S3 Vectors 向量桶/索引建立與刪除(scope 到本專案命名前綴)。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          's3vectors:CreateVectorBucket',
          's3vectors:DeleteVectorBucket',
          's3vectors:GetVectorBucket',
          's3vectors:CreateIndex',
          's3vectors:DeleteIndex',
          's3vectors:GetIndex',
          's3vectors:ListVectorBuckets',
          's3vectors:TagResource',
        ],
        resources: [
          `arn:aws:s3vectors:${rgn}:${acct}:bucket/${props.kbVectorBucketPrefix}*`,
          `arn:aws:s3vectors:${rgn}:${acct}:bucket/${props.kbVectorBucketPrefix}*/index/*`,
        ],
      }),
    );
    // 把 KB 服務角色傳給 Bedrock(iam:PassRole，權限較廣故 scope 到單一角色 arn)。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [props.kbServiceRoleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'bedrock.amazonaws.com' } },
      }),
    );

    // 提交任務時把訊息送入分派佇列。
    props.dispatchQueue.grantSendMessages(this.apiFn);

    // AI 草擬案例需呼叫 Bedrock(跨區推論 profile 需涵蓋 foundation-model 與 inference-profile)。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:*::foundation-model/*`,
          `arn:aws:bedrock:*:${Stack.of(this).account}:inference-profile/*`,
        ],
      }),
    );

    // 裝置管理頁顯示 Device Farm 真機池:唯讀 ListDevices(不支援資源級條件,故 *)。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['devicefarm:ListDevices'],
        resources: ['*'],
      }),
    );

    // 費用分析頁取 AWS 真實成本:Cost Explorer 唯讀(CE 不支援資源級條件,故 *)。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ce:GetCostAndUsage',
          'ce:GetCostForecast',
          'ce:GetDimensionValues',
          'ce:GetTags',
        ],
        resources: ['*'],
      }),
    );

    // 成員管理(admin 專用):對本 user pool 的使用者管理(列出/新增/設密碼/停用啟用/加群組)。
    // 後端另有 requireAdmin(檢查 JWT cognito:groups 含 admins)才允許呼叫這些動作。scope 到本 pool。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminListGroupsForUser',
        ],
        resources: [props.userPool.userPoolArn],
      }),
    );

    // JWT authorizer(綁 User Pool + client)。
    const issuer = `https://cognito-idp.${props.region}.amazonaws.com/${props.userPool.userPoolId}`;
    const authorizer = new HttpJwtAuthorizer('JwtAuthorizer', issuer, {
      jwtAudience: [props.userPoolClient.userPoolClientId],
      identitySource: ['$request.header.Authorization'],
    });

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      corsPreflight: {
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'], // 單帳號 dev;正式環境可收斂為 CloudFront 網域
      },
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', this.apiFn);
    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration,
      authorizer,
    });

    new CfnOutput(Stack.of(this), 'ApiUrl', {
      value: this.httpApi.apiEndpoint,
      description: '控制面 API 端點',
    });
  }
}
