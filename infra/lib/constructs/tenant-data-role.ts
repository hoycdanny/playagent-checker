import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface TenantDataRoleProps {
  dataBucket: s3.IBucket;
}

/**
 * TenantDataRole —— 多租戶隔離的核心角色(Req 1.2)。
 * 由 API/引擎 Lambda 以 session tag `tenantId` 扮演;IAM 條件鍵
 * `${aws:PrincipalTag/tenantId}` 把 S3 存取釘死在該租戶前綴,
 * 即使請求偽造 tenantId 也跨不了租戶。
 *
 * 放在 foundation(共用):API Lambda 與引擎 Lambda 都扮演它,避免跨 stack 循環依賴。
 * 信任關係在建立時先開放給帳號 root(同帳號內的 Lambda 角色可扮演),
 * 各扮演者再於自己的角色政策授予 sts:AssumeRole + TagSession。
 */
export class TenantDataRole extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: TenantDataRoleProps) {
    super(scope, id);

    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.AccountRootPrincipal(),
      description:
        'Tenant-prefix-scoped data access role (session tag tenantId)',
    });

    // session tagging 需在角色的「信任政策」明確允許 sts:TagSession,
    // 不能只在呼叫者的身分政策授予(否則 AssumeRole 帶 Tags 會 AccessDenied)。
    this.role.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:TagSession'],
        principals: [new iam.AccountRootPrincipal()],
      }),
    );

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [
          `${props.dataBucket.bucketArn}/tenants/\${aws:PrincipalTag/tenantId}/*`,
        ],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [props.dataBucket.bucketArn],
        conditions: {
          StringLike: {
            's3:prefix': ['tenants/${aws:PrincipalTag/tenantId}/*'],
          },
        },
      }),
    );
  }

  /** 授予某 Lambda 扮演本租戶角色(sts:AssumeRole + TagSession)。 */
  grantAssume(fn: lambda.Function): void {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [this.role.roleArn],
      }),
    );
  }
}
