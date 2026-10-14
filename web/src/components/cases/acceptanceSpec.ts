/**
 * 結構化驗收標準的前端資料模型與檢查(純函式,方便測試)。
 *
 * 版面刻意對齊大家熟悉的測試案例表(Excel):一列一個測試項目,
 * 欄位 = 類別 / 項目 / 測試目的 / 步驟 / 預期結果 / 截圖。
 * 讓 AI 有明確的、可逐條判定的停止條件,而不是只給一段文字後漫無目的地一直測。
 */

/** UI 用的單項測試項目(steps / expected 以多行文字編輯,送出時再拆成陣列)。 */
export interface AcceptanceItemDraft {
  /** 類別(例:中央畫面區)。 */
  category: string;
  /** 項目 / 功能(例:神秘商人)。 */
  module: string;
  /** 測試目的(這一項要驗證什麼,例:X 鈕關閉)。 */
  purpose: string;
  /** 測試步驟:多行文字,一行一步。 */
  steps: string;
  /** 預期結果:多行文字,一行一條。 */
  expected: string;
  /** 已上傳截圖的 artifactId(持久化);幫助 AI 理解此項的畫面/元素。 */
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
  return { category: '', module: '', purpose: '', steps: '', expected: '' };
}

export function emptyDraftSpec(): DraftSpec {
  return { model: '', note: '', acceptance: [] };
}

/** 範例列(「帶入範例」用):對照使用者熟悉的測試案例表,一看就懂格式。 */
export function sampleAcceptanceItems(lang: 'zh' | 'en'): AcceptanceItemDraft[] {
  if (lang === 'en') {
    return [
      {
        category: 'Lobby',
        module: 'Mystery merchant',
        purpose: 'Close with the X button',
        steps: '1. Tap the mystery-merchant icon in the lobby\n2. Tap the X at the top-right of the page',
        expected: '1. The mystery-merchant page closes\n2. Returns to the lobby',
      },
    ];
  }
  return [
    {
      category: '中央畫面區',
      module: '神秘商人',
      purpose: 'X 鈕關閉',
      steps: '1. 大廳點擊神秘商人 ICON\n2. 點擊神秘商人頁面右上 X 鈕',
      expected: '1. 關閉神秘商人頁面\n2. 返回大廳',
    },
  ];
}

/** 模糊字眼:預期結果只寫這些而沒有附截圖時,視為不夠精準。 */
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

/** 掃描測試項目,回報不夠精準的地方(不阻擋送出,只提示)。 */
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

/** UI 項目 → 送後端的 payload(steps / expected 多行文字拆成陣列;空項目略過)。 */
export function acceptanceToPayload(
  items: AcceptanceItemDraft[],
): Array<{
  category?: string;
  module?: string;
  purpose: string;
  steps: string[];
  expected: string;
  expectedImage?: string;
}> {
  return items
    .map((it) => ({
      ...(it.category.trim() ? { category: it.category.trim() } : {}),
      ...(it.module.trim() ? { module: it.module.trim() } : {}),
      purpose: it.purpose.trim(),
      steps: it.steps.split('\n').map((s) => s.trim()).filter(Boolean),
      expected: it.expected.trim(),
      ...(it.expectedImage ? { expectedImage: it.expectedImage } : {}),
    }))
    .filter((it) => it.purpose || it.expected || it.steps.length > 0 || it.module || it.category);
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
