import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
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
export interface CognitoTenantPoolProps {
  /** 初始 admin 帳號(部署時經 context 帶入;省略則不建,改用一鍵腳本)。 */
  initialAdmin?: { email: string; password: string; tenantId: string };
}

export class CognitoTenantPool extends Construct {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: CognitoTenantPoolProps = {}) {
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
      // 登入維持 48 小時:id/access token 1 小時到期由前端用 refresh token 自動換新,
      // refresh token 48 小時後失效 → 必須重新登入(伺服器端上限,前端另有同樣的計時)。
      refreshTokenValidity: Duration.hours(48),
      preventUserExistenceErrors: true,
    });

    // 管理員群組:JWT cognito:groups 含 "admins" 者可用成員管理(後端 requireAdmin 判定)。
    const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: ADMIN_GROUP,
      description: '管理員:可管理成員(列出/新增/停用使用者)',
    });

    // 初始 admin(方案 B):部署時以 context 帶入 email/password/tenantId 即自動建立。
    // 用 AwsCustomResource 依序呼叫 AdminCreateUser(SUPPRESS 不寄信)、AdminSetUserPassword
    // (permanent 免改密碼)、AdminAddUserToGroup(admins)。省略則不建(改用一鍵腳本)。
    if (props.initialAdmin) {
      const { email, password, tenantId } = props.initialAdmin;
      const poolId = this.userPool.userPoolId;
      const commonPolicy = AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'cognito-idp:AdminCreateUser',
            'cognito-idp:AdminSetUserPassword',
            'cognito-idp:AdminAddUserToGroup',
          ],
          resources: [this.userPool.userPoolArn],
        }),
      ]);

      const createUser = new AwsCustomResource(this, 'InitialAdminCreate', {
        onCreate: {
          service: 'CognitoIdentityServiceProvider',
          action: 'adminCreateUser',
          parameters: {
            UserPoolId: poolId,
            Username: email,
            MessageAction: 'SUPPRESS',
            UserAttributes: [
              { Name: 'email', Value: email },
              { Name: 'email_verified', Value: 'true' },
              { Name: 'custom:tenantId', Value: tenantId },
            ],
          },
          physicalResourceId: PhysicalResourceId.of(`initial-admin-${email}`),
          // 帳號已存在(重複部署)不視為錯誤。
          ignoreErrorCodesMatching: 'UsernameExistsException',
        },
        policy: commonPolicy,
        installLatestAwsSdk: false,
      });

      const setPassword = new AwsCustomResource(this, 'InitialAdminPassword', {
        onCreate: {
          service: 'CognitoIdentityServiceProvider',
          action: 'adminSetUserPassword',
          parameters: {
            UserPoolId: poolId,
            Username: email,
            Password: password,
            Permanent: true,
          },
          physicalResourceId: PhysicalResourceId.of(`initial-admin-pw-${email}`),
        },
        policy: commonPolicy,
        installLatestAwsSdk: false,
      });
      setPassword.node.addDependency(createUser);

      const addToGroup = new AwsCustomResource(this, 'InitialAdminGroup', {
        onCreate: {
          service: 'CognitoIdentityServiceProvider',
          action: 'adminAddUserToGroup',
          parameters: {
            UserPoolId: poolId,
            Username: email,
            GroupName: ADMIN_GROUP,
          },
          physicalResourceId: PhysicalResourceId.of(`initial-admin-group-${email}`),
        },
        policy: commonPolicy,
        installLatestAwsSdk: false,
      });
      addToGroup.node.addDependency(createUser);
      addToGroup.node.addDependency(adminGroup);
    }

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
