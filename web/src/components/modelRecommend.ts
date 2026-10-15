/**
 * 各 Seat(agent=控制遊戲、vlm=分析畫面、subagent=子代理)的推薦模型排名(1→5)。
 * 用途:
 *  - 下拉預設值 = 各 seat 的第 1 名(清單含該 id 才用,否則退回清單第一個)。
 *  - 下拉選項:前 5 名前面加 ★ 標示為推薦,並排到清單最前面(依名次)。
 *
 * id 為「後端 /models API 回傳的最終 id」(已套 us. 前綴的形式):
 *  - anthropic / amazon 需前綴(us.);qwen / moonshotai / zai / nvidia 不加前綴。
 *  - uitars 為自建 SageMaker 模型,id 無前綴。
 * 名次依產品當前建議(可隨評測調整);清單若無某 id,顯示時自動略過該名次。
 */
export type SeatKind = 'agent' | 'vlm' | 'subagent';

export const RECOMMENDED: Record<SeatKind, string[]> = {
  // 控制遊戲(決策):以判斷力/代次為序(無實測,依模型能力合理排)。
  // Opus5.5(最強)→ Sonnet5(性價比)→ Fable5.1 → Kimi K3 → DeepSeek V3.2(非 Claude 首選)。
  agent: [
    'us.anthropic.claude-opus-5-5',
    'us.anthropic.claude-sonnet-5',
    'us.anthropic.claude-fable-5-1',
    'us.moonshotai.kimi-k3',
    'deepseek.v3.2',
  ],
  // 分析畫面(讀數值 + 點位):2026-10-12 拉霸判讀實測(16 張真實截圖 × 2 輪,數值判讀 / 點位命中 / 每張中位秒數 / 每千張費用):
  // Sonnet 4.6 100% 10/10 3.9s $6.96 → Sonnet 5 100% 8/10 6.0s $7.46 → Kimi K3 97% 10/10 8.7s $9.32
  // → Haiku 4.5 97% 8/10 3.2s $2.37。Nova Lite / Nova Pro / Gemma 讀不到 AutoSpin 剩餘局數、點位全錯,不推薦。
  vlm: [
    'us.anthropic.claude-sonnet-4-6',
    'us.anthropic.claude-sonnet-5',
    'us.moonshotai.kimi-k3',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  ],
  // 子代理(輔助小任務):性價比優先(無實測,依成本/能力合理排)。
  // Nova Micro(最省)→ Haiku 4.5(便宜且會看圖)→ Nova Lite → GLM 4.7 Flash → Ministral 3B。
  subagent: [
    'us.amazon.nova-micro-v1:0',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'us.amazon.nova-lite-v1:0',
    'zai.glm-4.7-flash',
    'mistral.ministral-3-3b-instruct',
  ],
};

/**
 * 各 seat 的預設選擇(建立測試時下拉的初始值)。與推薦排名(★)分開:
 * 預設採團隊指定的組合,★ 仍反映能力排名。清單沒有該 id 時退回推薦第 1 名。
 */
export const DEFAULT_MODELS: Record<SeatKind, string> = {
  agent: 'us.amazon.nova-lite-v1:0', // 控制遊戲:Amazon Nova Lite
  vlm: 'us.moonshotai.kimi-k3', // 分析畫面:Moonshot Kimi K3
  subagent: 'us.amazon.nova-micro-v1:0', // 子代理:Amazon Nova Micro
};

/** 推薦名次(1-based);非前 5 名回 0。 */
export function recommendRank(seat: SeatKind, modelId: string): number {
  const i = RECOMMENDED[seat].indexOf(modelId);
  return i < 0 ? 0 : i + 1;
}

/**
 * 推薦以「模型管理頁的金勾勾」為準:後端 /models 對被管理員標推薦的項目帶 recommended:true。
 * (上面的 RECOMMENDED 名次表不再用來加 ★,只保留給預設值的退路。)
 */
type Rec = { modelId: string; recommended?: boolean };

/** 該 seat 的預設模型 id:管理員推薦的第一個 → DEFAULT_MODELS(清單有才用)→ 名次表 → 清單第一個。 */
export function recommendedDefault(seat: SeatKind, items: Rec[]): string {
  const rec = items.find((m) => m.recommended);
  if (rec) return rec.modelId;
  if (items.some((m) => m.modelId === DEFAULT_MODELS[seat])) return DEFAULT_MODELS[seat];
  for (const id of RECOMMENDED[seat]) {
    if (items.some((m) => m.modelId === id)) return id;
  }
  return items[0]?.modelId ?? '';
}

/** 管理員推薦(金勾勾)的置頂,其餘維持原順序(sort 穩定)。seat 參數保留以相容既有呼叫。 */
export function sortByRecommend<T extends Rec>(_seat: SeatKind, items: T[]): T[] {
  return [...items].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));
}

/** 選項顯示文字:管理員推薦的前面加「★ 推薦」。label 由呼叫端算好(含價格等)。 */
export function starLabel(_seat: SeatKind, m: Rec, label: string): string {
  return m.recommended ? `★ ${label}` : label;
}

/** 推薦選項的樣式(金色粗體;下拉清單內也看得出來)。 */
export function recommendStyle(m: Rec): { color: string; fontWeight: number } | undefined {
  return m.recommended ? { color: '#b45309', fontWeight: 700 } : undefined;
}
