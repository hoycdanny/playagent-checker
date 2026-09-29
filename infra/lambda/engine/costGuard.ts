import {
  resolvePrice,
  computeSpend,
  budgetExceeded,
  isPriceable,
  PricingError,
} from '../api/pricing.js';
import { CATALOG, channelFromModelId, type Seat } from '../api/modelCatalog.js';

/**
 * 成本護欄(Req 7)—— 把單價表、Budget 閘口、執行配置快照整合為引擎可直接用的一組原語。
 *
 * 設計要點:
 * - Fail Closed(Req 7.3):執行前解析每個生效 Seat 的模型單價,任一查不到價即拋錯,
 *   引擎不得以 $0 起跑。
 * - 執行配置快照(Req 7.5):把「本次執行實際生效的各 Seat 模型 + 其解析出的 channel/單價」
 *   固化為一份可寫入 report/job 的快照,供事後審計「當時用了什麼、怎麼算錢」。
 * - Budget 閘口(Req 7.1/7.2):在引擎主迴圈每次迭代頂部呼叫 shouldStop,達閾值即停;
 *   Billable Spend 只累加 token 計價的單調增長項(computeSpend 保證非負)。
 */

/** 各 Seat 選定的模型(來自任務/租戶設定;未指定則用預設)。 */
export interface SeatSelection {
  agent: string;
  vlm: string;
  subagent: string;
}

/** 單一 Seat 的執行配置快照條目。 */
export interface SeatSnapshot {
  seat: Seat;
  modelId: string;
  channel: string;
  inputPerM: number;
  outputPerM: number;
  estimated: boolean;
}

export interface ExecutionConfigSnapshot {
  /** 預算上限(美元);null 代表「無上限」(不設 Budget 閘口)。 */
  budgetUsd: number | null;
  seats: SeatSnapshot[];
  /** 快照產生時間(審計用)。 */
  resolvedAt: string;
}

/** 預設 Seat 選型:皆取 CATALOG 中可坐該 Seat 的第一個(保證可定價)。 */
/**
 * 預設 Seat 選型(2026 最佳實踐,A 組:跨供應商帳面最強)。
 * - vlm(分析畫面):Qwen3-VL 235B —— 2026 GUI grounding 的 SOTA 基準。
 *   註:其座標系在 catalog 標 norm1000(千分制,尚未逐一實測);若實測為像素需回頭修正,
 *   否則點位換算可能偏移。
 * - agent(控制遊戲):MiniMax M2.1 —— 2026 開源 agentic 頂尖、成本低。
 * - subagent(子代理):DeepSeek V3.2 —— 推理強且便宜,適合輔助子任務。
 * 每個偏好都做「在 catalog 且可坐該 seat 且可定價」的防護;不符則退回該 seat 第一個可用模型,
 * 確保啟動與執行永不因偏好失效而 Fail Closed 掛掉。
 */
const PREFERRED_DEFAULTS: Record<Seat, string> = {
  // 性價比最佳組(2026,以「能力 vs 混合單價」評選):
  // - vlm(分析畫面/定位):UI-TARS-1.5-7B —— 專為 GUI grounding 微調,座標準度遠勝通用 VLM
  //   (實測通用 Qwen3-VL 在遊戲畫面誤差可達數百像素,會點空/點錯;UI-TARS 精準命中目標)。
  //   Device Farm runner 於 endpoint 存在時走 SageMaker UI-TARS;endpoint 缺席或 web runner(無 UI-TARS
  //   路徑)則由 runner 安全回退到通用 Bedrock VLM(Qwen3-VL 235B),故此預設在各後端皆可執行。
  // - agent(控制遊戲):MiniMax M2.1 —— 2026 開源 agentic 頂尖,決策/工具呼叫強,單價低。
  // - subagent(子代理):Nova Micro —— 子任務不需重推理,取最省(混合單價 ~$0.06,較 V3.2 省逾 9 成)。
  // id 為可直接呼叫的最終形式:UI-TARS 走 SageMaker(id 'uitars'),MiniMax 走原始 id,Amazon 走 us. 前綴。
  vlm: 'uitars',
  agent: 'minimax.minimax-m2.1',
  subagent: 'us.amazon.nova-micro-v1:0',
};

export function defaultSeatSelection(): SeatSelection {
  const pick = (seat: Seat): string => {
    const preferred = PREFERRED_DEFAULTS[seat];
    // 偏好模型須:存在於 catalog、可坐此 seat、且可定價。任一不符則退回第一個可用。
    const preferredEntry = CATALOG.find(
      (e) => e.modelId === preferred && e.seats.includes(seat),
    );
    if (preferredEntry && isPriceable(preferredEntry.modelId)) {
      return preferredEntry.modelId;
    }
    const fallback = CATALOG.find((e) => e.seats.includes(seat) && isPriceable(e.modelId));
    if (!fallback) throw new PricingError(`Catalog 無可坐 ${seat} 且可定價的模型`);
    return fallback.modelId;
  };
  return { agent: pick('agent'), vlm: pick('vlm'), subagent: pick('subagent') };
}

/**
 * 產生執行配置快照(Fail Closed)。
 * 對每個 Seat 的生效模型解析單價,任一不可定價即拋 PricingError —— 引擎據此在花費前拒絕。
 */
export function resolveExecutionConfig(
  selection: SeatSelection,
  budgetUsd: number | null,
  now = new Date(),
): ExecutionConfigSnapshot {
  const seatModel: Array<[Seat, string]> = [
    ['agent', selection.agent],
    ['vlm', selection.vlm],
    ['subagent', selection.subagent],
  ];
  const seats: SeatSnapshot[] = seatModel.map(([seat, modelId]) => {
    // resolvePrice 對查不到價的模型會拋 PricingError（Fail Closed）。
    const price = resolvePrice(modelId, now);
    return {
      seat,
      modelId,
      channel: channelFromModelId(modelId),
      inputPerM: price.inputPerM,
      outputPerM: price.outputPerM,
      estimated: Boolean(price.estimated),
    };
  });
  return { budgetUsd, seats, resolvedAt: now.toISOString() };
}

/**
 * Billable Spend 累加器 —— 只計 token 計價、單調增長。
 * 每次模型呼叫後 add(seatModelId, inputTokens, outputTokens),spentUsd 只增不減。
 */
export class SpendAccumulator {
  private _spentUsd = 0;

  /** budgetUsd 為 null 代表無上限(shouldStop 恆為 false)。 */
  constructor(private readonly budgetUsd: number | null) {}

  get spentUsd(): number {
    return this._spentUsd;
  }

  /** 累加一次模型呼叫花費(Fail Closed:查不到價會拋錯)。 */
  add(modelId: string, inputTokens: number, outputTokens: number, now = new Date()): number {
    const delta = computeSpend(modelId, inputTokens, outputTokens, now);
    // computeSpend 對非負 token 恆回非負;防禦性夾住負值以確保單調。
    this._spentUsd += Math.max(0, delta);
    return this._spentUsd;
  }

  /** 迭代頂部判定:是否已達 Budget 閾值而應停止(Req 7.1/7.2)。無上限(null)恆不停。 */
  shouldStop(): boolean {
    if (this.budgetUsd == null) return false;
    return budgetExceeded({ budgetUsd: this.budgetUsd, spentUsd: this._spentUsd });
  }
}

export { PricingError };
