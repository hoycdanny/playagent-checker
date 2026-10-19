/** 型別宣告:agent/reflex.mjs(infra 測試會引用)。 */
import type { GraphOp, GraphStructure } from './memoryGraph.mjs';
import type { EditsLike } from './operatorMemory.mjs';

export declare const REFLEX_MIN_HITS: number;
export declare const REFLEX_MIN_HITS_POPUP: number;
export declare const REFLEX_MIN_HITS_SPIN: number;
export declare const REFLEX_MAX_CHAIN: number;
export declare const SPIN_HIT_RATIO: number;
export declare const SPIN_COOLDOWN_STEPS: number;
export interface ReflexState {
  demoted: Set<string>;
  /** SPIN 操作的冷卻:key → 可以重新啟用的步數。 */
  spinCooldown: Map<string, number>;
  recent: string[];
  chain: number;
  crossVersionFailed: boolean;
}
/** 這個操作是不是「轉一局付費 SPIN」(AutoSpin / 免費遊戲不算)。 */
export declare function isPaidSpinTarget(kind: string | undefined, target: string | undefined): boolean;
/** 這個 SPIN 操作的成功紀錄夠不夠好(成功率門檻,不要求零失敗)。 */
export declare function spinOpReliable(e?: { hitCount?: number; missCount?: number }): boolean;
/** 暫時擋下這個 SPIN 操作(不是永久停用);回可以重新啟用的步數。 */
export declare function coolSpinOp(state: ReflexState | null | undefined, key: string, step: number, steps?: number): number;
/** 這個 SPIN 操作還在冷卻中嗎。 */
export declare function spinCooledDown(state: ReflexState | null | undefined, key: string, step: number): boolean;
export declare function createReflexState(): ReflexState;
export declare function opFromCmd(cmd: Record<string, unknown> | null | undefined, cw: number, ch: number, o?: { version?: string; at?: string }): GraphOp | null;
export declare function cmdFromOp(op: unknown, cw: number, ch: number): Record<string, unknown> | null;
export declare function selfOpKey(pageId: string, s: { kind?: string; target?: string }): string;
export declare function opTrust(
  e: { hitCount?: number; missCount?: number; manual?: boolean },
  edit?: { op?: unknown; verified?: boolean; disabled?: boolean } | null,
): 'disabled' | 'verified' | 'auto' | 'learning';
export declare function effectiveOp(recorded: unknown, edit?: { op?: unknown } | null): GraphOp | null;
export declare function parseSpinCount(task: string | undefined): number;
export interface ReflexDecision {
  key: string;
  op: GraphOp;
  toPageId: string;
  target: string;
  trust: string;
  reason: 'route' | 'named' | 'popup' | 'verified' | 'dominant';
  cross: boolean;
  hits: number;
  misses: number;
}
export declare function chooseReflex(c: {
  struct: GraphStructure;
  edits: (EditsLike & { opEdits?: Record<string, unknown> }) | null;
  pageId: string;
  task?: string;
  focus?: string;
  version?: string;
  state: ReflexState;
}): ReflexDecision | null;
export declare function pageSelfOps(
  page: { selfOps?: Array<{ kind: string; target: string; hitCount: number; missCount: number; op?: unknown }> } | null | undefined,
  pageId: string,
  opEdits?: Record<string, { op?: unknown; verified?: boolean; disabled?: boolean } | undefined>,
): Array<{ kind: string; target: string; hitCount: number; missCount: number; op?: unknown; manual?: boolean }>;
export declare function chooseSpinOp(c: {
  struct: GraphStructure;
  edits: (EditsLike & { opEdits?: Record<string, unknown> }) | null;
  pageId: string;
  version?: string;
  state: ReflexState;
  /** 目前步數(用來判斷冷卻是否已過期)。 */
  step?: number;
}): { key: string; op: GraphOp; target: string; trust: string } | null;
export declare function rtpSummary(
  rounds: Array<{ bet?: number; win?: number }>,
  o?: { startBalance?: number; endBalance?: number },
): {
  rounds: number;
  totalBet: number;
  totalWin: number;
  rtpPercent: number;
  hitRatePercent: number;
  ci95: [number, number];
  balanceCheck?: { startBalance: number; endBalance: number; rtpPercent: number };
} | null;
