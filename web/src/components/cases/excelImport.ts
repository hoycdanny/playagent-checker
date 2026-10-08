/**
 * Excel / CSV 測試項目 → 測試案例 YAML(純函式,不依賴試算表套件;方便單元測試)。
 *
 * 流程:工作表二維陣列 → 找表頭列 → 欄位對應(中英同義詞自動判斷,可手動改)→
 * 逐列組成案例(「一列一步驟」的表格:編號/名稱空白的列併入上一個案例)→ 產生 YAML。
 *
 * 產生的 YAML 會把前置條件 / 步驟 / 預期結果都寫進 `task`(執行時 AI 只讀 task),
 * 同時保留 module / priority / precondition / assertions 等欄位供案例總覽顯示與篩選。
 */

export type ImportField =
  | 'id'
  | 'name'
  | 'purpose'
  | 'module'
  | 'category'
  | 'priority'
  | 'severity'
  | 'precondition'
  | 'steps'
  | 'expected'
  | 'tags'
  | 'url';

export const IMPORT_FIELDS: ImportField[] = ['id', 'name', 'purpose', 'module', 'category', 'priority', 'severity', 'precondition', 'steps', 'expected', 'tags', 'url'];

/** 欄位 → 表頭同義詞(比對前會去空白、轉小寫)。 */
const SYNONYMS: Record<ImportField, string[]> = {
  id: ['編號', '案例編號', '用例編號', '測試編號', '項目編號', '項次', '序號', '用例id', 'id', 'no', 'no.', 'caseid', 'testcaseid', 'tcid', 'tc'],
  name: ['測試項目', '測試名稱', '案例名稱', '用例名稱', '測試案例', '測試情境', '測試場景', '測試標題', '標題', '名稱', '項目', '測試點', 'title', 'name', 'testcase', 'testcasename', 'scenario', 'summary', 'testitem'],
  // 測試目的/目標:常與「項目」並存(項目=功能名,目的=這條要驗什麼),之前會被整欄丟掉。
  purpose: ['測試目的', '目的', '測試目標', '目標', '測試說明', '說明', '驗證目的', 'purpose', 'objective', 'goal', 'intent', 'description'],
  module: ['模組', '功能模組', '模塊', '功能模塊', '功能', '功能名稱', '頁面', 'module', 'feature', 'area', 'component'],
  category: ['分類', '類別', '類型', '測試類型', 'category', 'type', 'testtype'],
  priority: ['優先級', '優先順序', '優先權', '優先度', '重要性', '等級', 'priority', 'level'],
  severity: ['嚴重度', '嚴重程度', '嚴重性', 'severity'],
  precondition: ['前置條件', '前提條件', '預置條件', '前提', '前置', 'precondition', 'preconditions', 'pre-condition', 'prerequisite', 'setup'],
  steps: ['測試步驟', '操作步驟', '執行步驟', '步驟', '操作', '測試內容', '步驟描述', 'steps', 'teststeps', 'step', 'action', 'actions', 'procedure'],
  expected: ['預期結果', '期望結果', '預期', '期望', '驗證點', '檢查點', '預期輸出', 'expected', 'expectedresult', 'expectedresults', 'expectedoutput'],
  tags: ['標籤', '標記', 'tags', 'tag', 'labels', 'label'],
  url: ['網址', '連結', '頁面網址', 'url', 'link'],
};

const norm = (s: string) => s.replace(/[\s_\-:：()（）[\]【】*\ufeff]/g, '').toLowerCase();
const NORM_SYNONYMS: Record<ImportField, string[]> = Object.fromEntries(
  IMPORT_FIELDS.map((f) => [f, SYNONYMS[f].map(norm)]),
) as Record<ImportField, string[]>;

/** 單一表頭 → 欄位(完全相符優先,其次「包含」)。 */
export function guessField(header: string): ImportField | undefined {
  const h = norm(header);
  if (!h) return undefined;
  for (const f of IMPORT_FIELDS) if (NORM_SYNONYMS[f].includes(h)) return f;
  // 包含比對(例:「測試步驟說明」→ steps):較長的同義詞先比;英文短字(id/no/tc…)只做完全相符,
  // 避免「Notes」被當成「No」之類的誤判。
  const minLen = (s: string) => (/[^\x00-\x7f]/.test(s) ? 2 : 5);
  const pairs = IMPORT_FIELDS.flatMap((f) => NORM_SYNONYMS[f].filter((s) => s.length >= minLen(s)).map((s) => [f, s] as const)).sort((a, b) => b[1].length - a[1].length);
  for (const [f, s] of pairs) if (h.includes(s)) return f;
  return undefined;
}

/** 欄位 → 欄號(-1 = 不使用)。 */
export type ColumnMap = Record<ImportField, number>;

export function emptyMap(): ColumnMap {
  return Object.fromEntries(IMPORT_FIELDS.map((f) => [f, -1])) as ColumnMap;
}

/** 依表頭猜欄位對應(同一欄位只取第一個符合的欄)。 */
export function guessMap(headers: string[]): ColumnMap {
  const map = emptyMap();
  headers.forEach((h, i) => {
    const f = guessField(h);
    if (f && map[f] < 0) map[f] = i;
  });
  return map;
}

/** 在前 15 列中找最像表頭的一列(對到最多欄位,且至少要有名稱或步驟)。 */
export function findHeaderRow(rows: string[][]): number {
  let best = -1;
  let bestScore = 0;
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const m = guessMap(rows[r] ?? []);
    const hits = IMPORT_FIELDS.filter((f) => m[f] >= 0).length;
    if ((m.name >= 0 || m.steps >= 0) && hits > bestScore) {
      best = r;
      bestScore = hits;
    }
  }
  return best;
}

export interface ImportedCase {
  /** 來源列號(1 起算,對應 Excel 左側列號)。 */
  row: number;
  id?: string;
  name: string;
  /** 測試目的(這條項目要驗證什麼)。 */
  purpose?: string;
  module?: string;
  category?: string;
  priority?: string;
  severity?: string;
  precondition?: string;
  steps: string[];
  expected: string[];
  tags: string[];
  url?: string;
}

const STEP_NUM_RE = /^\s*(?:\d+\s*[.、)\]）](?!\d)|[-•*●・])\s*/;

/** 儲存格文字 → 多行清單:依換行切;單行但內含「1. … 2. …」也拆開;去掉原有編號。 */
export function splitLines(cell: string | undefined): string[] {
  if (!cell) return [];
  let text = cell.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  if (!text.includes('\n')) {
    // 「1. 啟動 2. 點開始」:在每個「編號 + 非數字」前斷行(不會切到 1.2 這種小數/版本號)。
    const inline = text.split(/(?:^|[\s;；,，]+)(?=\d+\s*[.、)）]\s*[^\d\s])/).map((s) => s.trim()).filter(Boolean);
    if (inline.length >= 2) text = inline.join('\n');
    else if (/[;；]/.test(text)) text = text.split(/[;；]/).join('\n');
  }
  return text
    .split('\n')
    .map((l) => l.replace(STEP_NUM_RE, '').trim())
    .filter(Boolean);
}

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  return String(v).trim();
};

/**
 * 表頭以下各列 → 案例。
 * 名稱與編號都空白、但有步驟/預期 → 視為上一案例的續列(「一列一步驟」或合併儲存格)。
 * 完全空白的列略過。
 */
export function rowsToCases(rows: unknown[][], headerRow: number, map: ColumnMap, fallbackName = 'Case'): ImportedCase[] {
  const out: ImportedCase[] = [];
  const get = (row: unknown[], f: ImportField) => (map[f] >= 0 ? cellText(row[map[f]]) : '');
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (!row.some((c) => cellText(c))) continue;
    const id = get(row, 'id');
    const title = get(row, 'name');
    const steps = splitLines(get(row, 'steps'));
    const expected = splitLines(get(row, 'expected'));
    const prev = out[out.length - 1];
    if (!id && !title && prev) {
      prev.steps.push(...steps);
      prev.expected.push(...expected);
      const pre = get(row, 'precondition');
      if (pre) prev.precondition = prev.precondition ? `${prev.precondition}\n${pre}` : pre;
      continue;
    }
    if (!id && !title && steps.length === 0 && expected.length === 0) continue;
    // 編號是純數字(項次 1、2、3)時不放進名稱;TC-001 這類編號才加在名稱前方便對照。
    const name = (title ? [/^\d+$/.test(id) ? '' : id, title].filter(Boolean).join(' ') : id) || `${fallbackName} #${r + 1}`;
    const opt = (f: ImportField) => {
      const v = get(row, f);
      return v ? { [f]: v } : {};
    };
    out.push({
      row: r + 1,
      ...(id ? { id } : {}),
      name,
      ...opt('purpose'),
      ...opt('module'),
      ...opt('category'),
      ...opt('priority'),
      ...opt('severity'),
      ...opt('precondition'),
      ...opt('url'),
      steps,
      expected,
      tags: get(row, 'tags').split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean),
    });
  }
  return out;
}

// ───────────────────────── YAML 產生 ─────────────────────────

/** 單行純量:安全的直接寫,否則用 JSON 雙引號字串(合法 YAML)。 */
function scalar(v: string): string {
  const s = v.replace(/\s*\n\s*/g, ' ').trim();
  const plainSafe = s !== '' && !/^[\s\-?:,[\]{}#&*!|>'"%@`~]/.test(s) && !/:\s|\s#|:$/.test(s) && !/^(true|false|null|yes|no|on|off|~|[-+]?\d[\d_.eE+-]*)$/i.test(s);
  return plainSafe ? s : JSON.stringify(s);
}

function block(key: string, text: string): string {
  const body = text.split('\n').map((l) => (l.trim() ? `  ${l}` : '')).join('\n');
  return `${key}: |\n${body}`;
}

function list(key: string, items: string[]): string {
  return `${key}:\n${items.map((i) => `  - ${scalar(i)}`).join('\n')}`;
}

/** 組成給 AI 執行的任務描述:前置條件 → 編號步驟 → 預期結果。 */
export function buildTask(c: ImportedCase, lang: 'zh' | 'en' = 'zh'): string {
  const L = lang === 'zh'
    ? { pre: '前置條件', exp: '預期結果' }
    : { pre: 'Precondition', exp: 'Expected result' };
  const lines: string[] = [];
  if (c.purpose && c.purpose !== c.name) lines.push(`${lang === 'zh' ? '測試目的' : 'Purpose'}: ${c.purpose}`);
  if (c.precondition) lines.push(`${L.pre}: ${c.precondition.replace(/\s*\n\s*/g, '; ')}`);
  const steps = c.steps.length ? c.steps : [c.name];
  steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  if (c.expected.length) lines.push(`${L.exp}: ${c.expected.join('; ')}`);
  return lines.join('\n');
}

/**
 * 整份 Excel → 一個「測試套件」案例(一份 Excel = 一個測試任務)。
 *
 * 每個項目完整保留在 `items:`(編號/類別/項目/目的/步驟/預期),報告要逐項判定時讀這裡;
 * `task:` 則是給 AI 的執行清單(目前執行引擎只吃單一 task 文字)。
 */
export function suiteToYaml(
  items: ImportedCase[],
  appId: string,
  opts: { name: string; lang?: 'zh' | 'en'; source?: string },
): string {
  const zh = (opts.lang ?? 'zh') === 'zh';
  const parts: string[] = [
    `name: ${scalar(opts.name)}`,
    `app: ${scalar(appId)}`,
    'kind: suite',
    `itemCount: ${items.length}`,
  ];
  const head = zh
    ? `依序完成以下 ${items.length} 個測試項目,每一項都要判定是否符合預期結果。`
    : `Work through the following ${items.length} test items in order and judge each against its expected result.`;
  const taskLines: string[] = [head];
  items.forEach((it, i) => {
    const ref = it.id ? `[${it.id}] ` : '';
    const title = [it.module, it.category, it.purpose && it.purpose !== it.name ? it.purpose : '', it.name]
      .filter(Boolean)
      .join(' / ');
    taskLines.push(`${i + 1}. ${ref}${title}`);
    it.steps.forEach((s) => taskLines.push(`   - ${s}`));
    if (it.expected.length) taskLines.push(`   ${zh ? '預期' : 'Expected'}: ${it.expected.join('; ')}`);
  });
  parts.push(block('task', taskLines.join('\n')));

  // 結構化項目清單:縮排手寫,避免為了一個清單引入 YAML 套件。
  const itemLines: string[] = ['items:'];
  for (const it of items) {
    itemLines.push(`  - ref: ${scalar(it.id ?? String(it.row))}`);
    itemLines.push(`    title: ${scalar(it.name)}`);
    if (it.purpose) itemLines.push(`    purpose: ${scalar(it.purpose)}`);
    if (it.category) itemLines.push(`    category: ${scalar(it.category)}`);
    if (it.module) itemLines.push(`    module: ${scalar(it.module)}`);
    if (it.precondition) itemLines.push(`    precondition: ${scalar(it.precondition)}`);
    if (it.steps.length) {
      itemLines.push('    steps:');
      for (const s of it.steps) itemLines.push(`      - ${scalar(s)}`);
    }
    if (it.expected.length) {
      itemLines.push('    expected:');
      for (const e of it.expected) itemLines.push(`      - ${scalar(e)}`);
    }
    itemLines.push(`    row: ${it.row}`);
  }
  parts.push(itemLines.join('\n'));
  if (opts.source) parts.push(`source: ${scalar(opts.source)}`);
  return `${parts.join('\n')}\n`;
}

/** 案例 → YAML(controls 由呼叫端用 applyControls 套上)。 */
export function caseToYaml(c: ImportedCase, appId: string, opts: { lang?: 'zh' | 'en'; source?: string } = {}): string {
  const parts: string[] = [`name: ${scalar(c.name)}`, `app: ${scalar(appId)}`];
  if (c.id) parts.push(`caseRef: ${scalar(c.id)}`);
  if (c.purpose) parts.push(`purpose: ${scalar(c.purpose)}`);
  if (c.module) parts.push(`module: ${scalar(c.module)}`);
  if (c.category) parts.push(`category: ${scalar(c.category)}`);
  if (c.priority) parts.push(`priority: ${scalar(c.priority)}`);
  if (c.severity) parts.push(`severity: ${scalar(c.severity)}`);
  if (c.url) parts.push(`url: ${scalar(c.url)}`);
  if (c.precondition) parts.push(c.precondition.includes('\n') ? block('precondition', c.precondition) : `precondition: ${scalar(c.precondition)}`);
  parts.push(block('task', buildTask(c, opts.lang)));
  if (c.expected.length) parts.push(list('assertions', c.expected));
  if (c.tags.length) parts.push(`tags: [${c.tags.map(scalar).join(', ')}]`);
  if (opts.source) parts.push(`source: ${scalar(opts.source)}`);
  return `${parts.join('\n')}\n`;
}

/** 範本表頭(下載範本用)。 */
export const TEMPLATE_HEADERS = {
  zh: ['編號', '模組', '測試項目', '前置條件', '測試步驟', '預期結果', '優先級', '標籤'],
  en: ['ID', 'Module', 'Title', 'Precondition', 'Steps', 'Expected Result', 'Priority', 'Tags'],
} as const;

export const TEMPLATE_SAMPLE = {
  zh: [
    ['TC-001', '大廳', '進入遊戲大廳', '已安裝遊戲', '1. 啟動遊戲\n2. 關閉公告彈窗', '進入大廳且看得到開始按鈕', 'P1', 'smoke'],
    ['TC-002', '老虎機', '轉動一次', '在大廳', '1. 進入第一款老虎機\n2. 點 Spin', '轉輪開始轉動並顯示結果;餘額扣除押注', 'P1', 'smoke, slot'],
  ],
  en: [
    ['TC-001', 'Lobby', 'Enter the lobby', 'Game installed', '1. Launch the game\n2. Close the notice popup', 'Lobby is shown with the start button', 'P1', 'smoke'],
    ['TC-002', 'Slots', 'Spin once', 'In the lobby', '1. Open the first slot game\n2. Tap Spin', 'Reels spin and show a result; balance drops by the bet', 'P1', 'smoke, slot'],
  ],
} as const;
