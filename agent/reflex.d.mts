/** 型別宣告:agent/reflex.mjs(infra 測試會引用)。 */
import type { GraphOp, GraphStructure } from './memoryGraph.mjs';
import type { EditsLike } from './operatorMemory.mjs';

export declare const REFLEX_MIN_HITS: number;
export declare const REFLEX_MAX_CHAIN: number;
export interface ReflexState {
  demoted: Set<string>;
  recent: string[];
  chain: number;
  crossVersionFailed: boolean;
}
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
export declare function chooseSpinOp(c: {
  struct: GraphStructure;
  edits: (EditsLike & { opEdits?: Record<string, unknown> }) | null;
  pageId: string;
  version?: string;
  state: ReflexState;
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
