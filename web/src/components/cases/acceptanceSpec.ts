/**
 * 結構化驗收標準的前端資料模型與檢查(純函式,方便測試)。
 *
 * 「精準」草擬的核心:使用者逐項填寫 測試目的 / 測試步驟 / 預期結果(可選預期畫面),
 * 讓 AI 有明確的、可逐條判定的停止條件,而不是只給一段文字後漫無目的地一直測。
 */

/** UI 用的單項驗收標準(steps 以多行文字編輯,送出時再拆成陣列)。 */
export interface AcceptanceItemDraft {
  purpose: string;
  /** 多行文字:一行一步驟。 */
  steps: string;
  expected: string;
  /** 已上傳預期畫面的 artifactId(持久化)。 */
  expectedImage?: string;
  /** 本機預覽用的 object URL(僅 UI,不送後端)。 */
  expectedImagePreview?: string;
  /** 原始檔名(僅顯示用)。 */
  expectedImageName?: string;
}

export interface DraftSpec {
  /** 產生腳本用的模型 id(/models?seat=agent 的最終 id)。 */
  model: string;
  /** 可收合的 Markdown 備註。 */
  note: string;
  acceptance: AcceptanceItemDraft[];
}

export function emptyAcceptanceItem(): AcceptanceItemDraft {
  return { purpose: '', steps: '', expected: '' };
}

export function emptyDraftSpec(): DraftSpec {
  return { model: '', note: '', acceptance: [] };
}

/** 模糊字眼:預期結果只寫這些而沒有附預期畫面時,視為不夠精準。 */
const VAGUE_TERMS = [
  '正常', '正確', '正确', '沒問題', '没问题', '良好', '應該', '应该', '大致',
  '合理', '符合預期', '符合预期', '順暢', '顺畅',
  'ok', 'okay', 'fine', 'correct', 'properly', 'works', 'work', 'normal',
  'as expected', 'good', 'should',
];

export type VagueKind = 'no-items' | 'missing' | 'vague';

export interface VagueFinding {
  kind: VagueKind;
  /** 1 起算的項目序號(no-items 時無)。 */
  index?: number;
}

/** 掃描驗收標準,回報不夠精準的地方(不阻擋送出,只提示)。 */
export function findVagueness(items: AcceptanceItemDraft[]): VagueFinding[] {
  if (items.length === 0) return [{ kind: 'no-items' }];
  const out: VagueFinding[] = [];
  items.forEach((it, i) => {
    const hasPurpose = it.purpose.trim() !== '';
    const hasSteps = it.steps.trim() !== '';
    const hasExpected = it.expected.trim() !== '';
    if (!hasPurpose || !hasSteps || !hasExpected) {
      out.push({ kind: 'missing', index: i + 1 });
      return;
    }
    const exp = it.expected.trim().toLowerCase();
    const vague = VAGUE_TERMS.some((term) => exp.includes(term.toLowerCase()));
    const tooShort = it.expected.trim().length < 6;
    if ((vague || tooShort) && !it.expectedImage) {
      out.push({ kind: 'vague', index: i + 1 });
    }
  });
  return out;
}

/** UI 項目 → 送後端的 payload(steps 多行文字拆成陣列;空項目略過)。 */
export function acceptanceToPayload(
  items: AcceptanceItemDraft[],
): Array<{ purpose: string; steps: string[]; expected: string; expectedImage?: string }> {
  return items
    .map((it) => ({
      purpose: it.purpose.trim(),
      steps: it.steps.split('\n').map((s) => s.trim()).filter(Boolean),
      expected: it.expected.trim(),
      ...(it.expectedImage ? { expectedImage: it.expectedImage } : {}),
    }))
    .filter((it) => it.purpose || it.expected || it.steps.length > 0);
}

/** 草擬模型預設值:優先 Sonnet 4.5(現行預設)→ 任一 Sonnet → 清單第一個。 */
export function pickDraftModelDefault(ids: string[]): string {
  return (
    ids.find((id) => id.includes('sonnet-4-5')) ??
    ids.find((id) => id.includes('sonnet')) ??
    ids[0] ??
    ''
  );
}
