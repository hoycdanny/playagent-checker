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

/**
 * 理由精簡成一小句(完整理由在報告裡)。
 * 報告引擎的理由常是「本次測試無法作為驗收依據 —— AC-G01 …、AC-S01 … 未通過或無法判定(…),需修正後重測」,
 * 有驗收標準編號時改成「N 項未通過或無法判定:AC-G01、AC-S01 等」;否則取第一句。
 */
export function shortReason(reason: string, lang: 'zh' | 'en' = 'zh', max = lang === 'en' ? 28 : 16): string {
  const ids = [...new Set(reason.match(/\bAC-[A-Z]+\d+\b/g) ?? [])];
  if (ids.length) return lang === 'en' ? `${ids.length} criteria unmet` : `${ids.length} 項未達標`;
  const head = reason.trim().split(/\s+[—–]{1,2}\s+/)[0] ?? '';
  const first = head.split(/(?<=[。!?;!?;])\s*|\n|(?<=\.)\s+/)[0] ?? '';
  const s = first.replace(/[。;;,,.]+$/, '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 圖示提示文字(精簡):「結論 — 理由第一句」;執行本身有異常(錯誤 / 取消 / 超出預算…)才補一句執行結果。
 * 例:「受阻 · 4 項未達標」「受阻 · 錯誤」。
 */
export function outcomeTip(
  x: { state: string; verdict?: VerdictInfo },
  t: (k: MessageKey) => string,
  lang: 'zh' | 'en' = 'zh',
): string {
  const o = outcomeOf(x);
  if (!x.verdict) return t(outcomeKey(o));
  const reason = shortReason(x.verdict.reason[lang] ?? x.verdict.reason.zh ?? '', lang);
  const abnormal = x.state !== 'pass' && x.state !== 'fail' && x.state !== 'running' && x.state !== 'queued';
  // 執行本身出錯時,「執行錯誤」比理由更重要,只顯示它。
  const extra = abnormal ? t(`state.${x.state}` as MessageKey) : reason;
  return extra ? `${t(outcomeKey(o))} · ${extra}` : t(outcomeKey(o));
}
