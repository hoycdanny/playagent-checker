import { Fragment, useMemo, useRef, useState, type DragEvent } from 'react';
import { apiPost } from '../../api/client.ts';
import { applyControls } from '../controls/controlsYaml.ts';
import type { RLang } from '../report/reportText.ts';
import {
  IMPORT_FIELDS,
  TEMPLATE_HEADERS,
  TEMPLATE_SAMPLE,
  caseToYaml,
  emptyMap,
  findHeaderRow,
  guessMap,
  rowsToCases,
  type ColumnMap,
  type ImportField,
} from './excelImport.ts';
import './ExcelImport.css';

const T = {
  pick: ['選擇 Excel / CSV 檔案', 'Choose an Excel / CSV file'],
  drop: ['或把檔案拖到這裡(.xlsx / .xls / .csv)', 'or drop a file here (.xlsx / .xls / .csv)'],
  hint: ['每一列 = 一個測試案例;「一列一步驟」的表格(編號/名稱空白的列)會自動併入上一個案例。', 'One row = one test case. For one-step-per-row sheets, rows with an empty ID/title are merged into the case above.'],
  template: ['下載範本', 'Download template'],
  sheet: ['工作表', 'Sheet'],
  headerRow: ['表頭在第 {n} 列', 'Header on row {n}'],
  mapping: ['欄位對應', 'Column mapping'],
  mappingHint: ['已依表頭自動判斷,可自行調整。', 'Detected from the header row; adjust if needed.'],
  unused: ['(不使用)', '(not used)'],
  preview: ['預覽', 'Preview'],
  selectAll: ['全選', 'Select all'],
  colRow: ['列', 'Row'],
  colName: ['案例名稱', 'Case name'],
  colModule: ['模組', 'Module'],
  colSteps: ['步驟', 'Steps'],
  colExpected: ['預期結果', 'Expected'],
  showYaml: ['看 YAML', 'View YAML'],
  create: ['建立 {n} 個案例', 'Create {n} cases'],
  creating: ['建立中… {done}/{total}', 'Creating… {done}/{total}'],
  needApp: ['請先選擇所屬應用', 'Select an app first'],
  needName: ['請在「欄位對應」指定「名稱」或「步驟」欄', 'Map a Name or Steps column first'],
  noRows: ['找不到可匯入的資料列', 'No rows to import'],
  readError: ['無法讀取檔案:{msg}', 'Could not read the file: {msg}'],
  done: ['已建立 {ok} 個案例', 'Created {ok} cases'],
  failed: ['{n} 個失敗', '{n} failed'],
  retry: ['重試失敗的項目', 'Retry failed rows'],
  reset: ['換一個檔案', 'Choose another file'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];

const FIELD_LABEL: Record<ImportField, [string, string]> = {
  id: ['編號', 'ID'],
  name: ['名稱', 'Name'],
  module: ['模組', 'Module'],
  category: ['分類', 'Category'],
  priority: ['優先級', 'Priority'],
  severity: ['嚴重度', 'Severity'],
  precondition: ['前置條件', 'Precondition'],
  steps: ['測試步驟', 'Steps'],
  expected: ['預期結果', 'Expected result'],
  tags: ['標籤', 'Tags'],
  url: ['網址', 'URL'],
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
  lang,
  onCreated,
}: {
  appId: string;
  /** 套用到每個匯入案例的操作行為(與表單上的勾選一致)。 */
  controls: string[] | undefined;
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

  const rows = book?.sheets[sheetIdx]?.rows ?? [];
  const headers = headerRow >= 0 ? (rows[headerRow] ?? []) : [];
  const width = Math.max(headers.length, ...rows.slice(0, 50).map((r) => r.length), 0);
  const baseName = book?.fileName.replace(/\.[^.]+$/, '') ?? 'Case';
  const cases = useMemo(
    () => (book && (map.name >= 0 || map.steps >= 0) ? rowsToCases(rows, headerRow, map, baseName) : []),
    [book, rows, headerRow, map, baseName],
  );
  const selected = cases.filter((c) => !excluded.has(c.row));
  const yamlOf = (c: (typeof cases)[number]) =>
    applyControls(caseToYaml(c, appId || '<app>', { lang, source: `${book?.fileName ?? ''}#${c.row}` }), controls);

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
    const ws = XLSX.utils.aoa_to_sheet([[...TEMPLATE_HEADERS[lang]], ...TEMPLATE_SAMPLE[lang].map((r) => [...r])]);
    ws['!cols'] = [10, 12, 24, 20, 40, 36, 8, 14].map((wch) => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, lang === 'zh' ? '測試項目' : 'Test cases');
    XLSX.writeFile(wb, lang === 'zh' ? '測試項目範本.xlsx' : 'test-cases-template.xlsx');
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
        <span className="xlimport__spacer" />
        <button type="button" className="xlimport__link" onClick={() => { setBook(null); setResult(null); setError(null); }} disabled={busy}>
          {tx('reset', lang)}
        </button>
      </div>

      <fieldset className="xlimport__map" disabled={busy}>
        <legend>{tx('mapping', lang)} <small className="xlimport__muted">{tx('mappingHint', lang)}</small></legend>
        {IMPORT_FIELDS.map((f) => (
          <label key={f} className="xlimport__map-item">
            <span>{FIELD_LABEL[f][lang === 'zh' ? 0 : 1]}</span>
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
                <th scope="col">{tx('colModule', lang)}</th>
                <th scope="col">{tx('colSteps', lang)}</th>
                <th scope="col">{tx('colExpected', lang)}</th>
                <th scope="col"><span className="visually-hidden">YAML</span></th>
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
                        {fail && <div className="xlimport__err">{fail.error}</div>}
                      </td>
                      <td>{c.module ?? '—'}</td>
                      <td>
                        {c.steps.length > 0 ? (
                          <ol className="xlimport__steps">{c.steps.slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}{c.steps.length > 4 && <li>…(+{c.steps.length - 4})</li>}</ol>
                        ) : '—'}
                      </td>
                      <td>{c.expected.length ? c.expected.join(';') : '—'}</td>
                      <td>
                        <button type="button" className="xlimport__link" aria-expanded={yamlRow === c.row} onClick={() => setYamlRow((r) => (r === c.row ? null : c.row))}>
                          {tx('showYaml', lang)}
                        </button>
                      </td>
                    </tr>
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
          {tx('done', lang).replace('{ok}', String(result.ok))}
          {result.failed.length > 0 && <> · {tx('failed', lang).replace('{n}', String(result.failed.length))}</>}
        </p>
      )}

      <div className="xlimport__actions">
        {result && result.failed.length > 0 && !busy ? (
          <button type="button" className="cases__submit" onClick={() => void createAll()} disabled={selected.length === 0}>
            {tx('retry', lang)}
          </button>
        ) : (
          <button type="button" className="cases__submit" onClick={() => void createAll()} disabled={busy || selected.length === 0 || !appId}>
            {busy
              ? tx('creating', lang).replace('{done}', String(progress.done)).replace('{total}', String(progress.total))
              : tx('create', lang).replace('{n}', String(Math.min(selected.length, MAX_CASES)))}
          </button>
        )}
        {!appId && <span className="cases__error">{tx('needApp', lang)}</span>}
      </div>
    </div>
  );
}

