#!/usr/bin/env node
/**
 * 一鍵建立平台使用者(方案 A)。免記 Cognito 指令:自動解析 user pool、建帳號、設永久密碼、
 * (可選)加入 admins 群組。
 *
 * 用法:
 *   AWS_REGION=us-east-2 node createUser.mjs --email you@example.com --tenant globex-us --password 'Str0ng!Pass'
 *   # 建管理員(可用成員管理頁):加 --admin
 *   AWS_REGION=us-east-2 node createUser.mjs --email admin@example.com --tenant globex-us --password 'Str0ng!Pass' --admin
 *
 * 參數:
 *   --email     (必填)登入 email(即 username)
 *   --tenant    (必填)租戶 id(寫入 custom:tenantId)
 *   --password  (必填)初始密碼(直接設為永久密碼,免首次改密碼)
 *   --admin     (選)加入 admins 群組
 *   --pool-id   (選)直接指定 User Pool Id;省略則從 CloudFormation 解析
 *   --stack     (選)Foundation stack 名(預設 PlayAgentDev-Foundation)
 */
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const REGION = process.env.AWS_REGION || process.env.PA_SM_REGION || 'us-east-2';
const ADMIN_GROUP = 'admins';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

async function resolvePoolId(stackName) {
  const cfn = new CloudFormationClient({ region: REGION });
  const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = res.Stacks?.[0]?.Outputs ?? [];
  // Foundation 的 CognitoTenantPool 輸出 key 含 "UserPoolId"(不含 "Client")。
  const out = outputs.find(
    (o) => (o.OutputKey || '').includes('UserPoolId') && !(o.OutputKey || '').includes('Client'),
  );
  if (!out?.OutputValue) {
    throw new Error(`在 stack ${stackName} 找不到 UserPoolId 輸出;請用 --pool-id 直接指定`);
  }
  return out.OutputValue;
}

async function main() {
  const email = arg('email');
  const tenant = arg('tenant');
  const password = arg('password');
  const admin = flag('admin');
  const stackName = arg('stack', 'PlayAgentDev-Foundation');
  let poolId = arg('pool-id');

  if (!email || !tenant || !password) {
    console.error('用法:node createUser.mjs --email <e> --tenant <t> --password <p> [--admin] [--pool-id <id>] [--stack <name>]');
    process.exit(1);
  }
  if (!poolId) {
    poolId = await resolvePoolId(stackName);
    console.log(`解析到 User Pool:${poolId}`);
  }

  const cognito = new CognitoIdentityProviderClient({ region: REGION });

  // 1) 建帳號(SUPPRESS 不寄信;帶 email_verified + custom:tenantId)。
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: poolId,
        Username: email,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'custom:tenantId', Value: tenant },
        ],
      }),
    );
    console.log(`已建立使用者:${email}(租戶 ${tenant})`);
  } catch (err) {
    if (err?.name === 'UsernameExistsException') {
      console.log(`使用者已存在:${email}(略過建立,續設密碼)`);
    } else {
      throw err;
    }
  }

  // 2) 設永久密碼(免首次改密碼)。
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
  console.log('已設定永久密碼。');

  // 3) 選:加入 admins 群組。
  if (admin) {
    await cognito.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: poolId,
        Username: email,
        GroupName: ADMIN_GROUP,
      }),
    );
    console.log(`已加入 ${ADMIN_GROUP} 群組(管理員)。`);
  }

  console.log(`✅ 完成。${email} 可用該密碼登入${admin ? '(管理員)' : ''}。`);
}

main().catch((e) => {
  console.error('失敗:', e?.message || e);
  process.exit(1);
});
