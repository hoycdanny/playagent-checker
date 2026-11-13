import { Fragment, useMemo, useRef, useState, type DragEvent } from 'react';
import { apiPost } from '../../api/client.ts';
import { applyControls } from '../controls/controlsYaml.ts';
import { applyKeys, type CaseKey } from '../controls/keysYaml.ts';
import { pr, type RLang } from '../report/reportText.ts';
import {
  IMPORT_FIELDS,
  TEMPLATE_HEADERS,
  TEMPLATE_SAMPLE,
  caseToYaml,
  emptyMap,
  findHeaderRow,
  guessMap,
  rowsToCases,
  suiteToYaml,
  type ColumnMap,
  type ImportField,
  type ImportedCase,
} from './excelImport.ts';
import { pick5, type L5 } from '../../i18n/locale5.ts';
import './ExcelImport.css';

const T = {
  pick: ['選擇 Excel / CSV 檔案', 'Choose an Excel / CSV file', '选择 Excel / CSV 文件', 'Excel / CSV ファイルを選択', 'Excel / CSV 파일 선택'],
  drop: ['或把檔案拖到這裡(.xlsx / .xls / .csv)', 'or drop a file here (.xlsx / .xls / .csv)', '或把文件拖到这里(.xlsx / .xls / .csv)', 'またはここにファイルをドロップ(.xlsx / .xls / .csv)', '또는 파일을 여기로 끌어다 놓기(.xlsx / .xls / .csv)'],
  hint: ['每一列 = 一個測試案例;「一列一步驟」的表格(編號/名稱空白的列)會自動併入上一個案例。', 'One row = one test case. For one-step-per-row sheets, rows with an empty ID/title are merged into the case above.', '每一列 = 一个测试用例;「一列一步骤」的表格(编号/名称空白的列)会自动并入上一个用例。', '1 行 = 1 テストケースです。「1 行 1 ステップ」形式の表(番号/名前が空の行)は、上のケースに自動で統合されます。', '한 행 = 테스트 케이스 하나입니다. \'한 행 한 단계\' 형식의 표(번호/이름이 빈 행)는 위의 케이스에 자동으로 합쳐집니다.'],
  template: ['下載範本', 'Download template', '下载范本', 'テンプレートをダウンロード', '템플릿 다운로드'],
  sheet: ['工作表', 'Sheet', '工作表', 'シート', '시트'],
  headerRow: ['表頭在第 {n} 列', 'Header on row {n}', '表头在第 {n} 列', 'ヘッダーは {n} 行目', '헤더는 {n}행'],
  mapping: ['欄位對應', 'Column mapping', '字段对应', '列のマッピング', '열 매핑'],
  mappingHint: ['已依表頭自動判斷,可自行調整。', 'Detected from the header row; adjust if needed.', '已依表头自动判断,可自行调整。', 'ヘッダー行から自動判定しました。必要に応じて調整してください。', '헤더 행에서 자동으로 판단했습니다. 필요하면 조정하세요.'],
  unused: ['(不使用)', '(not used)', '(不使用)', '(使用しない)', '(사용 안 함)'],
  preview: ['預覽', 'Preview', '预览', 'プレビュー', '미리보기'],
  selectAll: ['全選', 'Select all', '全选', 'すべて選択', '모두 선택'],
  colRow: ['列', 'Row', '列', '行', '행'],
  colName: ['案例名稱', 'Case name', '用例名称', 'ケース名', '케이스 이름'],
  colModule: ['模組', 'Module', '模块', 'モジュール', '모듈'],
  colSteps: ['步驟', 'Steps', '步骤', 'ステップ', '단계'],
  colExpected: ['預期結果', 'Expected', '预期结果', '期待結果', '기대 결과'],
  showYaml: ['看 YAML', 'View YAML', '看 YAML', 'YAML を見る', 'YAML 보기'],
  create: ['建立 {n} 個案例', 'Create {n} cases', '创建 {n} 个用例', '{n} 件のケースを作成', '케이스 {n}개 만들기'],
  creating: ['建立中… {done}/{total}', 'Creating… {done}/{total}', '创建中… {done}/{total}', '作成中… {done}/{total}', '만드는 중… {done}/{total}'],
  needApp: ['請先選擇所屬應用', 'Select an app first', '请先选择所属应用', '先に所属アプリを選択してください', '먼저 소속 앱을 선택하세요'],
  needName: ['請在「欄位對應」指定「名稱」或「步驟」欄', 'Map a Name or Steps column first', '请在「字段对应」指定「名称」或「步骤」栏', '「列のマッピング」で「名前」または「ステップ」列を指定してください', '\'열 매핑\'에서 \'이름\' 또는 \'단계\' 열을 지정하세요'],
  noRows: ['找不到可匯入的資料列', 'No rows to import', '找不到可导入的数据列', 'インポートできるデータ行が見つかりません', '가져올 수 있는 데이터 행을 찾을 수 없습니다'],
  readError: ['無法讀取檔案:{msg}', 'Could not read the file: {msg}', '无法读取文件:{msg}', 'ファイルを読み取れません:{msg}', '파일을 읽을 수 없습니다: {msg}'],
  done: ['已建立 {ok} 個案例', 'Created {ok} cases', '已创建 {ok} 个用例', '{ok} 件のケースを作成しました', '케이스 {ok}개를 만들었습니다'],
  failed: ['{n} 個失敗', '{n} failed', '{n} 个失败', '{n} 件失敗', '{n}개 실패'],
  retry: ['重試失敗的項目', 'Retry failed rows', '重试失败的项目', '失敗した項目を再試行', '실패한 항목 다시 시도'],
  reset: ['換一個檔案', 'Choose another file', '换一个文件', '別のファイルを選ぶ', '다른 파일 선택'],
  ai: ['AI 判讀格式', 'Let AI read the layout', 'AI 判读格式', 'AI にレイアウトを判読させる', 'AI로 형식 판독'],
  aiBusy: ['判讀中…', 'Reading…', '判读中…', '判読中…', '판독 중…'],
  aiHint: ['表格格式不固定(多層表頭、欄位名不一樣)時按這個,AI 會判斷表頭在哪、每欄是什麼。判錯可以直接改下面的對應或逐列編輯。', 'Use this when the layout varies (multi-row headers, different column names). The AI decides where the header is and what each column means; you can still fix the mapping or edit any row below.', '表格格式不固定(多层表头、字段名不一样)时按这个,AI 会判断表头在哪、每栏是什么。判错可以直接改下面的对应或逐列编辑。', '表のレイアウトが一定でない場合(複数行ヘッダー、列名が異なるなど)はこちらを押すと、AI がヘッダーの位置と各列の意味を判断します。誤りがあれば下のマッピングを直接直すか、行ごとに編集できます。', '표 형식이 일정하지 않은 경우(여러 줄 헤더, 열 이름이 다른 경우 등) 이것을 누르면 AI가 헤더 위치와 각 열의 의미를 판단합니다. 틀렸다면 아래 매핑을 직접 고치거나 행별로 편집할 수 있습니다.'],
  aiFail: ['AI 判讀失敗:{msg}', 'AI could not read the layout: {msg}', 'AI 判读失败:{msg}', 'AI がレイアウトを判読できませんでした:{msg}', 'AI가 형식을 판독하지 못했습니다: {msg}'],
  dataStart: ['資料從第 {n} 列開始', 'Data starts on row {n}', '数据从第 {n} 列开始', 'データは {n} 行目から始まります', '데이터는 {n}행부터 시작'],
  suiteMode: ['整份 = 一個測試任務', 'Whole file = one test task', '整份 = 一个测试任务', 'ファイル全体 = 1 つのテストタスク', '파일 전체 = 테스트 작업 하나'],
  suiteHint: ['勾選:整份 Excel 變成一個「測試套件」案例,送出一次測試任務,報告涵蓋全部項目。不勾:每一列各建一個獨立案例。', 'Checked: the whole file becomes one test-suite case, submitted as a single task whose report covers every item. Unchecked: one independent case per row.', '勾选:整份 Excel 变成一个「测试套件」用例,送出一次测试任务,报告涵盖全部项目。不勾:每一列各建一个独立用例。', 'チェックあり:Excel 全体が 1 つの「テストスイート」ケースになり、1 回のテストタスクとして送信され、レポートは全項目を網羅します。チェックなし:行ごとに独立したケースを作成します。', '선택 시: Excel 전체가 하나의 \'테스트 스위트\' 케이스가 되어 테스트 작업 한 번으로 제출되며, 보고서가 모든 항목을 다룹니다. 선택 안 함: 행마다 독립된 케이스를 만듭니다.'],
  suiteName: ['套件名稱', 'Suite name', '套件名称', 'スイート名', '스위트 이름'],
  createSuite: ['建立 1 個測試套件({n} 個項目)', 'Create 1 test suite ({n} items)', '创建 1 个测试套件({n} 个项目)', 'テストスイートを 1 件作成({n} 項目)', '테스트 스위트 1개 만들기({n}개 항목)'],
  doneSuite: ['已建立測試套件({n} 個項目)', 'Test suite created ({n} items)', '已创建测试套件({n} 个项目)', 'テストスイートを作成しました({n} 項目)', '테스트 스위트를 만들었습니다({n}개 항목)'],
  edit: ['編輯', 'Edit', '编辑', '編集', '편집'],
  editDone: ['完成', 'Done', '完成', '完了', '완료'],
  colPurpose: ['測試目的', 'Purpose', '测试目的', 'テスト目的', '테스트 목적'],
  fId: ['編號', 'ID', '编号', '番号', '번호'],
  fName: ['項目', 'Item', '项目', '項目', '항목'],
  fPurpose: ['測試目的', 'Purpose', '测试目的', 'テスト目的', '테스트 목적'],
  fCategory: ['類別', 'Category', '类别', '分類', '분류'],
  fSteps: ['步驟(一行一個)', 'Steps (one per line)', '步骤(一行一个)', 'ステップ(1 行に 1 つ)', '단계(한 줄에 하나)'],
  fExpected: ['預期結果(一行一個)', 'Expected results (one per line)', '预期结果(一行一个)', '期待結果(1 行に 1 つ)', '기대 결과(한 줄에 하나)'],
  edited: ['已修改', 'edited', '已修改', '変更済み', '수정됨'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => pick5(T[k], lang);

const FIELD_LABEL: Record<ImportField, L5> = {
  id: ['編號', 'ID', '编号', '番号', '번호'],
  name: ['名稱', 'Name', '名称', '名前', '이름'],
  purpose: ['測試目的', 'Purpose', '测试目的', 'テスト目的', '테스트 목적'],
  module: ['模組', 'Module', '模块', 'モジュール', '모듈'],
  category: ['分類', 'Category', '分类', '分類', '분류'],
  priority: ['優先級', 'Priority', '优先级', '優先度', '우선순위'],
  severity: ['嚴重度', 'Severity', '严重度', '重大度', '심각도'],
  precondition: ['前置條件', 'Precondition', '前置条件', '前提条件', '사전 조건'],
  steps: ['測試步驟', 'Steps', '测试步骤', 'テストステップ', '테스트 단계'],
  expected: ['預期結果', 'Expected result', '预期结果', '期待結果', '기대 결과'],
  tags: ['標籤', 'Tags', '标签', 'タグ', '태그'],
  url: ['網址', 'URL', '网址', 'URL', 'URL'],
};

type XLSXModule = typeof import('xlsx');
let xlsxPromise: Promise<XLSXModule> | null = null;
/** 試算表套件較大,用到時才載入(不影響其他頁面的載入速度)。 */
const loadXlsx = () => (xlsxPromise ??= import('xlsx'));

interface Book { fileName: string; sheets: Array<{ name: string; rows: string[][] }> }

/** 檔案上限:超過多半不是測試項目表,避免瀏覽器卡住。 */
const MAX_BYTES = 10 * 1024 * 1024;
/** 單次匯入上限(逐筆呼叫 API)。 */
const MAX_CASES = 500;

export function ExcelImport({
  appId,
  controls,
  keys = [],
  lang,
  onCreated,
}: {
  appId: string;
  /** 套用到每個匯入案例的操作行為(與表單上的勾選一致)。 */
  controls: string[] | undefined;
  /** 套用到每個匯入案例的按鍵對應(鍵盤 / 滑鼠用途)。 */
  keys?: CaseKey[];
  lang: RLang;
  /** 建立完成(至少一筆成功)後通知外層重新整理清單;allOk = 全部成功。 */
  onCreated: (allOk: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerRow, setHeaderRow] = useState(-1);
  const [map, setMap] = useState<ColumnMap>(emptyMap);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ ok: number; failed: Array<{ row: number; name: string; error: string }> } | null>(null);
  const [yamlRow, setYamlRow] = useState<number | null>(null);
  // AI 判讀出的「資料起始列」(多層表頭時 ≠ headerRow+1);null = 照 headerRow+1。
  const [dataStart, setDataStart] = useState<number | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  // 逐列修正:列號 → 覆寫欄位(疊在解析結果上,不動原檔)。
  const [edits, setEdits] = useState<Record<number, Partial<ImportedCase>>>({});
  const [editRow, setEditRow] = useState<number | null>(null);
  // 整份 = 一個測試套件(一個測試任務);預設開啟 —— 多數人上傳整張表就是要一次測完。
  const [suiteMode, setSuiteMode] = useState(true);
  const [suiteName, setSuiteName] = useState('');

  const rows = book?.sheets[sheetIdx]?.rows ?? [];
  const headers = headerRow >= 0 ? (rows[headerRow] ?? []) : [];
  const width = Math.max(headers.length, ...rows.slice(0, 50).map((r) => r.length), 0);
  const baseName = book?.fileName.replace(/\.[^.]+$/, '') ?? 'Case';
  const parsed = useMemo(
    () =>
      book && (map.name >= 0 || map.steps >= 0)
        // dataStart 指定時以它為起點(rowsToCases 從 headerRow+1 開始讀資料)。
        ? rowsToCases(rows, dataStart !== null ? dataStart - 1 : headerRow, map, baseName)
        : [],
    [book, rows, headerRow, dataStart, map, baseName],
  );
  // 使用者的逐列修正疊上去(name 空白時退回原值,避免改成空的)。
  const cases = useMemo(
    () => parsed.map((c) => (edits[c.row] ? { ...c, ...edits[c.row], name: edits[c.row]?.name?.trim() || c.name } : c)),
    [parsed, edits],
  );
  const selected = cases.filter((c) => !excluded.has(c.row));
  const yamlOf = (c: (typeof cases)[number]) =>
    applyKeys(applyControls(caseToYaml(c, appId || '<app>', { lang, source: `${book?.fileName ?? ''}#${c.row}` }), controls), keys);

  function applySheet(b: Book, idx: number) {
    const r = b.sheets[idx]?.rows ?? [];
    const h = findHeaderRow(r);
    setSheetIdx(idx);
    setHeaderRow(h >= 0 ? h : 0);
    setMap(h >= 0 ? guessMap(r[h] ?? []) : emptyMap());
    setExcluded(new Set());
    setResult(null);
    setYamlRow(null);
  }

  async function readFile(file: File) {
    setError(null);
    setResult(null);
    if (file.size > MAX_BYTES) {
      setError(tx('readError', lang).replace('{msg}', '> 10 MB'));
      return;
    }
    try {
      const XLSX = await loadXlsx();
      const data = await file.arrayBuffer();
      // CSV 以 UTF-8 解碼(含 BOM 亦可);其餘交給 SheetJS 判斷格式。
      const wb = /\.csv$/i.test(file.name)
        ? XLSX.read(new TextDecoder('utf-8').decode(data), { type: 'string' })
        : XLSX.read(data, { type: 'array' });
      const sheets = wb.SheetNames.map((name) => {
        const ws = wb.Sheets[name]!;
        const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '', blankrows: true });
        return { name, rows: raw.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c)))) };
      }).filter((s) => s.rows.some((r) => r.some((c) => c.trim())));
      if (sheets.length === 0) {
        setError(tx('noRows', lang));
        return;
      }
      const b = { fileName: file.name, sheets };
      setBook(b);
      // 預設選「最像測試項目表」的工作表(找得到表頭者優先)。
      const best = Math.max(0, sheets.findIndex((s) => findHeaderRow(s.rows) >= 0));
      applySheet(b, best);
    } catch (e) {
      setError(tx('readError', lang).replace('{msg}', e instanceof Error ? e.message : String(e)));
    }
  }

  async function downloadTemplate() {
    const XLSX = await loadXlsx();
    // 範本表頭要命中匯入的同義詞表,只有繁中與英文兩份;其他語系下載英文版。
    const tpl = lang === 'zh-Hant' ? 'zh' : 'en';
    const ws = XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADERS[tpl]], ...TEMPLATE_SAMPLE[tpl].map((r) => [...r])]);
    ws['!cols'] = [10, 12, 24, 20, 40, 36, 8, 14].map((wch) => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, pr(['測試項目', 'Test cases', '测试项目', 'テスト項目', '테스트 항목'], lang));
    XLSX.writeFile(wb, pr(['測試項目範本.xlsx', 'test-cases-template.xlsx', '测试项目范本.xlsx', 'test-cases-template.xlsx', 'test-cases-template.xlsx'], lang));
  }

  /** 逐列修正:把這一列的覆寫值疊上去(空字串代表清掉該欄)。 */
  function patchRow(row: number, patch: Partial<ImportedCase>) {
    setEdits((prev) => ({ ...prev, [row]: { ...prev[row], ...patch } }));
  }
  /** 多行文字 → 清單(編輯步驟/預期結果用)。 */
  const toLines = (v: string) => v.split('\n').map((s) => s.trim()).filter(Boolean);

  /** 問後端:這份表的表頭在哪、每欄是什麼(格式不固定時用)。 */
  async function readLayout() {
    if (!book) return;
    setAiBusy(true);
    setError(null);
    setAiNote(null);
    try {
      const res = await apiPost<{
        headerRow: number;
        dataStartRow: number;
        columns: Partial<Record<ImportField, number>>;
        notes: string;
        confidence: number;
      }>('/cases/parse-sheet', { grid: rows.slice(0, 25) });
      const next = emptyMap();
      for (const k of Object.keys(res.columns ?? {}) as ImportField[]) {
        const v = res.columns[k];
        if (typeof v === 'number' && v >= 0) next[k] = v;
      }
      setMap(next);
      if (res.headerRow >= 0) setHeaderRow(res.headerRow);
      setDataStart(typeof res.dataStartRow === 'number' && res.dataStartRow > 0 ? res.dataStartRow : null);
      setEdits({});
      setExcluded(new Set());
      setAiNote(res.notes || null);
    } catch (e) {
      setError(tx('aiFail', lang).replace('{msg}', e instanceof Error ? e.message : String(e)));
    } finally {
      setAiBusy(false);
    }
  }

  /** 整份 Excel → 一個測試套件案例(一份 Excel = 一個測試任務)。 */
  async function createSuite() {
    if (!appId) { setError(tx('needApp', lang)); return; }
    if (selected.length === 0) { setError(tx('noRows', lang)); return; }
    setError(null);
    setProgress({ done: 0, total: 1 });
    try {
      const name = suiteName.trim() || baseName;
      const yaml = applyKeys(
        applyControls(suiteToYaml(selected, appId, { name, lang, source: book?.fileName ?? '' }), controls),
        keys,
      );
      await apiPost('/cases', { app: appId, name, yaml });
      setResult({ ok: selected.length, failed: [] });
      onCreated(true);
    } catch (e) {
      setResult({ ok: 0, failed: [{ row: 0, name: suiteName || baseName, error: e instanceof Error ? e.message : String(e) }] });
    } finally {
      setProgress(null);
    }
  }

  async function createAll(list = selected) {
    if (!appId) { setError(tx('needApp', lang)); return; }
    if (list.length === 0) { setError(tx('noRows', lang)); return; }
    setError(null);
    const todo = list.slice(0, MAX_CASES);
    const failed: Array<{ row: number; name: string; error: string }> = [];
    let ok = 0;
    let done = 0;
    setProgress({ done: 0, total: todo.length });
    // 小併發逐筆建立:每個案例各自有版本紀錄,失敗(如含字面量密碼)不影響其他列。
    const queue = [...todo];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        try {
          await apiPost('/cases', { app: appId, name: c.name, yaml: yamlOf(c) });
          ok++;
        } catch (e) {
          failed.push({ row: c.row, name: c.name, error: e instanceof Error ? e.message : String(e) });
        }
        done++;
        setProgress({ done, total: todo.length });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    failed.sort((a, b) => a.row - b.row);
    setProgress(null);
    setResult({ ok, failed });
    // 成功的列從選取中移除,方便「重試失敗的項目」。
    const failedRows = new Set(failed.map((f) => f.row));
    setExcluded(new Set(cases.filter((c) => !failedRows.has(c.row)).map((c) => c.row)));
    if (ok > 0) onCreated(failed.length === 0);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) void readFile(f);
  }

  const busy = progress !== null;

  if (!book) {
    return (
      <div className="xlimport">
        <div
          className={`xlimport__drop ${dragging ? 'is-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <button type="button" className="xlimport__pick" onClick={() => inputRef.current?.click()}>
            {tx('pick', lang)}
          </button>
          <span className="xlimport__muted">{tx('drop', lang)}</span>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.xlsm,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ''; }}
          />
        </div>
        <p className="xlimport__muted">
          {tx('hint', lang)}{' '}
          <button type="button" className="xlimport__link" onClick={() => void downloadTemplate()}>{tx('template', lang)}</button>
        </p>
        {error && <p className="cases__error" role="alert">{error}</p>}
      </div>
    );
  }

  const allChecked = cases.length > 0 && excluded.size === 0;
  return (
    <div className="xlimport">
      <div className="xlimport__bar">
        <strong className="xlimport__file" title={book.fileName}>📄 {book.fileName}</strong>
        {book.sheets.length > 1 && (
          <label className="xlimport__inline">
            <span>{tx('sheet', lang)}</span>
            <select value={sheetIdx} onChange={(e) => applySheet(book, Number(e.target.value))} disabled={busy}>
              {book.sheets.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="xlimport__inline">
          <span>{tx('headerRow', lang).replace('{n}', '')}</span>
          <select
            value={headerRow}
            disabled={busy}
            onChange={(e) => { const h = Number(e.target.value); setHeaderRow(h); setMap(guessMap(rows[h] ?? [])); setExcluded(new Set()); }}
            aria-label={tx('headerRow', lang).replace('{n}', String(headerRow + 1))}
          >
            {rows.slice(0, 15).map((_, i) => <option key={i} value={i}>{i + 1}</option>)}
          </select>
        </label>
        {dataStart !== null && (
          <span className="xlimport__muted">{tx('dataStart', lang).replace('{n}', String(dataStart + 1))}</span>
        )}
        <button type="button" className="xlimport__ai" onClick={() => void readLayout()} disabled={busy || aiBusy}>
          {aiBusy ? tx('aiBusy', lang) : tx('ai', lang)}
        </button>
        <span className="xlimport__spacer" />
        <button type="button" className="xlimport__link" onClick={() => { setBook(null); setResult(null); setError(null); setEdits({}); setDataStart(null); setAiNote(null); }} disabled={busy}>
          {tx('reset', lang)}
        </button>
      </div>

      <p className="xlimport__muted">{tx('aiHint', lang)}</p>
      {aiNote && <p className="xlimport__note" role="status">{aiNote}</p>}

      <div className="xlimport__suite">
        <label className="xlimport__check">
          <input type="checkbox" checked={suiteMode} disabled={busy} onChange={(e) => setSuiteMode(e.target.checked)} />
          <span>{tx('suiteMode', lang)}</span>
        </label>
        {suiteMode && (
          <label className="xlimport__inline">
            <span>{tx('suiteName', lang)}</span>
            <input value={suiteName} placeholder={baseName} disabled={busy} onChange={(e) => setSuiteName(e.target.value)} />
          </label>
        )}
        <span className="xlimport__muted">{tx('suiteHint', lang)}</span>
      </div>

      <fieldset className="xlimport__map" disabled={busy}>
        <legend>{tx('mapping', lang)} <small className="xlimport__muted">{tx('mappingHint', lang)}</small></legend>
        {IMPORT_FIELDS.map((f) => (
          <label key={f} className="xlimport__map-item">
            <span>{pick5(FIELD_LABEL[f], lang)}</span>
            <select value={map[f]} onChange={(e) => setMap((m) => ({ ...m, [f]: Number(e.target.value) }))}>
              <option value={-1}>{tx('unused', lang)}</option>
              {Array.from({ length: width }, (_, i) => (
                <option key={i} value={i}>{headers[i]?.trim() || `#${i + 1}`}</option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>

      {map.name < 0 && map.steps < 0 ? (
        <p className="cases__error" role="alert">{tx('needName', lang)}</p>
      ) : cases.length === 0 ? (
        <p className="xlimport__muted">{tx('noRows', lang)}</p>
      ) : (
        <div className="xlimport__table-wrap">
          <table className="xlimport__table">
            <caption className="visually-hidden">{tx('preview', lang)}</caption>
            <thead>
              <tr>
                <th scope="col">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    disabled={busy}
                    aria-label={tx('selectAll', lang)}
                    onChange={(e) => setExcluded(e.target.checked ? new Set() : new Set(cases.map((c) => c.row)))}
                  />
                </th>
                <th scope="col">{tx('colRow', lang)}</th>
                <th scope="col">{tx('colName', lang)}</th>
                <th scope="col">{tx('colPurpose', lang)}</th>
                <th scope="col">{tx('colSteps', lang)}</th>
                <th scope="col">{tx('colExpected', lang)}</th>
                <th scope="col"><span className="visually-hidden">{tx('edit', lang)}</span></th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => {
                const fail = result?.failed.find((f) => f.row === c.row);
                return (
                  <Fragment key={c.row}>
                    <tr className={fail ? 'is-failed' : ''}>
                      <td>
                        <input
                          type="checkbox"
                          checked={!excluded.has(c.row)}
                          disabled={busy}
                          aria-label={c.name}
                          onChange={(e) => setExcluded((p) => { const n = new Set(p); if (e.target.checked) n.delete(c.row); else n.add(c.row); return n; })}
                        />
                      </td>
                      <td className="xlimport__num">{c.row}</td>
                      <td>
                        {c.name}
                        {edits[c.row] && <span className="xlimport__badge">{tx('edited', lang)}</span>}
                        {fail && <div className="xlimport__err">{fail.error}</div>}
                      </td>
                      <td>{c.purpose ?? c.module ?? '—'}</td>
                      <td>
                        {c.steps.length > 0 ? (
                          <ol className="xlimport__steps">{c.steps.slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}{c.steps.length > 4 && <li>…(+{c.steps.length - 4})</li>}</ol>
                        ) : '—'}
                      </td>
                      <td>{c.expected.length ? c.expected.join(';') : '—'}</td>
                      <td className="xlimport__row-actions">
                        {/* 判讀錯誤就直接在這裡改;只改這一列的覆寫值,原檔與其他列不動。 */}
                        <button type="button" className="xlimport__link" aria-expanded={editRow === c.row} onClick={() => { setEditRow((r) => (r === c.row ? null : c.row)); setYamlRow(null); }}>
                          {editRow === c.row ? tx('editDone', lang) : tx('edit', lang)}
                        </button>
                        {!suiteMode && (
                          <button type="button" className="xlimport__link" aria-expanded={yamlRow === c.row} onClick={() => { setYamlRow((r) => (r === c.row ? null : c.row)); setEditRow(null); }}>
                            {tx('showYaml', lang)}
                          </button>
                        )}
                      </td>
                    </tr>
                    {editRow === c.row && (
                      <tr className="xlimport__edit-row">
                        <td colSpan={7}>
                          <div className="xlimport__edit">
                            <label className="xlimport__edit-f xlimport__edit-f--sm">
                              <span>{tx('fId', lang)}</span>
                              <input value={c.id ?? ''} onChange={(e) => patchRow(c.row, { id: e.target.value })} />
                            </label>
                            <label className="xlimport__edit-f">
                              <span>{tx('fName', lang)}</span>
                              <input value={c.name} onChange={(e) => patchRow(c.row, { name: e.target.value })} />
                            </label>
                            <label className="xlimport__edit-f">
                              <span>{tx('fPurpose', lang)}</span>
                              <input value={c.purpose ?? ''} onChange={(e) => patchRow(c.row, { purpose: e.target.value })} />
                            </label>
                            <label className="xlimport__edit-f xlimport__edit-f--sm">
                              <span>{tx('fCategory', lang)}</span>
                              <input value={c.category ?? ''} onChange={(e) => patchRow(c.row, { category: e.target.value })} />
                            </label>
                            <label className="xlimport__edit-f xlimport__edit-f--wide">
                              <span>{tx('fSteps', lang)}</span>
                              <textarea rows={Math.min(6, Math.max(2, c.steps.length))} value={c.steps.join('\n')} onChange={(e) => patchRow(c.row, { steps: toLines(e.target.value) })} />
                            </label>
                            <label className="xlimport__edit-f xlimport__edit-f--wide">
                              <span>{tx('fExpected', lang)}</span>
                              <textarea rows={Math.min(6, Math.max(2, c.expected.length))} value={c.expected.join('\n')} onChange={(e) => patchRow(c.row, { expected: toLines(e.target.value) })} />
                            </label>
                          </div>
                        </td>
                      </tr>
                    )}
                    {yamlRow === c.row && (
                      <tr className="xlimport__yaml-row">
                        <td colSpan={7}><pre className="xlimport__yaml">{yamlOf(c)}</pre></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && <p className="cases__error" role="alert">{error}</p>}
      {result && (
        <p className={`xlimport__result ${result.failed.length ? 'is-warn' : 'is-ok'}`} role="status">
          {suiteMode && result.ok > 0
            ? tx('doneSuite', lang).replace('{n}', String(result.ok))
            : tx('done', lang).replace('{ok}', String(result.ok))}
          {result.failed.length > 0 && <> · {tx('failed', lang).replace('{n}', String(result.failed.length))}</>}
        </p>
      )}

      <div className="xlimport__actions">
        {result && result.failed.length > 0 && !busy ? (
          <button type="button" className="cases__submit" onClick={() => void createAll()} disabled={selected.length === 0}>
            {tx('retry', lang)}
          </button>
        ) : (
          <button
            type="button"
            className="cases__submit"
            onClick={() => void (suiteMode ? createSuite() : createAll())}
            disabled={busy || selected.length === 0 || !appId}
          >
            {busy
              ? tx('creating', lang).replace('{done}', String(progress.done)).replace('{total}', String(progress.total))
              : suiteMode
                ? tx('createSuite', lang).replace('{n}', String(selected.length))
                : tx('create', lang).replace('{n}', String(Math.min(selected.length, MAX_CASES)))}
          </button>
        )}
        {!appId && <span className="cases__error">{tx('needApp', lang)}</span>}
      </div>
    </div>
  );
}

