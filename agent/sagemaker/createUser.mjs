#!/usr/bin/env node
/**
 * 安全建立／更新 Cognito 使用者。密碼只接受隱藏式互動輸入或 stdin，永不接受 argv。
 *
 * 互動:
 *   node createUser.mjs --email admin@example.com --tenant default --admin
 * 自動化:
 *   <secret-command> | node createUser.mjs --email admin@example.com --tenant default --admin --password-stdin
 * 邀請(不經手密碼,Cognito 寄臨時密碼):
 *   node createUser.mjs --email admin@example.com --tenant default --admin --invite
 */
import { execFileSync } from 'node:child_process';
import { randomInt, timingSafeEqual } from 'node:crypto';
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import {
  promptHidden,
  readSecretFromStdin,
  validateCognitoPassword,
} from '../../scripts/secret-input.mjs';

const REGION = process.env.PA_SM_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-2';
const ADMIN_GROUP = 'admins';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return fallback;
}
function flag(name) { return process.argv.includes(`--${name}`); }
function maskedEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * 產生一組符合 Cognito 預設密碼規則的臨時密碼(至少含大寫、小寫、數字、符號;長度 16)。
 * 刻意避開易混淆字元(0/O/1/l/I)。
 */
function genTempPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digit = '23456789';
  const symbol = '!@#%*-_=+';
  const all = upper + lower + digit + symbol;
  const pick = (set) => set[randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digit), pick(symbol)];
  while (chars.length < 16) chars.push(pick(all));
  // Fisher–Yates 洗牌,避免前四位固定是各類別。
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

function validateInputs(email, tenant) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('請提供有效的管理員 Email（Cognito username）');
  if (!tenant || !/^[A-Za-z0-9._-]{1,128}$/.test(tenant)) throw new Error('tenant 只能使用 1–128 個英數字、點、底線或連字號');
  if (process.argv.includes('--password') || process.argv.some((x) => x.startsWith('--password='))) {
    throw new Error('安全限制：不可用 --password 傳遞密碼；請使用隱藏輸入或 --password-stdin');
  }
}

function resolvePoolId(stackName) {
  const outputs = JSON.parse(execFileSync('aws', [
    'cloudformation', 'describe-stacks', '--region', REGION, '--stack-name', stackName,
    '--query', 'Stacks[0].Outputs', '--output', 'json',
  ], { encoding: 'utf8', windowsHide: true }));
  const output = outputs.find((item) => String(item.OutputKey).includes('UserPoolId') && !String(item.OutputKey).includes('Client'))?.OutputValue;
  if (!output) throw new Error(`在 stack ${stackName} 找不到 UserPoolId；請用 --pool-id 指定`);
  return String(output);
}

async function promptConfirmedPassword() {
  while (true) {
    const first = await promptHidden('管理員密碼（8–256 字元，含英文大小寫與數字）: ');
    try {
      validateCognitoPassword(first);
      const second = await promptHidden('再次輸入密碼: ');
      try {
        if (first.length === second.length && timingSafeEqual(first, second)) return first;
        console.error('兩次密碼不同，請重新輸入。');
      } finally {
        second.fill(0);
      }
    } catch (error) {
      if (error.message === '使用者取消') {
        first.fill(0);
        throw error;
      }
      console.error(error.message);
    }
    first.fill(0);
  }
}

async function findUser(cognito, poolId, email) {
  try {
    return await cognito.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }));
  } catch (error) {
    if (error?.name === 'UserNotFoundException') return null;
    throw error;
  }
}

/**
 * 邀請模式(--invite):不經手任何密碼。Cognito 寄一封含臨時密碼的信到 email,
 * 使用者第一次登入時在登入頁設定自己的密碼(NEW_PASSWORD_REQUIRED)。
 * 帳號已存在就不動密碼(重跑安裝 = 更新,不會把管理員的密碼重設掉),只確保在管理員群組。
 */
async function invite({ poolId, email, tenant, admin, tempPwParam }) {
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const user = await findUser(cognito, poolId, email);
  if (!user) {
    // 自己產生臨時密碼(而非讓 Cognito 自動產),這樣才能同時「寄信」又「交給安裝器顯示」。
    const tempPw = genTempPassword();
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: poolId,
      Username: email,
      TemporaryPassword: tempPw,
      DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'custom:tenantId', Value: tenant },
      ],
    }));
    console.log(`已建立使用者並寄出邀請信:${maskedEmail(email)}(臨時密碼 7 天內有效,第一次登入時設定新密碼)`);
    // 把臨時密碼寫進短效 SSM 參數,交給安裝器讀取後顯示並立即刪除(值不進部署 log)。
    if (tempPwParam) {
      try {
        await new SSMClient({ region: REGION }).send(new PutParameterCommand({
          Name: tempPwParam, Value: tempPw, Type: 'String', Overwrite: true,
          Description: 'PlayAgent admin temporary password (read + deleted by the installer)',
        }));
        console.log(`臨時密碼已暫存到 SSM 參數供安裝器顯示:${tempPwParam}`);
      } catch (e) {
        console.log(`提醒:臨時密碼未能暫存到 SSM(${e?.name || e?.message || e});仍已寄送邀請信。`);
      }
    }
  } else {
    console.log(`使用者已存在:${maskedEmail(email)},保留原本的密碼。`);
  }
  if (admin) {
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: email, GroupName: ADMIN_GROUP }));
    console.log(`已加入 ${ADMIN_GROUP} 群組(管理員)。`);
  }
}

async function main() {
  const email = arg('email');
  const tenant = arg('tenant', 'default');
  const admin = flag('admin');
  const passwordStdin = flag('password-stdin');
  const stackName = arg('stack', 'PlayAgentDev-Foundation');
  let poolId = arg('pool-id');
  validateInputs(email, tenant);

  if (!poolId) {
    poolId = resolvePoolId(stackName);
    console.log(`解析到 User Pool:${poolId}`);
  }

  if (flag('invite')) {
    await invite({ poolId, email, tenant, admin, tempPwParam: arg('temp-pw-param') });
    return;
  }

  const password = passwordStdin ? await readSecretFromStdin() : await promptConfirmedPassword();
  try {
    validateCognitoPassword(password);
    const cognito = new CognitoIdentityProviderClient({ region: REGION });
    let user = await findUser(cognito, poolId, email);

    if (!user) {
      try {
        await cognito.send(new AdminCreateUserCommand({
          UserPoolId: poolId,
          Username: email,
          MessageAction: 'SUPPRESS',
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
            { Name: 'custom:tenantId', Value: tenant },
          ],
        }));
        console.log(`已建立使用者:${maskedEmail(email)}（tenant ${tenant}）`);
      } catch (error) {
        if (error?.name !== 'UsernameExistsException') throw error;
      }
      user = await findUser(cognito, poolId, email);
    }

    const existingTenant = user?.UserAttributes?.find((x) => x.Name === 'custom:tenantId')?.Value;
    if (existingTenant !== tenant) {
      if (tenant === 'default' && existingTenant) {
        console.log('既有使用者會保留原本的 tenant。');
      } else {
        throw new Error(`使用者 ${maskedEmail(email)} 已屬於另一個 tenant；Cognito tenantId 不可變更，請使用正確 tenant 或建立另一個帳號`);
      }
    }

    await cognito.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId,
      Username: email,
      Password: password.toString('utf8'),
      Permanent: true,
    }));
    console.log('已安全設定永久密碼。');

    if (admin) {
      await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: email, GroupName: ADMIN_GROUP }));
      console.log(`已加入 ${ADMIN_GROUP} 群組（管理員）。`);
    }
    console.log(`✅ 完成。${maskedEmail(email)} 現在可以登入${admin ? '（管理員）' : ''}。`);
  } finally {
    password.fill(0);
  }
}

main().catch((error) => {
  console.error('失敗:', error?.message || error);
  process.exitCode = 1;
});
