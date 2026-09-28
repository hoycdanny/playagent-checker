import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as events from 'aws-cdk-lib/aws-events';
import { Construct } from 'constructs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export interface WsApiProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  dataBucket: s3.IBucket;
  region: string;
}

/**
 * WsApi —— 即時串流(Req 5.4/5.5)。
 * WebSocket API + Lambda authorizer(query token 驗 JWT)+ 連線 handler(訂閱記 S3)
 * + S3 事件推送 Lambda(EventBridge 觸發 → PostToConnection 扇出)。
 * 引擎只寫 S3,從不對 WS 端點通訊 —— 保持無憑證。
 */
export class WsApi extends Construct {
  readonly wsApi: apigwv2.WebSocketApi;
  readonly wsStage: apigwv2.WebSocketStage;

  constructor(scope: Construct, id: string, props: WsApiProps) {
    super(scope, id);

    const commonBundling = { format: OutputFormat.ESM, target: 'node22' as const };

    // $connect 的 Lambda authorizer(query token 驗 JWT)。
    const authorizerFn = new NodejsFunction(this, 'WsAuthorizerFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(currentDir, '..', '..', 'lambda', 'ws', 'authorizer.ts'),
      handler: 'handler',
      timeout: Duration.seconds(10),
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClient.userPoolClientId,
        DATA_BUCKET: props.dataBucket.bucketName,
      },
      bundling: commonBundling,
    });
    // authorizer 需讀 devices/<id>.json 比對 attached 代理 token(Req 13.1)。
    props.dataBucket.grantRead(authorizerFn);

    // 連線 handler($connect/$disconnect/subscribe)—— 寫訂閱到 S3。
    const connectionFn = new NodejsFunction(this, 'WsConnectionFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(currentDir, '..', '..', 'lambda', 'ws', 'connection.ts'),
      handler: 'handler',
      timeout: Duration.seconds(10),
      environment: { DATA_BUCKET: props.dataBucket.bucketName },
      bundling: commonBundling,
    });
    props.dataBucket.grantReadWrite(connectionFn);

    const authorizer = new WebSocketLambdaAuthorizer(
      'WsAuthorizer',
      authorizerFn,
      { identitySource: ['route.request.querystring.token'] },
    );

    this.wsApi = new apigwv2.WebSocketApi(this, 'WsApi', {
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration('ConnectInt', connectionFn),
        authorizer,
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration('DisconnectInt', connectionFn),
      },
    });
    this.wsApi.addRoute('subscribe', {
      integration: new WebSocketLambdaIntegration('SubscribeInt', connectionFn),
    });

    this.wsStage = new apigwv2.WebSocketStage(this, 'WsStage', {
      webSocketApi: this.wsApi,
      stageName: 'prod',
      autoDeploy: true,
    });

    // 推送 Lambda:EventBridge 於資料桶物件寫入時觸發。
    const pushFn = new NodejsFunction(this, 'WsPushFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(currentDir, '..', '..', 'lambda', 'ws', 'push.ts'),
      handler: 'handler',
      timeout: Duration.seconds(30),
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        WS_ENDPOINT: `https://${this.wsApi.apiId}.execute-api.${props.region}.amazonaws.com/${this.wsStage.stageName}`,
      },
      bundling: commonBundling,
    });
    props.dataBucket.grantRead(pushFn);
    props.dataBucket.grantWrite(pushFn); // 清理失效連線訂閱
    // 允許推送 Lambda 對 WS 連線 PostToConnection。
    this.wsApi.grantManageConnections(pushFn);

    // EventBridge 規則:資料桶內 steps/ 與 status.json 寫入 → 觸發推送。
    new events.Rule(this, 'StepWriteRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.dataBucket.bucketName] },
          object: {
            key: [{ wildcard: 'tenants/*/jobs/*/steps/*.json' }],
          },
        },
      },
      targets: [new targets.LambdaFunction(pushFn)],
    });
    new events.Rule(this, 'StatusWriteRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [props.dataBucket.bucketName] },
          object: {
            key: [{ wildcard: 'tenants/*/jobs/*/status.json' }],
          },
        },
      },
      targets: [new targets.LambdaFunction(pushFn)],
    });

    new CfnOutput(Stack.of(this), 'WsUrl', {
      value: this.wsStage.url,
      description: 'WebSocket 端點',
    });
  }
}
