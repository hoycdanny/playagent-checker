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
  // 分析畫面(判座標):依離線定位基準實測(像素誤差,越小越準)排名。
  // Kimi K3 25px → Opus5.5 26px → Sonnet5 28px(性價比最佳/真機唯一玩進戰鬥)→ Opus5 32px → Opus4.8 34px。
  vlm: [
    'us.moonshotai.kimi-k3',
    'us.anthropic.claude-opus-5-5',
    'us.anthropic.claude-sonnet-5',
    'us.anthropic.claude-opus-5',
    'us.anthropic.claude-opus-4-8',
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

/** 推薦名次(1-based);非前 5 名回 0。 */
export function recommendRank(seat: SeatKind, modelId: string): number {
  const i = RECOMMENDED[seat].indexOf(modelId);
  return i < 0 ? 0 : i + 1;
}

/** 該 seat 的預設模型 id:第 1 名(清單有才用),否則清單第一個。 */
export function recommendedDefault(seat: SeatKind, items: { modelId: string }[]): string {
  for (const id of RECOMMENDED[seat]) {
    if (items.some((m) => m.modelId === id)) return id;
  }
  return items[0]?.modelId ?? '';
}

/** 依推薦名次排序:前 5 名(依 1→5)置頂,其餘維持原順序在後。 */
export function sortByRecommend<T extends { modelId: string }>(seat: SeatKind, items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ra = recommendRank(seat, a.modelId);
    const rb = recommendRank(seat, b.modelId);
    if (ra && rb) return ra - rb; // 兩者皆推薦:依名次
    if (ra) return -1; // a 推薦、b 不推薦:a 在前
    if (rb) return 1;
    return 0; // 皆非推薦:維持原序(sort 穩定)
  });
}

/** 選項顯示文字:推薦(前 5 名)前面加 ★。label 由呼叫端算好(含價格等)。 */
export function starLabel(seat: SeatKind, modelId: string, label: string): string {
  return recommendRank(seat, modelId) > 0 ? `★ ${label}` : label;
}
