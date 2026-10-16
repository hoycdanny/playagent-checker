/**
 * runner 映像建置專案(playagent-runner-build / playagent-web-runner-build)要用的 CodeBuild 角色。
 *
 * 找法(依序):
 *   1. PA_IMAGE_BUILD_ROLE_ARN —— 自更新器會帶(Updater stack 建的角色)。
 *   2. Updater stack 的 Output ImageBuildRoleArn —— 手動執行時,平台已安裝就用它。
 *   3. 舊的手動角色 PlayAgentCodeBuildUitarsRole(cloudBuild.mjs 建的)—— 舊安裝相容。
 * Updater stack 的角色會跟著資料桶名稱更新,新帳號安裝就有;舊角色重裝後可能還指著舊桶。
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { IAMClient, GetRoleCommand } from '@aws-sdk/client-iam';

export const LEGACY_ROLE_NAME = 'PlayAgentCodeBuildUitarsRole';

export async function resolveImageBuildRoleArn(region, env = process.env) {
  const fromEnv = env.PA_IMAGE_BUILD_ROLE_ARN?.trim();
  if (fromEnv) return fromEnv;
  const stackName = env.PA_UPDATER_STACK?.trim() || `${env.PA_STACK_PREFIX?.trim() || 'PlayAgentDev'}-Updater`;
  try {
    const cfn = new CloudFormationClient({ region });
    const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const arn = r.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'ImageBuildRoleArn')?.OutputValue;
    if (arn) return arn;
  } catch { /* 還沒安裝 / 舊版 Updater 沒有這個 Output → 用舊角色 */ }
  const iam = new IAMClient({ region });
  return (await iam.send(new GetRoleCommand({ RoleName: LEGACY_ROLE_NAME }))).Role.Arn;
}
