import { describe, expect, test } from 'vitest';
import { buildStructuredReport } from '../lambda/api/report/engine.js';
import {
  QA_CATEGORIES,
  QA_CROSS_TAGS,
  QA_DOC_CODES,
  QA_DOC_STANDARD_TAG,
  buildQaDocumentSet,
  buildQaStatistics,
  qaAcceptanceMark,
  qaCategoryOf,
  qaCrossTagsOf,
  qaDiscoveryOf,
  qaGradeOf,
  qaResultOfCheck,
  qaResultOfCriterion,
  type QaDocument,
} from '../lambda/api/report/qaDocs.js';
import type { FindingCategory, Reproducibility, Severity } from '../lambda/api/report/types.js';

/**
 * 交付文件規範(QA-DS):把內部判定重新表述成 19 類交付文件。
 * 這裡守三件事:四態不會把「沒結果」寫成 PASS、三個統計公式缺輸入時回 null、19 類文件一類不漏。
 */

type RawStep = Record<string, unknown>;
const st = (index: number, screen: string, action: string, obs?: Record<string, unknown>, extra: RawStep = {}): RawStep => ({
  index, screen, action, ...(obs ? { obs } : {}), ...extra,
});
const report = (state: string, steps: RawStep[], task = '探索遊戲', message?: string) =>
  buildStructuredReport({ raw: { state, task, steps, ...(message ? { message } : {}) }, job: { jobId: 'job-test' }, app: { genre: 'slot' } });

const docOf = (docs: QaDocument[], code: string): QaDocument => docs.find((d) => d.code === code)!;

/** 一次有確認閃退的執行:會產生 FAIL 結論與遊戲缺陷,讓問題清單有內容。 */
const crashSteps = (): RawStep[] => [
  st(0, '大廳', 'tap', undefined, { x: 10, y: 10 }),
  st(1, '大廳', 'tap', undefined, { foregroundLost: true, appState: 1, prevAction: 'tap' }),
  st(2, '大廳', 'done'),
];

describe('result vocabulary never upgrades a missing result to PASS', () => {
  test('indeterminate and skipped checks both become BLOCK and keep the original judgement', () => {
    expect(qaResultOfCheck('pass').result).toBe('PASS');
    expect(qaResultOfCheck('fail').result).toBe('FAIL');

    const unclear = qaResultOfCheck('unclear');
    expect(unclear.result).toBe('BLOCK');
    expect(unclear.note?.zh).toContain('待判讀');

    const skipped = qaResultOfCheck('skipped');
    expect(skipped.result).toBe('BLOCK');
    expect(skipped.note?.zh).toContain('不填 PASS');
  });

  test('only not_applicable criteria reach N/A; not_evaluable stays BLOCK', () => {
    expect(qaResultOfCriterion('pass').result).toBe('PASS');
    expect(qaResultOfCriterion('fail').result).toBe('FAIL');
    expect(qaResultOfCriterion('not_evaluable').result).toBe('BLOCK');
    expect(qaResultOfCriterion('not_applicable').result).toBe('NA');
  });

  test('acceptance mark is Y only for PASS; N/A is neither accepted nor rejected', () => {
    expect(qaAcceptanceMark('PASS')).toBe('Y');
    expect(qaAcceptanceMark('FAIL')).toBe('N');
    expect(qaAcceptanceMark('BLOCK')).toBe('N');
    expect(qaAcceptanceMark('NA')).toBe('—');
  });

  test('no derived document row records PASS for a check the engine could not judge', () => {
    // 最後一步沒有後續畫面可判定 → 引擎記 skipped,文件必須是 BLOCK。
    const r = report('pass', [st(0, '大廳', 'tap', undefined, { x: 5, y: 5, expect: '開啟選單' }), st(1, '選單', 'done')]);
    const t03 = docOf(buildQaDocumentSet(r).documents, 'T03');
    const rows = t03.tables[0]!.rows;
    const judged = new Map(r.checks.map((c, i) => [String(i + 1), c.result]));
    for (const row of rows) {
      if (judged.get(row['no']!) !== 'pass') expect(row['result']).not.toBe('PASS');
    }
  });
});

describe('defect grading', () => {
  test('internal severity maps onto the four defect grades', () => {
    const expected: Array<[Severity, string]> = [['critical', 'A'], ['high', 'B'], ['medium', 'C'], ['low', 'D']];
    for (const [severity, grade] of expected) expect(qaGradeOf(severity)).toBe(grade);
  });

  test('discovery grade follows a fixed order and explains itself', () => {
    const base = {
      severity: 'high' as Severity,
      category: 'functional' as FindingCategory,
      classification: 'GAME_FAILURE' as const,
      reproducibility: 'always' as Reproducibility,
    };

    // 環境條件優先:即使一般操作就重現,歸因為環境仍是 E3。
    expect(qaDiscoveryOf({ ...base, category: 'network' }).grade).toBe('E3');
    expect(qaDiscoveryOf({ ...base, classification: 'ENVIRONMENT' }).grade).toBe('E3');
    // D 級建議 → E0。
    expect(qaDiscoveryOf({ ...base, severity: 'low' }).grade).toBe('E0');
    // 一般操作觸發 → E1;需特定條件 → E2。
    expect(qaDiscoveryOf(base).grade).toBe('E1');
    expect(qaDiscoveryOf({ ...base, reproducibility: 'frequent' }).grade).toBe('E1');
    expect(qaDiscoveryOf({ ...base, reproducibility: 'single' }).grade).toBe('E2');
    expect(qaDiscoveryOf({ ...base, reproducibility: 'intermittent' }).grade).toBe('E2');

    for (const g of ['E0', 'E1', 'E2', 'E3']) {
      const sample = qaDiscoveryOf(
        g === 'E3' ? { ...base, category: 'network' }
          : g === 'E0' ? { ...base, severity: 'low' }
            : g === 'E1' ? base
              : { ...base, reproducibility: 'single' },
      );
      expect(sample.reason.zh.length).toBeGreaterThan(0);
    }
  });

  test('test-tool problems are listed separately, not as game defects', () => {
    const r = report('pass', [
      st(0, '大廳', 'tap', undefined, { x: 10, y: 10 }),
      st(1, '大廳', 'tap', undefined, { parseFailed: true }),
      st(2, '大廳', 'done'),
    ]);
    const t05 = docOf(buildQaDocumentSet(r).documents, 'T05');
    const defectTable = t05.tables.find((t) => t.id === 'defects')!;
    const toolTable = t05.tables.find((t) => t.id === 'ai_failures')!;
    expect(defectTable.rows.length).toBe(r.findings.length);
    expect(toolTable.rows.length).toBe(r.aiFailures.length);
    expect(toolTable.title.zh).toContain('不計入遊戲缺陷');
  });
});

describe('original statistics keep their own denominators', () => {
  test('execution pass rate uses the executed rows and says so', () => {
    const r = report('pass', crashSteps());
    const stat = buildQaStatistics(r).find((s) => s.id === 'execution_pass_rate')!;
    const executed = r.counts.passed + r.counts.failed + r.counts.unclear;
    expect(stat.numerator).toBe(r.counts.passed);
    expect(stat.denominator).toBe(executed);
    expect(stat.formula.zh).toBe('PASS／測試用例執行總數');
    // 與平台內部通過率(通過÷(通過＋失敗))分母不同,必須明說不可互換。
    expect(stat.caveat.zh).toContain('不可互換');
  });

  test('item coverage and defect fix rate are null without their inputs, with a reason', () => {
    const r = report('pass', crashSteps());
    for (const id of ['item_coverage', 'defect_fix_rate']) {
      const stat = buildQaStatistics(r).find((s) => s.id === id)!;
      expect(stat.value).toBeNull();
      expect(stat.numerator === null || stat.denominator === null).toBe(true);
      expect(stat.basis.zh).toContain('不計算');
    }
  });

  test('both compute once the population and disposition are supplied', () => {
    const r = report('pass', crashSteps());
    const stats = buildQaStatistics(r, {
      itemBaseline: { baselined: 80, added: 20 },
      defectDisposition: { fixed: 6, wontFix: 2, total: 10 },
    });
    const coverage = stats.find((s) => s.id === 'item_coverage')!;
    expect(coverage.value).toBe(80); // 80 / (80 + 20)
    expect(coverage.caveat.zh).toContain('不是需求覆蓋率');

    const fix = stats.find((s) => s.id === 'defect_fix_rate')!;
    expect(fix.numerator).toBe(8); // 已修正 6 + 不做處理 2
    expect(fix.value).toBe(80);
    expect(fix.caveat.zh).toContain('不做處理');
  });

  test('a zero denominator yields null rather than a divide-by-zero or 0%', () => {
    const r = report('pass', crashSteps());
    const stats = buildQaStatistics(r, { itemBaseline: { baselined: 0, added: 0 }, defectDisposition: { fixed: 0, wontFix: 0, total: 0 } });
    expect(stats.find((s) => s.id === 'item_coverage')!.value).toBeNull();
    expect(stats.find((s) => s.id === 'defect_fix_rate')!.value).toBeNull();
  });
});

describe('taxonomy', () => {
  test('19 primary categories, unique codes, and an explicit fallback', () => {
    expect(QA_CATEGORIES).toHaveLength(19);
    expect(new Set(QA_CATEGORIES.map((c) => c.code)).size).toBe(19);
    expect(qaCategoryOf('遊戲登入頁 輸入密碼').code).toBe('M02');
    expect(qaCategoryOf('AutoSpin 轉軸 下注').code).toBe('M03');
    // 推不出分類時歸跨功能組合,而不是硬塞第一類。
    expect(qaCategoryOf('zzz').code).toBe('M19');
  });

  test('cross-cutting tags are orthogonal and can co-occur', () => {
    expect(QA_CROSS_TAGS).toHaveLength(6);
    const tags = qaCrossTagsOf('切換語系後斷線重連,檢查餘額一致');
    expect(tags).toContain('locale_av');
    expect(tags).toContain('interruption_recovery');
    expect(tags).toContain('data_consistency');
    expect(qaCrossTagsOf('一般操作')).toEqual([]);
  });
});

describe('the document set covers all 19 types', () => {
  test('every type appears, in order, and the coverage summary adds up to 19', () => {
    const set = buildQaDocumentSet(report('pass', crashSteps()));
    expect(set.standard).toBe(QA_DOC_STANDARD_TAG);
    expect(set.documents.map((d) => d.code)).toEqual([...QA_DOC_CODES]);
    expect(set.documents).toHaveLength(19);
    const summary = set.coverageSummary;
    expect(summary.derived + summary.derived_with_gaps + summary.not_derivable).toBe(19);
  });

  test('a document that cannot be derived says why, and never fakes rows', () => {
    const set = buildQaDocumentSet(report('pass', crashSteps()));
    const undrivable = set.documents.filter((d) => d.coverage === 'not_derivable');
    expect(undrivable.length).toBeGreaterThan(0);
    for (const d of undrivable) {
      expect(d.reason?.zh.length).toBeGreaterThan(0);
      expect(d.tables.every((t) => t.rows.length === 0)).toBe(true);
    }
  });

  test('documents with manual gaps name the fields that still need a human', () => {
    const set = buildQaDocumentSet(report('pass', crashSteps()));
    for (const d of set.documents.filter((x) => x.coverage === 'derived_with_gaps')) {
      expect(d.reason?.zh.length).toBeGreaterThan(0);
      expect(d.unfilled.length).toBeGreaterThan(0);
    }
  });

  test('an empty table explains itself instead of looking like a clean run', () => {
    // 沒有缺陷的執行:問題清單必須說「未開立」,不能是一張沒有說明的空表。
    const r = report('pass', [st(0, '大廳', 'tap', undefined, { x: 5, y: 5 }), st(1, '選單', 'done')]);
    const t05 = docOf(buildQaDocumentSet(r).documents, 'T05');
    const defects = t05.tables.find((t) => t.id === 'defects')!;
    expect(defects.rows).toHaveLength(0);
    expect(defects.emptyReason?.zh).toContain('未開立');
  });

  test('performance closure is not produced when nothing was measured', () => {
    const r = report('pass', crashSteps());
    const t13 = docOf(buildQaDocumentSet(r).documents, 'T13');
    expect(t13.coverage).toBe('not_derivable');
    expect(t13.reason?.zh).toContain('未收集');
    expect(t13.tables).toHaveLength(0);
  });

  test('performance closure appears once the device was actually measured', () => {
    const perf = { cpuPct: 40, memMB: 900, fps: 48, frames: 480, fpsSpanS: 10 };
    const r = report('pass', [
      st(0, '轉軸畫面', 'wait', { balance: 1000 }, { perf }),
      st(1, '轉軸畫面', 'wait', { balance: 980 }, { perf: { ...perf, cpuPct: 55, memMB: 1100 } }),
      st(2, '轉軸畫面', 'done', undefined, { perf }),
    ]);
    const t13 = docOf(buildQaDocumentSet(r).documents, 'T13');
    expect(t13.coverage).toBe('derived_with_gaps');
    const rows = t13.tables.find((t) => t.id === 'perf')!.rows;
    expect(rows.length).toBeGreaterThan(0);
    // 沒有核定標準值就不判定,不以門檻缺席當成通過。
    for (const row of rows) {
      if (row['threshold'] === '—') expect(row['result']).not.toBe('FAIL');
      if (row['actual'] === '—') expect(row['result']).toBe('BLOCK');
    }
    // 核定門檻來源必須明確標為待補,不可自行假設業界值。
    expect(t13.unfilled.some((u) => u.zh.includes('核定'))).toBe(true);
  });

  test('closure report lists known issues with their recommendation', () => {
    const r = report('pass', crashSteps());
    const known = docOf(buildQaDocumentSet(r).documents, 'T07').tables.find((t) => t.id === 'known_issues')!;
    expect(known.rows.length).toBe(r.findings.length + r.risks.length);
    for (const row of known.rows) {
      expect(row['source']).toMatch(/缺陷|風險/);
      expect(row['summary']!.length).toBeGreaterThan(0);
    }
  });

  test('closure report carries the verdict, the four-state counts and the statistics table', () => {
    const r = report('pass', crashSteps());
    const t07 = docOf(buildQaDocumentSet(r).documents, 'T07');
    expect(t07.header.find((h) => h.key === 'verdict')?.value).toBe(r.overallStatus);
    const results = t07.tables.find((t) => t.id === 'case_summary')!;
    expect(results.rows.map((x) => x['result'])).toEqual(['PASS', 'FAIL', 'BLOCK', 'N/A']);
    const stats = t07.tables.find((t) => t.id === 'statistics')!;
    expect(stats.rows).toHaveLength(3);
    // 分子分母一律外顯,避免只看百分比被誤讀。
    for (const row of stats.rows) expect(row).toHaveProperty('denominator');
  });

  test('the projection restates the verdict, it does not re-decide it', () => {
    const r = report('pass', crashSteps());
    const set = buildQaDocumentSet(r);
    expect(r.overallStatus).toBe('FAIL');
    expect(set.internalStandard).toBe(r.acceptance.standard);
    expect(set.notes[0]!.zh).toContain('不是另一次判定');
  });

  test('long tables are capped and point at the full data', () => {
    const steps = spinSteps(30);
    const r = report('pass', steps);
    const set = buildQaDocumentSet(r, { maxRows: 5 });
    const perRun = docOf(set.documents, 'T12').tables.find((t) => t.id === 'per_run')!;
    expect(perRun.rows).toHaveLength(5);
    expect(perRun.emptyReason?.zh).toContain('逐步證據');
    expect(r.evidence.length).toBeGreaterThan(5); // 完整資料仍在報告本文
  });
});

/** 一段逐局下注:每局 bet 10、派彩交替,餘額隨之遞減。 */
function spinSteps(n: number): RawStep[] {
  const out: RawStep[] = [];
  let balance = 1000;
  for (let i = 0; i < n; i++) {
    const win = i % 3 === 0 ? 30 : 0;
    balance = balance - 10 + win;
    out.push(st(i, '轉軸畫面', 'spin', { bet: 10, win, balance, spun: true }));
  }
  out.push(st(n, '轉軸畫面', 'done'));
  return out;
}

describe('T12 per-record results is a per-round ledger', () => {
  test('stake, cumulative stake, balance-before and payout are reconstructed per round', () => {
    const r = report('pass', spinSteps(3));
    const perRun = docOf(buildQaDocumentSet(r).documents, 'T12').tables.find((t) => t.id === 'per_run')!;
    expect(perRun.columns.map((c) => c.key)).toEqual([
      'seq', 'game', 'at', 'level', 'state', 'before', 'bet', 'cumulative', 'result', 'specialA', 'specialB', 'specialC', 'note',
    ]);
    expect(perRun.rows).toHaveLength(3);

    // 第 1 局:下注 10、派彩 30、結算後 1020 → 資產前 = 1020 − 30 + 10 = 1000
    expect(perRun.rows[0]).toMatchObject({ seq: '1', bet: '10', result: '30', before: '1000', cumulative: '10' });
    // 累積操作值逐局累加,不是每局重算
    expect(perRun.rows.map((x) => x['cumulative'])).toEqual(['10', '20', '30']);
  });

  test('a non-spin run says why no ledger exists instead of dumping steps', () => {
    const r = report('pass', [st(0, '大廳', 'tap', undefined, { x: 5, y: 5 }), st(1, '選單', 'done')]);
    const perRun = docOf(buildQaDocumentSet(r).documents, 'T12').tables.find((t) => t.id === 'per_run')!;
    expect(perRun.rows).toHaveLength(0);
    expect(perRun.emptyReason?.zh).toContain('重建不出逐局帳');
  });

  test('a broken recurrence chain is flagged on the row, not silently carried', () => {
    // 中間插一筆非拉霸入帳 → 餘額遞推鏈斷,累積值不連續,該列要標註。
    const r = report('pass', [
      st(0, '轉軸畫面', 'spin', { bet: 10, win: 0, balance: 990, spun: true }),
      st(1, '轉軸畫面', 'reward', { non_slot_credit: 500 }),
      st(2, '轉軸畫面', 'spin', { bet: 10, win: 0, balance: 1480, spun: true }),
      st(3, '轉軸畫面', 'done'),
    ]);
    const rows = docOf(buildQaDocumentSet(r).documents, 'T12').tables.find((t) => t.id === 'per_run')!.rows;
    expect(rows).toHaveLength(2);
    expect(rows[1]!['note']).toContain('累積值不連續');
  });
});

describe('T03 keeps both platform columns', () => {
  test('platform A carries this run, platform B is explicitly not tested', () => {
    const r = report('pass', crashSteps());
    const t03 = docOf(buildQaDocumentSet(r).documents, 'T03');
    const keys = t03.tables[0]!.columns.map((c) => c.key);
    expect(keys).toContain('resultA');
    expect(keys).toContain('resultB');
    expect(keys).toContain('executor');
    expect(keys).toContain('defect');

    for (const row of t03.tables[0]!.rows) expect(row['resultB']).toBe('未測');
    expect(t03.header.find((h) => h.key === 'platformB')?.value).toContain('未測');
    expect(t03.coverage).toBe('derived_with_gaps');
    expect(t03.unfilled.some((u) => u.zh.includes('平台B'))).toBe(true);
  });
});

describe('the engine attaches the projection', () => {
  test('buildStructuredReport includes qaDocs and keeps it deterministic', () => {
    const steps = crashSteps();
    const a = report('pass', steps);
    const b = report('pass', steps);
    expect(a.qaDocs?.documents).toHaveLength(19);
    expect(a.qaDocs?.generatedAt).toBe(b.qaDocs?.generatedAt);
    expect(JSON.stringify(a.qaDocs)).toBe(JSON.stringify(b.qaDocs));
  });
});
