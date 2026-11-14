export type CheckLocale = 'zh-Hant' | 'en' | 'zh-Hans' | 'ja' | 'ko';

export interface Violation {
  char: string;
  kind: 'han' | 'kana' | 'hangul' | 'traditional-only' | 'simplified-only';
}

export interface CheckResult {
  ok: boolean;
  violations: Violation[];
}

export interface CollectedText {
  texts: string[];
  maskedChars: number;
}

export const LOCALES: readonly CheckLocale[];
export const TRADITIONAL_ONLY: string;
export const SIMPLIFIED_ONLY: string;
export const DATA_REGIONS: readonly string[];
export function checkText(locale: string, text: string): CheckResult;
export function collectDomText(regions: readonly string[]): CollectedText;
export function checkCollected(locale: string, collected: CollectedText): CheckResult & { maskedChars: number };
export function selftest(): { plantedViolations: string };
export const GENERATED_REGIONS: readonly { sel: string; why: string }[];
export const JA_NEVER: string;
export interface DomItem {
  kind: 'text' | 'attr';
  attr?: string;
  node: number;
  text: string;
  origin: string;
  visible: boolean;
  data: boolean;
  gen: number;
}
export interface MaskRequest {
  node: number;
  start: number;
  end: number;
  text: string;
  gen: number;
  origin: string;
}
export interface MaskPlan {
  preMaskViolations: number;
  residual: DomItem[];
  masks: MaskRequest[];
  hidden: DomItem[];
  dataChars: number;
}
export function collectDomItems(regions: { data: readonly string[]; generated: readonly string[] }): DomItem[];
export function planMasks(locale: string, items: readonly DomItem[]): MaskPlan;
export function paintMasks(requests: readonly MaskRequest[]): { boxes: number[][]; misaligned: boolean }[];
export function clearMasks(): void;
