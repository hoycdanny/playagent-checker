/**
 * 執行期動態資源(EC2 emulator 主機、Fargate runner task)的成本分攤標籤。
 *
 * CDK 建立的資源由 Tags.of(stack) 自動貼標,但引擎在執行期用 RunInstances / RunTask
 * 動態起的 EC2 / Fargate 不在 CDK 圖內,不會自動帶標籤。為讓 Cost Explorer 能把這些
 * 「跑任務時才出現」的最大宗成本也歸屬到同一組標籤,CDK 會把成本標籤序列化成 JSON
 * 放進引擎 Lambda 的環境變數 COST_TAGS,執行期在此讀出並套用到動態資源。
 *
 * 內容 = project / stage / component 保留標籤 + 部署者帶入的 costCenter/owner/... 。
 */

/** 由環境變數 COST_TAGS(JSON 物件字串)解析成 key→value。解析失敗回空物件(不阻斷任務)。 */
export function parseCostTags(raw = process.env.COST_TAGS): Record<string, string> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** EC2 TagSpecifications 用的 [{Key,Value}] 形狀。 */
export function costTagsAsEc2(raw = process.env.COST_TAGS): { Key: string; Value: string }[] {
  return Object.entries(parseCostTags(raw)).map(([Key, Value]) => ({ Key, Value }));
}

/** ECS RunTask tags 用的 [{key,value}] 形狀(注意:小寫 key/value)。 */
export function costTagsAsEcs(raw = process.env.COST_TAGS): { key: string; value: string }[] {
  return Object.entries(parseCostTags(raw)).map(([key, value]) => ({ key, value }));
}
