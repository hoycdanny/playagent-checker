/** 型別宣告:agent/netemShaper.mjs。 */

import type { NetworkCondition, UnsupportedItem } from './networkConditions.mjs';

/** 注入的命令執行器;回傳碼與輸出都要拿得到(失敗必須能寫進報告)。 */
export type ShaperRun = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * netem 施加計畫。
 *
 * 分兩側是因為方向不同:容器 eth0 的 root qdisc 只管出向(上行、延遲、丟包),
 * 下行要套在主機側的 veth 對端。
 */
export interface NetemPlan {
  /** 容器 netns 內 `tc qdisc add dev eth0 root netem` 之後的參數;無則 null。 */
  containerEgress: string[] | null;
  /** 主機側 veth 的 netem 參數(下行限速);無則 null。 */
  hostEgress: string[] | null;
  /**
   * 實際生效的條件。刻意只放條件維度(數字與布林)——
   * 這個物件會原樣進報告的 `applied`,而報告據它主張「這些條件下驗過」。
   * 介面名之類的診斷資訊不屬於主張,放在 NetemResult 的別的欄位。
   */
  applied: NetworkCondition;
  unsupported: UnsupportedItem[];
}

/** 施加結果;ok=false 時報告不得主張該條件已驗。 */
export interface NetemResult {
  applied: NetworkCondition;
  unsupported: UnsupportedItem[];
  ok: boolean;
  error?: string;
  /** 施加後在容器 netns 內量到的 RTT(ms);有值代表延遲有獨立佐證。 */
  measuredRttMs?: number;
  /** 施加前的 RTT(ms),供對照。 */
  baselineRttMs?: number;
  /** 下行限速實際套在哪個主機側 veth(診斷用,不是主張的一部分)。 */
  hostIface?: string;
  /** 量測是否確認延遲真的生效;有量測但量值不符時為 false。 */
  verified?: boolean;
}

/** 條件 → tc 參數與做不到的項目(純函式,不碰系統)。 */
export function netemPlan(cond: NetworkCondition): NetemPlan;

/**
 * 組出某個介面的完整 tc 命令序列(純函式)。
 *
 * root 用 prio,priomap 全導向掛了 netem 的 band;`exemptPort` 的流量用 u32 filter
 * 導到不受限的 band —— adb 控制通道必須走這條,否則 offline 會切斷連線、
 * 限速會讓截圖逾時,而兩者看起來都像「遊戲在弱網下壞掉」。
 */
export function shapingCommands(dev: string, netemArgs: string[], exemptPort?: number): string[][];

/** 把塑形套進容器的網路命名空間;主機自身流量不受影響。 */
export function applyNetem(opts: {
  container?: string;
  cond: NetworkCondition;
  run: ShaperRun;
  measure?: boolean;
  /** 不受塑形的埠(預設 adb 的 5555)。 */
  exemptPort?: number;
}): Promise<NetemResult>;

/**
 * 量到的 RTT 是否足以確認延遲生效。
 * 沒要求延遲、量不到 RTT、或量值遠低於要求值都回 false ——「沒有佐證」不等於「驗過」。
 */
export function confirmsLatency(args: {
  baselineRttMs?: number;
  measuredRttMs?: number;
  latencyMs?: number;
}): boolean;

/** 解除塑形;清不掉不算錯誤(主機隨任務結束自我終結)。 */
export function clearNetem(opts: { container?: string; run: ShaperRun }): Promise<{ ok: boolean }>;
