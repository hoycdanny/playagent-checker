import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/** admin 群組名(JWT cognito:groups 內含此值者為管理員,可用成員管理)。 */
export const ADMIN_GROUP = 'admins';

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
      // 管理員邀請信(安裝器 --admin-invite / 成員管理):臨時密碼,第一次登入時在登入頁設定新密碼。
      userInvitation: {
        emailSubject: 'PlayAgent Checker 帳號邀請 / Your PlayAgent Checker account',
        emailBody:
          '您好,<br><br>已為您建立 PlayAgent Checker 帳號。<br>'
          + '登入帳號:{username}<br>臨時密碼:{####}<br><br>'
          + '請用這組臨時密碼登入,登入後系統會請您設定自己的密碼。臨時密碼 7 天內有效。<br><br>'
          + 'Your PlayAgent Checker account is ready.<br>Username: {username}<br>Temporary password: {####}<br>'
          + 'Sign in with it and you will be asked to set your own password. It expires in 7 days.',
      },
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
      // 登入維持 48 小時:id/access token 1 小時到期由前端用 refresh token 自動換新,
      // refresh token 48 小時後失效 → 必須重新登入(伺服器端上限,前端另有同樣的計時)。
      refreshTokenValidity: Duration.hours(48),
      preventUserExistenceErrors: true,
    });

    // 管理員群組:JWT cognito:groups 含 "admins" 者可用成員管理(後端 requireAdmin 判定)。
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: ADMIN_GROUP,
      description: '管理員:可管理成員(列出/新增/停用使用者)',
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
