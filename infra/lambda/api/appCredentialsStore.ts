/**
 * App 憑證表(每個 App 一組 key-value,存於單一 Secrets Manager secret 的 JSON)。
 *
 * 用途:測試某遊戲時常需要帳號/密碼/伺服器名稱/IP 等。使用者在 App 底下 key 入這些欄位;
 * 執行任務時 engine 只把「key 名清單」注入 AI context(不含值),AI 需要時在 type 的 text
 * 用 ${key} 代入,runner 在輸入到裝置那一刻才替換成真值 —— 明文不進 prompt/trace/報告/log。
 *
 * 安全不變式:
 * - 值只存 Secrets Manager;API 只回 key 名清單,永不回傳值(getAppCredentialKeys)。
 * - secret 名一律落 playagent/tenant/<tenantId>/app/<appId>/credentials,租戶+App 隔離。
 */
import type { SecretWriter } from './secretValueStore.js';

/** App 憑證 secret 的完整名稱。 */
export function appCredentialsSecretName(tenantId: string, appId: string): string {
  return `playagent/tenant/${tenantId}/app/${appId}/credentials`;
}

/**
 * key 命名規則:允許中文等任意字元(使用者要用「帳號」「伺服器名稱」等中文鍵名),
 * 但排除會破壞 ${...} 佔位語法或造成注入的字元:大括號、$、控制字元,且不可含空白、不可為空、長度上限。
 */
export function isValidCredentialKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > 64) return false;
  if (/[{}$]/.test(key)) return false;
  if (/\s/.test(key)) return false; // 不允許空白(含全形空白由前端 trim 後仍禁一般空白)
  return true;
}

/** 列出某 App 已設定的憑證 key 名(排序;永不回值)。 */
export async function listAppCredentialKeys(
  writer: SecretWriter,
  tenantId: string,
  appId: string,
): Promise<string[]> {
  const json = await writer.getSecretJson(appCredentialsSecretName(tenantId, appId));
  return Object.keys(json).sort();
}

/** 設定/更新某 key 的值(merge 進現有 JSON,upsert 整個 secret)。回更新後的 key 名清單。 */
export async function putAppCredential(
  writer: SecretWriter,
  tenantId: string,
  appId: string,
  key: string,
  value: string,
): Promise<string[]> {
  const name = appCredentialsSecretName(tenantId, appId);
  const json = await writer.getSecretJson(name);
  json[key] = value;
  await writer.putSecretValue(name, JSON.stringify(json));
  return Object.keys(json).sort();
}

/** 刪除某 key(從 JSON 移除後 upsert;整組空了就刪整個 secret)。回剩餘 key 名清單。 */
export async function deleteAppCredential(
  writer: SecretWriter,
  tenantId: string,
  appId: string,
  key: string,
): Promise<string[]> {
  const name = appCredentialsSecretName(tenantId, appId);
  const json = await writer.getSecretJson(name);
  if (!(key in json)) return Object.keys(json).sort();
  delete json[key];
  const remaining = Object.keys(json);
  if (remaining.length === 0) {
    await writer.deleteSecret(name);
    return [];
  }
  await writer.putSecretValue(name, JSON.stringify(json));
  return remaining.sort();
}
