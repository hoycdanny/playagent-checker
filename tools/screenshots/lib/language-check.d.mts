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
