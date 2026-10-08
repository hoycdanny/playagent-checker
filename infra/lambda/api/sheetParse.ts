import { InvokeModelCommand, type BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

/**
 * 用 LLM 讀懂「格式不固定」的測試項目表。
 *
 * 刻意只讓模型回答**結構**(表頭在第幾列、資料從第幾列開始、每個欄位對應哪一欄),
 * 不讓它逐列重寫內容:
 *  - 189 列的表格全部送進模型再要它吐回來,又慢又貴,而且會改寫使用者的字。
 *  - 結構一旦判對,套用到幾千列都是前端的純函式,結果可預期、可重現。
 * 所以這支只吃前幾十列當樣本,回傳一份對應表;真正的展開在前端做,使用者還能逐格改。
 */

const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

/** 可對應的欄位(與前端 excelImport.ts 的 ImportField 一致)。 */
export const SHEET_FIELDS = [
  'id', 'name', 'purpose', 'module', 'category', 'priority', 'severity',
  'precondition', 'steps', 'expected', 'tags', 'url',
] as const;
export type SheetField = (typeof SHEET_FIELDS)[number];

export interface SheetLayout {
  /** 表頭列(0 起算);-1 = 這份表沒有表頭列。 */
  headerRow: number;
  /** 第一列資料(0 起算)。 */
  dataStartRow: number;
  /** 欄位 → 欄號(0 起算);沒有對應的欄位不出現。 */
  columns: Partial<Record<SheetField, number>>;
  /** 模型的判讀說明(給使用者看,例如「表頭有兩層,第 1 列是群組標題」)。 */
  notes: string;
  /** 自評信心 0~1。 */
  confidence: number;
  model: string;
}

const SYSTEM = `你是測試文件分析器。使用者給你一份測試項目表(Excel/CSV)的前幾列原始內容(二維陣列,索引從 0 開始)。
請判斷這份表的結構,只輸出一個 JSON 物件,不要有任何其他文字或 markdown 圍欄。

JSON 格式:
{"headerRow": <表頭列索引,沒有表頭則 -1>,
 "dataStartRow": <第一列實際資料的索引>,
 "columns": {"<欄位名>": <欄索引>, ...},
 "notes": "<30 字內的判讀說明,用使用者表格的語言>",
 "confidence": <0~1>}

可用的欄位名(只能用這些,對不到就不要放):
id(編號/項次)、name(測試項目/名稱/標題)、purpose(測試目的/目標/說明)、module(模組/功能)、
category(類別/分類)、priority(優先級)、severity(嚴重度)、precondition(前置條件)、
steps(測試步驟/操作)、expected(預期結果/驗收)、tags(標籤)、url(網址)

規則:
- 常見的多層表頭(第一列是「規劃 / 執行」這種群組標題,第二列才是真正欄名)要選**真正欄名**那一列。
- 合併儲存格在原始陣列裡會是空字串,不要因此誤判表頭列。
- 同一個概念只對應一欄;「項目」與「測試目的」是不同欄位,不要都塞給 name。
- 欄索引是該列陣列的位置(0 起算),不是 Excel 的 A/B/C。
- dataStartRow 必須 > headerRow(除非 headerRow 為 -1)。`;

interface Deps {
  bedrock: Pick<BedrockRuntimeClient, 'send'>;
}

export class SheetParseError extends Error {}

/** 取樣:最多前 N 列、每列最多 M 欄、每格最多 K 字(表格很寬/很長時才不會爆 token)。 */
export function sampleGrid(grid: string[][], rows = 25, cols = 20, cell = 200): string[][] {
  return grid.slice(0, rows).map((r) => r.slice(0, cols).map((c) => (c ?? '').slice(0, cell)));
}

/** 從模型回覆裡挖出 JSON 物件(容忍前後多餘文字與 ``` 圍欄)。 */
function extractJson(text: string): unknown {
  const t = text.replace(/```json\s*|```/g, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new SheetParseError('模型未回傳 JSON');
  return JSON.parse(t.slice(start, end + 1));
}

/**
 * 判讀表格結構。回傳的欄索引/列索引都會被夾在實際範圍內 ——
 * 模型可能回超出範圍的數字,照用會讓前端整欄抓空值卻看不出原因。
 */
export async function parseSheetLayout(
  deps: Deps,
  grid: string[][],
): Promise<SheetLayout> {
  if (!Array.isArray(grid) || grid.length === 0) throw new SheetParseError('grid 為必填');
  const sample = sampleGrid(grid);
  const width = Math.max(...sample.map((r) => r.length), 0);
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 800,
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `這份表共 ${grid.length} 列、約 ${width} 欄。以下是前 ${sample.length} 列:\n${JSON.stringify(sample, null, 0)}`,
      },
    ],
  };
  const res = await deps.bedrock.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }),
  );
  const decoded = JSON.parse(new TextDecoder().decode(res.body)) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = decoded.content?.find((c) => c.type === 'text')?.text ?? '';
  const raw = extractJson(text) as Record<string, unknown>;

  const clampRow = (v: unknown, fallback: number): number => {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(-1, Math.min(n, grid.length - 1));
  };
  const headerRow = clampRow(raw['headerRow'], -1);
  let dataStartRow = clampRow(raw['dataStartRow'], headerRow + 1);
  if (dataStartRow <= headerRow) dataStartRow = headerRow + 1;

  const columns: Partial<Record<SheetField, number>> = {};
  const rawCols = (raw['columns'] ?? {}) as Record<string, unknown>;
  const used = new Set<number>();
  for (const f of SHEET_FIELDS) {
    const n = Math.trunc(Number(rawCols[f]));
    if (!Number.isFinite(n) || n < 0 || n >= Math.max(width, 1)) continue;
    // 同一欄不重複對應到兩個欄位(模型偶爾會把 name 與 purpose 指到同一欄)。
    if (used.has(n)) continue;
    used.add(n);
    columns[f] = n;
  }
  const confRaw = Number(raw['confidence']);
  return {
    headerRow,
    dataStartRow,
    columns,
    notes: String(raw['notes'] ?? '').slice(0, 200),
    confidence: Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0.5,
    model: MODEL_ID,
  };
}
