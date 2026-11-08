import type { QaDocument, QaDocumentSet, QaDocCoverage, QaDocGroup } from './reportTypes.ts';
import { tr, txt, type RLang, type TextKey } from './reportText.ts';

/**
 * 交付文件規範投影 → 試算表。
 *
 * 這一支刻意只做「資料整形」,不碰 SheetJS:工作表名稱的清洗與去重、哪些列進哪一張表,
 * 都是會出錯而且值得測的邏輯;真正寫檔只有 QaDocsPanel 裡那幾行(沿用 ExcelImport 的
 * 延遲載入慣例,試算表套件不進主包)。
 *
 * 匯出的是「報告已經算出來的值」的另一種容器,不重新計算任何數字。
 */

export interface ExportSheet {
  /** 已清洗成 Excel 可接受的名稱(≤31 字、不含 []:*?/\ 、不重複)。 */
  name: string;
  rows: string[][];
  /** 各欄寬度(SheetJS 的 wch)。 */
  cols?: number[];
}

const COVERAGE_KEY: Record<QaDocCoverage, TextKey> = {
  derived: 'qaDocDerived',
  derived_with_gaps: 'qaDocGaps',
  not_derivable: 'qaDocNotDerivable',
};

const GROUP_KEY: Record<QaDocGroup, TextKey> = {
  planning: 'qaGroupPlanning',
  execution: 'qaGroupExecution',
  defects: 'qaGroupDefects',
  closure: 'qaGroupClosure',
  specialty: 'qaGroupSpecialty',
  research: 'qaGroupResearch',
  training: 'qaGroupTraining',
};

/** Excel 工作表名稱禁用字元。 */
const FORBIDDEN = /[[\]:*?/\\]/g;
const MAX_NAME = 31;

/**
 * 清洗工作表名稱。Excel 的限制是硬限制:超過 31 字或含禁用字元會讓整個檔案打不開,
 * 所以截斷與去重都在這裡做完,而不是交給寫檔那一行去猜。
 */
export function sanitizeSheetName(raw: string, used: Set<string>): string {
  let base = raw.replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim();
  if (!base) base = 'Sheet';
  if (base.length > MAX_NAME) base = base.slice(0, MAX_NAME).trim();
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  // 重名時加序號,並為序號讓出字數(否則加完又超過上限)。
  for (let i = 2; i < 1000; i++) {
    const suffix = ` (${i})`;
    const name = `${base.slice(0, MAX_NAME - suffix.length).trim()}${suffix}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  const fallback = String(Date.now()).slice(-10);
  used.add(fallback);
  return fallback;
}

const DASH = '—';
const BLANK: string[] = [];

function docSheet(doc: QaDocument, lang: RLang, used: Set<string>): ExportSheet {
  const rows: string[][] = [
    [`${doc.code} ${tr(doc.title, lang)}`],
    [txt('qaDocCoverage', lang), txt(COVERAGE_KEY[doc.coverage], lang)],
  ];
  if (doc.reason) rows.push([txt('qaDocReason', lang), tr(doc.reason, lang)]);
  rows.push(BLANK);

  if (doc.header.length) {
    for (const h of doc.header) rows.push([tr(h.label, lang), h.value]);
    rows.push(BLANK);
  }

  for (const t of doc.tables) {
    rows.push([tr(t.title, lang)]);
    rows.push(t.columns.map((c) => tr(c.label, lang)));
    for (const r of t.rows) rows.push(t.columns.map((c) => r[c.key] ?? ''));
    // 空表與被截斷的表都要帶著原因一起匯出,否則收到檔案的人會把空白讀成「沒問題」。
    if (t.emptyReason) rows.push([tr(t.emptyReason, lang)]);
    rows.push(BLANK);
  }

  if (doc.links.length) {
    rows.push([txt('qaDocLinks', lang)]);
    for (const l of doc.links) rows.push([tr(l.label, lang), l.value]);
    rows.push(BLANK);
  }

  if (doc.unfilled.length) {
    rows.push([txt('qaDocUnfilled', lang), doc.unfilled.map((u) => tr(u, lang)).join('、')]);
  }

  const widest = Math.max(...doc.tables.map((t) => t.columns.length), 2);
  return {
    name: sanitizeSheetName(`${doc.code} ${tr(doc.title, lang)}`, used),
    rows,
    cols: Array.from({ length: widest }, (_, i) => (i === 0 ? 22 : 30)),
  };
}

/**
 * 整個文件集 → 工作表清單。
 * 前三張是總覽、統計與 19 類覆蓋狀態,接著每份有內容的文件一張表,最後是分級對照。
 */
export function qaDocsToSheets(set: QaDocumentSet, lang: RLang): ExportSheet[] {
  const used = new Set<string>();
  const sheets: ExportSheet[] = [];

  sheets.push({
    name: sanitizeSheetName(txt('qaDocOverview', lang), used),
    rows: [
      [txt('qaDocs', lang)],
      BLANK,
      [txt('qaDocStandard', lang), set.standard],
      [txt('qaDocInternal', lang), set.internalStandard],
      [txt('qaDocGeneratedAt', lang), set.generatedAt || DASH],
      BLANK,
      [txt('qaDocCoverage', lang)],
      [txt('qaDocDerived', lang), String(set.coverageSummary.derived)],
      [txt('qaDocGaps', lang), String(set.coverageSummary.derived_with_gaps)],
      [txt('qaDocNotDerivable', lang), String(set.coverageSummary.not_derivable)],
      BLANK,
      [txt('notes', lang)],
      ...set.notes.map((n) => [tr(n, lang)]),
    ],
    cols: [26, 60],
  });

  sheets.push({
    name: sanitizeSheetName(txt('qaDocStats', lang), used),
    rows: [
      [
        txt('acItem', lang),
        txt('qaDocFormula', lang),
        txt('qaDocNumerator', lang),
        txt('qaDocDenominator', lang),
        txt('qaDocValue', lang),
        txt('qaDocInclusion', lang),
        txt('qaDocBoundary', lang),
      ],
      ...set.statistics.map((s) => [
        tr(s.label, lang),
        tr(s.formula, lang),
        s.numerator === null ? DASH : String(s.numerator),
        s.denominator === null ? DASH : String(s.denominator),
        // 算不出來就寫「不計算」,不寫 0% —— 0% 會被讀成「一項都沒通過」。
        s.value === null ? txt('qaDocNotComputed', lang) : `${s.value}%`,
        tr(s.basis, lang),
        tr(s.caveat, lang),
      ]),
    ],
    cols: [18, 34, 10, 10, 12, 44, 48],
  });

  sheets.push({
    name: sanitizeSheetName(txt('qaDocCoverageSheet', lang), used),
    rows: [
      [
        txt('acId', lang),
        txt('qaDocTitle', lang),
        txt('qaDocGroupCol', lang),
        txt('qaDocCoverage', lang),
        txt('qaDocReason', lang),
        txt('qaDocUnfilled', lang),
      ],
      ...set.documents.map((d) => [
        d.code,
        tr(d.title, lang),
        txt(GROUP_KEY[d.group], lang),
        txt(COVERAGE_KEY[d.coverage], lang),
        d.reason ? tr(d.reason, lang) : DASH,
        d.unfilled.length ? d.unfilled.map((u) => tr(u, lang)).join('、') : DASH,
      ]),
    ],
    cols: [8, 28, 16, 22, 60, 40],
  });

  // 只有有內容的文件才各給一張表;不可產生的文件已在覆蓋表逐類列出原因。
  for (const doc of set.documents) {
    if (doc.coverage === 'not_derivable') continue;
    sheets.push(docSheet(doc, lang, used));
  }

  sheets.push({
    name: sanitizeSheetName(txt('qaDocLegendSheet', lang), used),
    rows: [
      [txt('qaDocLegendResult', lang)],
      ...set.resultLegend.map((l) => [l.label, tr(l.definition, lang)]),
      BLANK,
      [txt('qaDocLegendGrade', lang)],
      ...set.gradeLegend.map((l) => [tr(l.label, lang), tr(l.definition, lang)]),
      BLANK,
      [txt('qaDocLegendDiscovery', lang)],
      ...set.discoveryLegend.map((l) => [l.grade, tr(l.definition, lang)]),
    ],
    cols: [16, 60],
  });

  return sheets;
}

/** 匯出檔名:報告代碼 + 規範版本,避免多份報告的檔案互相覆蓋。 */
export function qaDocsFileName(set: QaDocumentSet, reportId: string | undefined, lang: RLang): string {
  const id = (reportId ?? 'report').replace(FORBIDDEN, '-').replace(/\s+/g, '');
  const day = (set.generatedAt || '').split('T')[0] ?? '';
  const stem = [id, set.standard, day].filter(Boolean).join('_');
  return `${stem}_${lang === 'zh' ? '交付文件' : 'deliverables'}.xlsx`;
}
