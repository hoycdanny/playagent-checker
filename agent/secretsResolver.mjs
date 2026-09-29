/**
 * 測試憑證解析(runner 端,跑在 Fargate 容器內)。
 *
 * 設計原則(安全優先):**明文只在「輸入到裝置的那一刻」出現**。
 *   - engine 只把「可用 key 名清單」注入 AI context(值不進 prompt)。
 *   - AI 在 type 動作的 text 用 ${key}(或 secretRef:<全名>)代入。
 *   - runner 在 client.act 前、且僅當 action==='type' 時,才把 text 的 ${key} 換成真值送裝置。
 *   - 寫進 steps/traces 的仍是「原佔位符版」——明文不落 S3、不進報告、不進 log。
 *
 * 憑證來源:每個 App 一個 Secrets Manager secret(playagent/tenant/<t>/app/<appId>/credentials,
 * 值為 JSON {key:value})。另相容舊式 ${NAME}→playagent/tenant/<t>/NAME 的獨立機密。
 *
 * 租戶隔離:只讀本租戶前綴下的機密;App 憑證 secret 名綁 tenant+appId。
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const REGION = process.env.PA_DATA_REGION || process.env.AWS_REGION || 'us-east-2';
const TENANT = process.env.PA_TENANT || '';
const APP_ID = process.env.PA_APP || '';

function tenantSecretPrefix(tenantId) {
  return `playagent/tenant/${tenantId}/`;
}
function appCredentialsSecretName(tenantId, appId) {
  return `playagent/tenant/${tenantId}/app/${appId}/credentials`;
}

let _client = null;
function client() {
  if (!_client) _client = new SecretsManagerClient({ region: REGION });
  return _client;
}

/**
 * 載入本 App 的憑證表(key→value)到記憶體。取不到回空物件。
 * 只在 runner 啟動時呼叫一次;值只在容器記憶體,不寫回任何地方。
 */
export async function loadAppCredentials() {
  if (!TENANT || !APP_ID) return {};
  try {
    const res = await client().send(
      new GetSecretValueCommand({ SecretId: appCredentialsSecretName(TENANT, APP_ID) }),
    );
    if (typeof res.SecretString !== 'string' || res.SecretString === '') return {};
    const parsed = JSON.parse(res.SecretString);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out = {};
      for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
      return out;
    }
    return {};
  } catch (err) {
    console.warn(`[secrets] 載入 App 憑證失敗(略過):${err?.name || err}`);
    return {};
  }
}

/**
 * 把單一文字(通常是 type 動作的 cmd.text)裡的 ${key} 與 secretRef:<全名> 替換成真值。
 * 來源:
 *   1. App 憑證表 creds(key→value):${key} 直接用 creds[key]。
 *   2. 舊式獨立機密:secretRef:playagent/tenant/<t>/NAME(僅本租戶前綴)→ 動態 GetSecretValue。
 * 缺值則保留原佔位符(不塞空字串),並回報 missing 供呼叫端記 log。
 * 回 { text, resolved, missing }。
 */
export async function substituteText(text, creds, getStandalone = getSecretValueSafe) {
  if (!text || typeof text !== 'string') return { text, resolved: 0, missing: [] };
  const prefix = tenantSecretPrefix(TENANT);
  let out = text;
  let resolved = 0;
  const missing = [];

  // 1) ${key}:優先用 App 憑證表。key 允許任意非 } 字元(支援中文鍵名如 ${帳號})。
  for (const m of text.matchAll(/\$\{([^}]+)\}/g)) {
    const placeholder = m[0];
    const key = m[1];
    if (creds && Object.prototype.hasOwnProperty.call(creds, key)) {
      out = out.split(placeholder).join(creds[key]);
      resolved += 1;
    } else {
      // App 憑證表沒有 → 試舊式獨立機密 playagent/tenant/<t>/<key>。
      const full = `${prefix}${key}`;
      const v = await getStandalone(full);
      if (v !== null && v !== undefined) { out = out.split(placeholder).join(v); resolved += 1; }
      else missing.push(placeholder);
    }
  }

  // 2) secretRef:<全名>(限本租戶前綴):App 憑證表用短 key,這裡支援明確引用獨立機密。
  for (const m of text.matchAll(/secretRef:([A-Za-z0-9/_.-]+)/g)) {
    const placeholder = m[0];
    const full = m[1];
    if (!full.startsWith(prefix)) { missing.push(placeholder); continue; }
    const v = await getStandalone(full);
    if (v !== null && v !== undefined) { out = out.split(placeholder).join(v); resolved += 1; }
    else missing.push(placeholder);
  }

  if (missing.length > 0) console.warn(`[secrets] 未解析的憑證佔位(保留原樣):${missing.join(', ')}`);
  if (resolved > 0) console.log(`[secrets] 已在輸入時替換 ${resolved} 個憑證佔位符`);
  return { text: out, resolved, missing };
}

async function getSecretValueSafe(name) {
  try {
    const res = await client().send(new GetSecretValueCommand({ SecretId: name }));
    return typeof res.SecretString === 'string' ? res.SecretString : null;
  } catch (err) {
    console.warn(`[secrets] 讀取失敗 ${name}: ${err?.name || err}`);
    return null;
  }
}
