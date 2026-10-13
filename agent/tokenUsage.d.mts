/** 型別宣告:agent/tokenUsage.mjs(infra 測試會引用)。 */
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
export function usageFromConverse(u: unknown): Usage | null;
export function usageFromAnthropic(u: unknown): Usage | null;
export function addUsage(a: Partial<Usage> | null | undefined, b: Partial<Usage> | null | undefined): Usage;
export function accumulate<T extends Partial<Usage>>(acc: T, u: Partial<Usage> | null | undefined): T & Usage;
export function mergeByModel(a: Record<string, Partial<Usage>> | null | undefined, b: Record<string, Partial<Usage>> | null | undefined): Record<string, Usage>;
export function createUsageLedger(): {
  add(modelId: string, usage: Partial<Usage> | null | undefined): void;
  byModel(): Record<string, Usage>;
};
