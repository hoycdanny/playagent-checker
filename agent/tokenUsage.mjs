/**
 * Token 用量記帳(runner 與 agentTeam 共用)。
 *
 * 為什麼要記快取 token:Bedrock 對 Kimi K3 等模型會自動做 prompt 快取,Converse 回的
 * usage.inputTokens 只剩「沒有命中快取、也沒有寫進快取」的極少數 token(實測 2,900 token 的請求
 * inputTokens 只有 7),其餘分在 cacheWriteInputTokens(1.25× input 單價)與 cacheReadInputTokens
 * (0.1× input 單價)。只記 inputTokens 會讓估算費用低到只剩帳單的一小部分。
 *
 * 為什麼要依模型記:解析失敗時 runner 會改用備援模型重問(例如 Kimi → Claude),
 * 那些 token 必須用備援模型的單價算,不能算在 seat 的主模型頭上。
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Bedrock Converse 的 usage → { input, output, cacheRead, cacheWrite }。沒有 usage 回 null。 */
export function usageFromConverse(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    input: num(u.inputTokens),
    output: num(u.outputTokens),
    cacheRead: num(u.cacheReadInputTokens),
    cacheWrite: num(u.cacheWriteInputTokens),
  };
}

/** Anthropic InvokeModel 回應的 usage → 同上格式。 */
export function usageFromAnthropic(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

/** 兩筆用量相加(任一為 null 視為 0);回新物件。 */
export function addUsage(a, b) {
  return {
    input: num(a?.input) + num(b?.input),
    output: num(a?.output) + num(b?.output),
    cacheRead: num(a?.cacheRead) + num(b?.cacheRead),
    cacheWrite: num(a?.cacheWrite) + num(b?.cacheWrite),
  };
}

/** 就地累加到 acc(acc 可只有 input/output 欄位)。 */
export function accumulate(acc, u) {
  if (!u) return acc;
  acc.input = num(acc.input) + num(u.input);
  acc.output = num(acc.output) + num(u.output);
  acc.cacheRead = num(acc.cacheRead) + num(u.cacheRead);
  acc.cacheWrite = num(acc.cacheWrite) + num(u.cacheWrite);
  return acc;
}

/** 合併兩份 { modelId: usage }(同一模型相加)。 */
export function mergeByModel(a, b) {
  const out = {};
  for (const src of [a, b]) {
    for (const [k, v] of Object.entries(src ?? {})) out[k] = addUsage(out[k], v);
  }
  return out;
}

/** 依模型記帳:add(modelId, usage);byModel() 回 { modelId: usage }(報告 tokensByModel)。 */
export function createUsageLedger() {
  const map = new Map();
  return {
    add(modelId, usage) {
      if (!modelId || !usage) return;
      accumulate(map.get(modelId) ?? map.set(modelId, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }).get(modelId), usage);
    },
    byModel() {
      return Object.fromEntries([...map.entries()].map(([k, v]) => [k, { ...v }]));
    },
  };
}
