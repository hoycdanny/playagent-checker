import { describe, expect, test } from 'vitest';
import { qaDocsFileName, qaDocsToSheets, sanitizeSheetName } from './qaDocsExport.ts';
import type { QaDocument, QaDocumentSet } from './reportTypes.ts';

/**
 * 交付文件匯出:只做資料整形。
 * 守兩件事:Excel 的工作表名稱硬限制不能違反(違反會讓整個檔案打不開),
 * 以及「算不出來」「空表」「不可產生」的說明必須跟著檔案一起走,不能在匯出時被抹掉。
 */

const l = (zh: string) => ({ zh, en: zh });

const doc = (over: Partial<QaDocument> & Pick<QaDocument, 'code'>): QaDocument => ({
  title: l(`文件 ${over.code}`),
  group: 'execution',
  coverage: 'derived',
  header: [],
  tables: [],
  links: [],
  unfilled: [],
  ...over,
});

function makeSet(documents: QaDocument[], over: Partial<QaDocumentSet> = {}): QaDocumentSet {
  return {
    standard: 'QA-DS-1.0',
    generatedAt: '2026-11-07T04:05:06.000Z',
    internalStandard: 'PA-AS-1.0',
    resultLegend: [
      { result: 'PASS', label: 'PASS', definition: l('實際執行結果與預期符合') },
      { result: 'BLOCK', label: 'BLOCK', definition: l('不具備可執行條件') },
    ],
    gradeLegend: [{ grade: 'A', label: l('A級致命'), definition: l('嚴重導致遊戲停止') }],
    discoveryLegend: [{ grade: 'E1', definition: l('一般操作觸發') }],
    statistics: [
      {
        id: 'execution_pass_rate',
        label: l('執行通過率'),
        formula: l('PASS／測試用例執行總數'),
        numerator: 3,
        denominator: 4,
        value: 75,
        basis: l('已執行列數'),
        caveat: l('納入範圍須隨報告確認'),
      },
      {
        id: 'item_coverage',
        label: l('測項覆蓋率'),
        formula: l('定版測項／(定版測項＋新增測項)'),
        numerator: null,
        denominator: null,
        value: null,
        basis: l('未提供測項母體,故不計算'),
        caveat: l('不是需求覆蓋率'),
      },
    ],
    documents,
    coverageSummary: {
      derived: documents.filter((d) => d.coverage === 'derived').length,
      derived_with_gaps: documents.filter((d) => d.coverage === 'derived_with_gaps').length,
      not_derivable: documents.filter((d) => d.coverage === 'not_derivable').length,
    },
    notes: [l('本文件集是內部判定結果的重新表述,不是另一次判定。')],
    ...over,
  };
}

describe('sheet names respect Excel limits', () => {
  test('forbidden characters are replaced, not passed through', () => {
    const name = sanitizeSheetName('T03 a/b[c]d:e*f?g\\h', new Set());
    expect(name).not.toMatch(/[[\]:*?/\\]/);
    expect(name).toContain('T03');
  });

  test('names longer than 31 characters are truncated', () => {
    const name = sanitizeSheetName('T07 '.padEnd(80, '詳'), new Set());
    expect(name.length).toBeLessThanOrEqual(31);
  });

  test('duplicates get a suffix and still fit the limit', () => {
    const used = new Set<string>();
    const a = sanitizeSheetName('詳細測試項目與執行結果'.repeat(4), used);
    const b = sanitizeSheetName('詳細測試項目與執行結果'.repeat(4), used);
    const c = sanitizeSheetName('詳細測試項目與執行結果'.repeat(4), used);
    expect(new Set([a, b, c]).size).toBe(3);
    for (const n of [a, b, c]) expect(n.length).toBeLessThanOrEqual(31);
  });

  test('an empty or symbol-only name still produces a usable sheet name', () => {
    expect(sanitizeSheetName('', new Set())).toBe('Sheet');
    expect(sanitizeSheetName('///', new Set()).length).toBeGreaterThan(0);
  });

  test('every sheet name in a real set is unique and legal', () => {
    const set = makeSet([
      doc({ code: 'T03' }),
      doc({ code: 'T05', coverage: 'derived_with_gaps', reason: l('後續版本才有') }),
      doc({ code: 'T04', coverage: 'not_derivable', reason: l('人工會議紀錄') }),
    ]);
    const names = qaDocsToSheets(set, 'zh').map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(31);
      expect(n).not.toMatch(/[[\]:*?/\\]/);
    }
  });
});

describe('sheet composition', () => {
  const set = makeSet([
    doc({
      code: 'T03',
      header: [{ key: 'project', label: l('專案代碼'), value: 'case-1' }],
      tables: [
        {
          id: 'checks',
          title: l('工作紀錄'),
          columns: [{ key: 'no', label: l('編號') }, { key: 'result', label: l('結果狀態') }],
          rows: [{ no: '1', result: 'PASS' }, { no: '2', result: 'BLOCK' }],
        },
      ],
      links: [{ key: 'env', label: l('環境代碼'), value: 'farm' }],
    }),
    doc({
      code: 'T05',
      coverage: 'derived_with_gaps',
      reason: l('分配與複驗版本屬後續版本'),
      tables: [
        {
          id: 'defects',
          title: l('工作紀錄'),
          columns: [{ key: 'no', label: l('編號') }],
          rows: [],
          emptyReason: l('本次執行未開立遊戲缺陷'),
        },
      ],
      unfilled: [l('回報人代碼')],
    }),
    doc({ code: 'T04', coverage: 'not_derivable', reason: l('輸入是人工會議紀錄') }),
  ]);

  test('leads with overview, statistics and coverage, and ends with the legends', () => {
    const sheets = qaDocsToSheets(set, 'zh');
    expect(sheets[0]!.name).toBe('總覽');
    expect(sheets[1]!.name).toBe('原有統計指標');
    expect(sheets[2]!.name).toBe('文件覆蓋');
    expect(sheets[sheets.length - 1]!.name).toBe('分級對照');
  });

  test('one sheet per derivable document; non-derivable documents get none', () => {
    const names = qaDocsToSheets(set, 'zh').map((s) => s.name);
    expect(names.some((n) => n.startsWith('T03'))).toBe(true);
    expect(names.some((n) => n.startsWith('T05'))).toBe(true);
    expect(names.some((n) => n.startsWith('T04'))).toBe(false);
  });

  test('the coverage sheet still lists every document, with its reason', () => {
    const coverage = qaDocsToSheets(set, 'zh')[2]!;
    const codes = coverage.rows.slice(1).map((r) => r[0]);
    expect(codes).toEqual(['T03', 'T05', 'T04']);
    const t04 = coverage.rows.find((r) => r[0] === 'T04')!;
    expect(t04.join(' ')).toContain('人工會議紀錄');
  });

  test('a statistic that cannot be computed exports as "not computed", never 0%', () => {
    const stats = qaDocsToSheets(set, 'zh')[1]!;
    const row = stats.rows.find((r) => r[0] === '測項覆蓋率')!;
    expect(row).toContain('不計算');
    expect(row).not.toContain('0%');
    // 分子分母一併匯出,收到檔案的人不必反推分母。
    expect(row[2]).toBe('—');
    expect(row[3]).toBe('—');
  });

  test('an empty table carries its reason into the file', () => {
    const t05 = qaDocsToSheets(set, 'zh').find((s) => s.name.startsWith('T05'))!;
    expect(t05.rows.flat().join(' ')).toContain('本次執行未開立遊戲缺陷');
  });

  test('a document sheet keeps header, rows, links and the manual-entry note', () => {
    const t03 = qaDocsToSheets(set, 'zh').find((s) => s.name.startsWith('T03'))!;
    const flat = t03.rows.map((r) => r.join('|'));
    expect(flat).toContain('專案代碼|case-1');
    expect(flat).toContain('編號|結果狀態');
    expect(flat).toContain('1|PASS');
    expect(flat).toContain('環境代碼|farm');

    const t05 = qaDocsToSheets(set, 'zh').find((s) => s.name.startsWith('T05'))!;
    expect(t05.rows.flat().join(' ')).toContain('回報人代碼');
  });

  test('English export uses English labels', () => {
    const en = makeSet([doc({ code: 'T03' })]);
    const sheets = qaDocsToSheets(en, 'en');
    expect(sheets[0]!.name).toBe('Overview');
    expect(sheets[2]!.name).toBe('Document coverage');
  });
});

describe('file name', () => {
  test('carries the report id, standard and date, and is a legal file name', () => {
    const name = qaDocsFileName(makeSet([doc({ code: 'T03' })]), 'RPT-job-abc', 'zh');
    expect(name).toBe('RPT-job-abc_QA-DS-1.0_2026-11-07_交付文件.xlsx');
    expect(name).not.toMatch(/[[\]:*?/\\]/);
  });

  test('falls back when the report has no id and no generated time', () => {
    const name = qaDocsFileName(makeSet([doc({ code: 'T03' })], { generatedAt: '' }), undefined, 'en');
    expect(name).toBe('report_QA-DS-1.0_deliverables.xlsx');
  });
});
