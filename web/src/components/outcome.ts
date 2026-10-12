import type { MessageKey } from '../i18n/messages.ts';

/**
 * 任務結果(與報告封面同一個結論)。
 * - verdict:驗收標準判定的測試結論(後端報告引擎算出,存在 verdict.json)。
 * - state:執行結果(AI 有沒有走完流程、有沒有錯誤 / 取消);沒有結論時才拿來顯示。
 * 所有「通過 / 失敗 / 通過率」都用 outcomeOf,列表、任務詳情、報告不會再各說各話。
 */
export type Verdict = 'PASS' | 'PASS_WITH_RISK' | 'FAIL' | 'BLOCKED';
export interface VerdictInfo {
  status: Verdict;
  reason: { zh: string; en: string };
  standard: string;
}

export type Outcome = 'pass' | 'pass_risk' | 'fail' | 'blocked' | string;

const OF_VERDICT: Record<Verdict, Outcome> = {
  PASS: 'pass',
  PASS_WITH_RISK: 'pass_risk',
  FAIL: 'fail',
  BLOCKED: 'blocked',
};

export function outcomeOf(x: { state: string; verdict?: VerdictInfo }): Outcome {
  return x.verdict ? OF_VERDICT[x.verdict.status] : x.state;
}

export function outcomeOfVerdict(v: Verdict): Outcome {
  return OF_VERDICT[v];
}

/** 是測試結論(而不是執行狀態)。 */
export function isVerdictOutcome(o: Outcome): boolean {
  return o === 'pass' || o === 'pass_risk' || o === 'fail' || o === 'blocked';
}

/** 結果的顯示文字 key。 */
export function outcomeKey(o: Outcome): MessageKey {
  return (isVerdictOutcome(o) ? `outcome.${o}` : `state.${o}`) as MessageKey;
}

/** 列表圖示 / 顏色類別。 */
export function outcomeClass(o: Outcome): string {
  switch (o) {
    case 'pass': return 'task-state--pass';
    case 'pass_risk': return 'task-state--risk';
    case 'fail': return 'task-state--fail';
    case 'blocked': return 'task-state--blocked';
    case 'error': return 'task-state--error';
    case 'cancelled': return 'task-state--cancelled';
    case 'budget_exceeded': return 'task-state--budget';
    case 'dead': return 'task-state--dead';
    case 'running': return 'task-state--running';
    default: return 'task-state--queued';
  }
}

/** 圖示提示文字:結論 + 理由 + 執行結果(例:「受阻 — … · 執行結果:執行完成」)。 */
export function outcomeTip(
  x: { state: string; verdict?: VerdictInfo },
  t: (k: MessageKey) => string,
  lang: 'zh' | 'en' = 'zh',
): string {
  const o = outcomeOf(x);
  if (!x.verdict) return t(outcomeKey(o));
  const reason = x.verdict.reason[lang] ?? x.verdict.reason.zh;
  return `${t(outcomeKey(o))} — ${reason.length > 120 ? `${reason.slice(0, 118)}…` : reason} · ${t('outcome.execution')}:${t(`state.${x.state}` as MessageKey)}`;
}
