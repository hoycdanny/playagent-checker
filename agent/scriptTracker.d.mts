/** 型別宣告:agent/scriptTracker.mjs(infra 測試會引用)。 */
export declare const DEFAULT_ITEM_BUDGET: number;
export declare function itemBudgetFor(text: string, budget?: number): number;
export interface ScriptEvent {
  complete: boolean;
  confirm: boolean;
  advanced: boolean;
  retracted: boolean;
}
export interface ScriptBlocked {
  item: number;
  text: string;
  steps: number;
  budget: number;
}
export interface ScriptTracker {
  readonly total: number;
  readonly done: number;
  readonly current: number;
  readonly pendingFinal: boolean;
  readonly itemSteps: number;
  readonly evidence: string;
  items(): string[];
  observe(raw: unknown, evidence?: string): ScriptEvent;
  tick(): ScriptBlocked | null;
  promptSection(): string;
  turnNote(): string;
}
export declare function createScriptTracker(o: { items: string[]; itemBudget?: number }): ScriptTracker;
