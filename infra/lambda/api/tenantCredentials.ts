import { S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

/**
 * 多租戶隔離核心(Req 1.2):以 STS session tag(tenantId)扮演資料角色,
 * 資料角色的 IAM 政策用條件鍵 `${aws:PrincipalTag/tenantId}` 把臨時憑證釘死在
 * 該租戶的 S3 前綴上。即使請求主體偽造 tenantId,取得的憑證也存取不到別的租戶。
 */
export interface AssumeTenantOptions {
  sts: STSClient;
  roleArn: string;
  region: string;
}

export async function assumeTenantS3(
  opts: AssumeTenantOptions,
  tenantId: string,
): Promise<S3Client> {
  // STS RoleSessionName 僅允許 [\w+=,.@-]
  const sessionName = `tenant-${tenantId}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 64);
  const res = await opts.sts.send(
    new AssumeRoleCommand({
      RoleArn: opts.roleArn,
      RoleSessionName: sessionName,
      Tags: [{ Key: 'tenantId', Value: tenantId }],
      DurationSeconds: 900,
    }),
  );
  const c = res.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new Error('AssumeRole 未回傳臨時憑證');
  }
  return new S3Client({
    region: opts.region,
    credentials: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
    },
  });
}

/** 租戶資料在 S3 的前綴。 */
export function tenantPrefix(tenantId: string): string {
  return `tenants/${tenantId}/`;
}
