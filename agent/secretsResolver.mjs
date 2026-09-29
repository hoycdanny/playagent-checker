/**
 * 測試憑證解析(runner 端,跑在 Fargate 容器內)。
 *
 * 用途:把任務目標(PA_TASK)裡的憑證佔位符換成真實值,讓 AI 能在註冊/登入表單填入測試帳密。
 * 支援兩種語法:
 *   1. ${NAME}                                 —— 簡易佔位(對應機密短鍵 NAME)
 *   2. secretRef:playagent/tenant/<tenant>/NAME —— 完整引用(對應機密全名)
 *
 * 安全:
 *   - 值只從 AWS Secrets Manager 讀(task role 有 GetSecretValue,scope 到 playagent/tenant/*)。
 *   - 只讀「本租戶前綴」下的機密;佔位符解析出的全名一律強制以 tenantSecretPrefix(TENANT) 開頭,
 *     避免任務文字誘導 runner 去讀別租戶的機密。
 *   - 明文只在容器記憶體存活,替換進 PA_TASK 後即用;不寫回 S3、不寫進 report/status。
 *   - 缺值或讀取失敗:保留原佔位符(不塞空字串誤導 AI)並在 console 警告,不中斷任務。
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const REGION = process.env.PA_DATA_REGION || process.env.AWS_REGION || 'us-east-2';
const TENANT = process.env.PA_TENANT || '';

function tenantSecretPrefix(tenantId) {
  return `playagent/tenant/${tenantId}/`;
}

let _client = null;
function client() {
  if (!_client) _client = new SecretsManagerClient({ region: REGION });
  return _client;
}

/**
 * 從任務文字掃出所有憑證引用,回傳「佔位字串 → 機密全名」的對照。
 * 只收落在本租戶前綴內的引用(${NAME} 一律組成 prefix+NAME;secretRef: 必須已在前綴內)。
 */
export function extractRefs(task, tenantId) {
  const prefix = tenantSecretPrefix(tenantId);
  const map = new Map(); // placeholder(原字串) → fullName
  // 1) ${NAME}:NAME 僅允許英數與 _ . -(與 API 短鍵規則一致)。
  for (const m of String(task).matchAll(/\$\{([A-Za-z0-9_.-]+)\}/g)) {
    map.set(m[0], `${prefix}${m[1]}`);
  }
  // 2) secretRef:<fullName>:fullName 必須落本租戶前綴,否則略過(不跨租戶)。
  for (const m of String(task).matchAll(/secretRef:([A-Za-z0-9/_.-]+)/g)) {
    const full = m[1];
    if (full.startsWith(prefix)) map.set(m[0], full);
  }
  return map;
}

/**
 * 解析並替換 task 內的憑證佔位符。回 { text, resolved, missing }。
 * text = 替換後字串;resolved = 成功替換數;missing = 找不到值的佔位符清單。
 */
export async function resolveTaskSecrets(task) {
  if (!task || !TENANT) return { text: task, resolved: 0, missing: [] };
  const refs = extractRefs(task, TENANT);
  if (refs.size === 0) return { text: task, resolved: 0, missing: [] };

  // 依「機密全名」去重讀取(多個佔位符可能指同一機密)。
  const uniqueNames = [...new Set(refs.values())];
  const values = new Map(); // fullName → value
  await Promise.all(
    uniqueNames.map(async (name) => {
      try {
        const res = await client().send(new GetSecretValueCommand({ SecretId: name }));
        if (typeof res.SecretString === 'string') values.set(name, res.SecretString);
      } catch (err) {
        // 找不到/無權限:留缺,下方保留原佔位符並警告。
        console.warn(`[secrets] 讀取失敗 ${name}: ${err?.name || err}`);
      }
    }),
  );

  let text = task;
  let resolved = 0;
  const missing = [];
  for (const [placeholder, fullName] of refs) {
    if (values.has(fullName)) {
      text = text.split(placeholder).join(values.get(fullName));
      resolved += 1;
    } else {
      missing.push(placeholder);
    }
  }
  if (missing.length > 0) {
    console.warn(`[secrets] 未解析的憑證佔位(保留原樣):${missing.join(', ')}`);
  }
  if (resolved > 0) console.log(`[secrets] 已替換 ${resolved} 個憑證佔位符`);
  return { text, resolved, missing };
}
