/**
 * App 憑證表(每個 App 一組 key→entry,存於單一 Secrets Manager secret 的 JSON)。
 *
 * entry 形態:{ value: string, visible: boolean }
 *   - visible=false(預設,遮蔽):值不進 AI context;AI 只看到 key 名,在 type 的 text 用 ${key},
 *     runner 在輸入到裝置那一刻才替換成真值(適合帳號/密碼)。
 *   - visible=true(可見):值會連同 key 注入 AI context(例「伺服器名稱=daily-aws」),讓 AI 能在
 *     下拉/清單中「點對」正確項目(這類操作無法用遮蔽的 ${key} 完成)。type 時仍可用 ${key} 替換。
 *
 * 向後相容:舊資料是 {key: "純字串"},一律視為 visible=false。
 *
 * 安全不變式:
 * - 值只存 Secrets Manager;API 只回 {key, visible} 清單,永不回傳「遮蔽值」給前端(可見值也不由 API 回,
 *   只由 engine 注入 context)。
 * - secret 名一律落 playagent/tenant/<tenantId>/app/<appId>/credentials,租戶+App 隔離。
 */
import type { SecretWriter } from './secretValueStore.js';

/** 單筆憑證(儲存形態)。 */
export interface CredentialEntry {
  value: string;
  visible: boolean;
}

/** App 憑證 secret 的完整名稱。 */
export function appCredentialsSecretName(tenantId: string, appId: string): string {
  return `playagent/tenant/${tenantId}/app/${appId}/credentials`;
}

/** 把原始 JSON 值正規化成 CredentialEntry(相容舊式純字串 → visible=false)。 */
function normalizeEntry(raw: unknown): CredentialEntry {
  if (typeof raw === 'string') return { value: raw, visible: false };
  if (raw && typeof raw === 'object') {
    const o = raw as { value?: unknown; visible?: unknown };
    return { value: typeof o.value === 'string' ? o.value : String(o.value ?? ''), visible: o.visible === true };
  }
  return { value: String(raw ?? ''), visible: false };
}

/** 讀出並正規化整張憑證表(內部用;含值)。 */
async function readAll(
  writer: SecretWriter,
  tenantId: string,
  appId: string,
): Promise<Record<string, CredentialEntry>> {
  const json = await writer.getSecretJson(appCredentialsSecretName(tenantId, appId));
  const out: Record<string, CredentialEntry> = {};
  for (const [k, v] of Object.entries(json)) out[k] = normalizeEntry(v);
  return out;
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

/** 憑證清單項(回前端;只含 key 名與是否可見,永不含值)。 */
export interface CredentialListItem {
  key: string;
  visible: boolean;
}

/** 列出某 App 已設定的憑證 {key, visible}(依 key 排序;永不回值)。 */
export async function listAppCredentials(
  writer: SecretWriter,
  tenantId: string,
  appId: string,
): Promise<CredentialListItem[]> {
  const all = await readAll(writer, tenantId, appId);
  return Object.entries(all)
    .map(([key, e]) => ({ key, visible: e.visible }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 只回「可見」憑證的 {key, value}(供 engine 注入 context 讓 AI 點對)。
 * 遮蔽憑證絕不由此回傳。此函式會讀出可見值明文,呼叫端(engine)只把它放進 context,不落 log。
 */
export async function readVisibleCredentials(
  writer: SecretWriter,
  tenantId: string,
  appId: string,
): Promise<Array<{ key: string; value: string }>> {
  const all = await readAll(writer, tenantId, appId);
  return Object.entries(all)
    .filter(([, e]) => e.visible)
    .map(([key, e]) => ({ key, value: e.value }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** 設定/更新某 key 的值 + 可見性(merge 進現有 JSON,upsert)。回更新後的 {key,visible} 清單。 */
export async function putAppCredential(
  writer: SecretWriter,
  tenantId: string,
  appId: string,
  key: string,
  value: string,
  visible: boolean,
): Promise<CredentialListItem[]> {
  const name = appCredentialsSecretName(tenantId, appId);
  const all = await readAll(writer, tenantId, appId);
  all[key] = { value, visible };
  await writer.putSecretValue(name, JSON.stringify(all));
  return Object.entries(all)
    .map(([k, e]) => ({ key: k, visible: e.visible }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** 刪除某 key(整組空了就刪整個 secret)。回剩餘 {key,visible} 清單。 */
export async function deleteAppCredential(
  writer: SecretWriter,
  tenantId: string,
  appId: string,
  key: string,
): Promise<CredentialListItem[]> {
  const name = appCredentialsSecretName(tenantId, appId);
  const all = await readAll(writer, tenantId, appId);
  if (!(key in all)) {
    return Object.entries(all).map(([k, e]) => ({ key: k, visible: e.visible })).sort((a, b) => a.key.localeCompare(b.key));
  }
  delete all[key];
  const remaining = Object.keys(all);
  if (remaining.length === 0) {
    await writer.deleteSecret(name);
    return [];
  }
  await writer.putSecretValue(name, JSON.stringify(all));
  return Object.entries(all)
    .map(([k, e]) => ({ key: k, visible: e.visible }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
