import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * CognitoTenantPool —— 多租戶身分來源(對齊 Req 1)。
 *
 * 設計要點:
 * - 自訂屬性 `custom:tenantId` 承載租戶身分。控制面只信任 JWT 內的此 claim,
 *   不信任請求主體自述的 tenantId(Req 1.3);身分推不出即拒絕(Req 1.4)。
 * - `RemovalPolicy.RETAIN`:User Pool 是有狀態資源,`cdk destroy` 不連帶刪除
 *   使用者(CDK 有狀態資源保護)。
 * - app client 啟用 USER_PASSWORD_AUTH:SPA 直接以帳密登入(無 client secret,
 *   公開客戶端不存放機密)。
 */
export class CognitoTenantPool extends Construct {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false, // 由管理者建立使用者,不開放自助註冊
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      customAttributes: {
        // 租戶身分。可變設 false —— 使用者的租戶歸屬不應被自行更改。
        tenantId: new cognito.StringAttribute({
          minLen: 1,
          maxLen: 128,
          mutable: false,
        }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      authFlows: {
        userPassword: true, // USER_PASSWORD_AUTH:SPA 帳密登入
        userSrp: true,
      },
      generateSecret: false, // 公開客戶端,無 secret
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });

    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });
    new CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID(前端建置期注入)',
    });
  }
}
