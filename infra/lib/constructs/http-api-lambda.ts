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

/** UI-TARS 開關所需的固定設定(SageMaker 資源名、映像、權重、執行角色)。 */
export interface UitarsSwitchProps {
  /** 固定 endpoint 名;引擎與 runner 也用同一個名字(cdk context uitarsEndpoint)。 */
  endpointName: string;
  instanceType: string;
  /** vLLM BYOC 映像 URI。 */
  image: string;
  /** 模型權重 S3 字首(s3://bucket/prefix/)。 */
  modelDataS3: string;
  /** SageMaker 執行角色(拉映像 + 讀權重);API 需要 PassRole 給它。 */
  executionRoleArn: string;
  /** 套在 SageMaker 資源上的成本標籤。 */
  tags: Record<string, string>;
}

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
  /**
   * 系統更新(admin 一鍵更新)。名稱由 bin/app.ts 決定並同時給 UpdaterStack,
   * 用字面字串而非跨 stack 參照,兩邊才能各自單獨部署。省略則 /system/* 回 501。
   */
  updater?: {
    projectName: string;
    logGroupName: string;
    githubSecretName: string;
    deployedVersionParam: string;
    historyKey: string;
    repo: string;
  };
  /** UI-TARS 開關(系統管理頁)。省略則 /system/uitars 回 501。 */
  uitars?: UitarsSwitchProps;
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
      // 記憶體同時決定 CPU 配額。256MB 只有 ~0.15 vCPU,列表端點要並發讀數十~上百個 S3 物件
      // 並解析 JSON 時被 CPU 卡住(實測單次 5~8s)。提到 1024MB(~0.6 vCPU)大幅加快並發 I/O
      // 與解析;Lambda 按 ms 計費,跑得快通常淨成本持平甚至更低。
      memorySize: 1024,
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        TENANT_ROLE_ARN: props.tenantRole.roleArn,
        DISPATCH_QUEUE_URL: props.dispatchQueue.queueUrl,
        // 成員管理(admin 專用):對本 user pool 做 Admin* 操作。
        USER_POOL_ID: props.userPool.userPoolId,
        // Bedrock KB(Stage B):runtime 建 KB 用。
        KB_SERVICE_ROLE_ARN: props.kbServiceRoleArn,
        // 系統更新(admin 專用);未帶這組變數時 handler 不注入 systemUpdate,路由回 501。
        ...(props.updater
          ? {
            UPDATE_PROJECT_NAME: props.updater.projectName,
            DEPLOYED_VERSION_PARAM: props.updater.deployedVersionParam,
            GITHUB_SECRET_NAME: props.updater.githubSecretName,
            UPDATE_HISTORY_KEY: props.updater.historyKey,
            GITHUB_REPO: props.updater.repo,
          }
          : {}),
        KB_VECTOR_BUCKET_PREFIX: props.kbVectorBucketPrefix,
        KB_EMBEDDING_MODEL_ID: props.kbEmbeddingModelId,
        // UI-TARS 開關(admin 專用);未帶時 /system/uitars 回 501,UI-TARS 一律視為關閉。
        ...(props.uitars
          ? {
            UITARS_ENDPOINT_NAME: props.uitars.endpointName,
            UITARS_INSTANCE: props.uitars.instanceType,
            UITARS_IMAGE: props.uitars.image,
            UITARS_MODEL_S3: props.uitars.modelDataS3,
            UITARS_ROLE_ARN: props.uitars.executionRoleArn,
            UITARS_TAGS: JSON.stringify(props.uitars.tags),
          }
          : {}),
      },
      // 建 KB / ingestion 可能較久;放寬 timeout(建 KB 動作序含多次 API 呼叫)。
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        // 打包進來的 AWS SDK client 是 CJS,在 ESM bundle 裡會用到 require()。
        // 沒有這行 banner 就會在載入時炸「Dynamic require of "node:https" is not supported」
        // —— 而且是整支 Lambda 起不來,不是只有那一個路由壞掉。
        banner: "import{createRequire as __paCreateRequire}from'module';const require=__paCreateRequire(import.meta.url);",
        // 預設會把 @aws-sdk/* 全部視為 Lambda runtime 內建。GameLift Streams 太新,
        // runtime 內建的 SDK 不保證有這個 client,所以改成明列外部模組,
        // 讓 @aws-sdk/client-gameliftstreams 打包進 bundle。其餘仍用 runtime 內建。
        externalModules: [
          '@aws-sdk/client-s3', '@aws-sdk/client-sts', '@aws-sdk/client-sqs',
          '@aws-sdk/client-secrets-manager', '@aws-sdk/client-device-farm',
          '@aws-sdk/client-cost-explorer', '@aws-sdk/client-cognito-identity-provider',
          '@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-bedrock-agent',
          '@aws-sdk/client-bedrock-agent-runtime', '@aws-sdk/client-s3vectors',
          '@aws-sdk/client-lambda', '@aws-sdk/client-ec2', '@aws-sdk/client-ecs',
          '@aws-sdk/client-ssm', '@aws-sdk/client-codebuild',
          '@aws-sdk/client-cloudwatch-logs', '@aws-sdk/s3-request-presigner',
          '@aws-sdk/client-sagemaker',
        ],
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
    // 費用分析頁:讀 Device Farm session 的實際計量分鐘(唯讀),依任務歸屬裝置費用。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['devicefarm:ListProjects', 'devicefarm:ListRemoteAccessSessions'],
        resources: ['*'],
      }),
    );

    // 裝置管理頁的「容器 / 主機 / 串流」三區:執行基礎設施的唯讀快照。
    // 全部是 List/Describe/Get,沒有任何寫入;ECS/EC2 的 List* 不支援資源級條件,故 *。
    // (更新前「還有任務在跑」的檢查也用這組,之前只在有 updater 時才授權,現在常駐。)
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecs:ListClusters',
          'ecs:ListTasks',
          'ecs:DescribeTasks',
          'ec2:DescribeInstances',
          'ec2:DescribeTags',
        ],
        resources: ['*'],
      }),
    );
    // GameLift Streams(Windows GPU 串流)容量與進行中的 session:唯讀。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'gameliftstreams:GetStreamGroup',
          'gameliftstreams:ListStreamGroups',
          'gameliftstreams:ListStreamSessions',
        ],
        resources: [`arn:aws:gameliftstreams:${props.region}:${acct}:*`],
      }),
    );
    // stream group id 由 worker 的 setup 腳本寫在 /playagent/<stack>/windows-gls/*。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParametersByPath', 'ssm:GetParameters'],
        // GetParametersByPath 檢查的是「路徑本身」那個資源(/playagent),
        // 不是底下的參數,所以兩個 ARN 都要給。
        resources: [
          `arn:aws:ssm:${props.region}:${acct}:parameter/playagent`,
          `arn:aws:ssm:${props.region}:${acct}:parameter/playagent/*`,
        ],
      }),
    );

    // 測試憑證:API 建立/更新/刪除使用者的測試帳密(存 Secrets Manager,值永不回傳)。
    // scope 到本平台命名前綴 playagent/tenant/*;租戶隔離由後端以 tenantSecretPrefix 強制。
    // CreateSecret 不支援資源級 ARN(建立時資源尚不存在),故拆成兩條:建立用 *,其餘 scope 到前綴。
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:CreateSecret'],
        resources: ['*'],
      }),
    );
    this.apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'secretsmanager:PutSecretValue',
          'secretsmanager:DescribeSecret',
          'secretsmanager:DeleteSecret',
          'secretsmanager:TagResource',
          // App 憑證表:API 需讀回 secret 的 JSON 以 merge/列 key(值只用於內部,永不回傳前端)。
          'secretsmanager:GetSecretValue',
        ],
        resources: [`arn:aws:secretsmanager:*:${acct}:secret:playagent/tenant/*`],
      }),
    );

    // ── 系統更新(admin 專用)────────────────────────────────────────────
    // 注意:這組權限讓 API 能「觸發」更新,而更新本身會以 CDK 重新部署整個平台。
    // API 自己沒有部署權限,高權限在 UpdaterStack 的 CodeBuild 角色與 CloudFormation;
    // 真正的守門是後端 requireAdmin(JWT cognito:groups 含 admins)。
    if (props.updater) {
      const u = props.updater;
      this.apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds', 'codebuild:ListBuildsForProject'],
          resources: [`arn:aws:codebuild:${props.region}:${acct}:project/${u.projectName}`],
        }),
      );
      // 更新進度頁要讀 build log。log group 名是固定值,故可精確 scope。
      this.apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['logs:GetLogEvents'],
          resources: [`arn:aws:logs:${props.region}:${acct}:log-group:${u.logGroupName}:*`],
        }),
      );
      // 已部署版本(唯讀;寫入由更新器在 build 結束時做)。
      this.apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [`arn:aws:ssm:${props.region}:${acct}:parameter${u.deployedVersionParam}`],
        }),
      );
      // GitHub token:管理員從介面匯入(寫)+ 比對版本時呼叫 GitHub(讀)。
      this.apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:PutSecretValue', 'secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret', 'secretsmanager:TagResource'],
          resources: [`arn:aws:secretsmanager:*:${acct}:secret:${u.githubSecretName}-??????`],
        }),
      );
      // 更新歷史放 _system/ 前綴(與租戶資料隔離)。
      this.apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject'],
          resources: [`${props.dataBucket.bucketArn}/_system/*`],
        }),
      );
      // 更新前警告「還有任務在跑」用的 ecs/ec2 唯讀權限已移到上面常駐授權
      // (裝置管理頁也要用),這裡不再重複。
    }

    // UI-TARS 開關:只能動「固定名稱」的那一組 SageMaker 資源(endpoint / config / model),
    // 不能碰帳號裡其他 SageMaker 資源。開啟會產生 GPU 計費,真正的守門是後端 requireAdmin。
    if (props.uitars) {
      const ux = props.uitars;
      const smArn = (kind: string, name: string) => `arn:aws:sagemaker:${props.region}:${acct}:${kind}/${name}`;
      this.apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sagemaker:DescribeEndpoint', 'sagemaker:CreateEndpoint', 'sagemaker:DeleteEndpoint'],
          resources: [smArn('endpoint', ux.endpointName)],
        }),
      );
      // CreateEndpoint 會對 endpoint-config 做授權檢查,所以 config 也要允許 CreateEndpoint。
      this.apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sagemaker:DescribeEndpointConfig', 'sagemaker:CreateEndpointConfig', 'sagemaker:CreateEndpoint'],
          resources: [smArn('endpoint-config', `${ux.endpointName}-config`)],
        }),
      );
      this.apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sagemaker:DescribeModel', 'sagemaker:CreateModel'],
          resources: [smArn('model', `${ux.endpointName}-model`)],
        }),
      );
      // Create* 帶 Tags(成本分攤)需要 AddTags。
      this.apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['sagemaker:AddTags'],
          resources: [
            smArn('endpoint', ux.endpointName),
            smArn('endpoint-config', `${ux.endpointName}-config`),
            smArn('model', `${ux.endpointName}-model`),
          ],
        }),
      );
      // CreateModel 要把執行角色交給 SageMaker;限定只能交給 SageMaker 服務。
      this.apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [ux.executionRoleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'sagemaker.amazonaws.com' } },
        }),
      );
      // 開關紀錄寫在 _system/uitars.json(與更新歷史同前綴)。
      this.apiFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject'],
          resources: [`${props.dataBucket.bucketArn}/_system/uitars.json`],
        }),
      );
    }

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
          // 成員管理頁的其餘動作:取消管理員、改租戶、刪成員、列管理員群組成員。
          // 全部 scope 在本 user pool;真正的守門是後端 requireAdmin。
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:ListUsersInGroup',
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
