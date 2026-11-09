import { describe, expect, test } from 'vitest';
import {
  applyFindingOverrides,
  hasOverrides,
  isUsableOverride,
  overrideSummary,
} from '../lambda/api/report/findingOverrides.js';
import { buildStructuredReport } from '../lambda/api/report/engine.js';
import type { Finding, FindingOverride } from '../lambda/api/report/types.js';

/**
 * 缺陷的人工覆寫。
 *
 * 這組測試守的是三條不可退讓的規則 —— 它們決定覆寫是「可追溯的另一種主張」
 * 還是「偽造證據」:
 *   1. 原判定永久保留。
 *   2. 沒有理由或沒有覆寫者的覆寫一律忽略(報告必須能交代數字為什麼變了)。
 *   3. 標為誤判是降級為待判讀,不是從清單刪除 —— 刪除會讓報告看起來
 *      從來沒發現過這件事。
 */
const L = (zh: string) => ({ zh, en: zh });

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'F-07',
  title: L('大廳機台列表空白'),
  severity: 'high',
  category: 'functional',
  classification: 'GAME_FAILURE',
  certainty: 'ai_evaluation',
  frequency: 3,
  reproducibility: 'frequent',
  stepsToReproduce: [],
  status: 'open',
  ...over,
} as Finding);

const ov = (over: Partial<FindingOverride> = {}): FindingOverride => ({
  findingId: 'F-07',
  reason: '載入中的正常狀態,不是缺陷',
  by: 'tester@example.test',
  at: '2026-11-09T10:00:00.000Z',
  ...over,
});

describe('isUsableOverride:把關', () => {
  test('完整的覆寫可用', () => {
    expect(isUsableOverride(ov({ dismissed: true }))).toBe(true);
    expect(isUsableOverride(ov({ severity: 'low' }))).toBe(true);
    expect(isUsableOverride(ov({ classification: 'GAME_FAILURE' }))).toBe(true);
  });

  test('沒有理由 → 不可用(報告無法交代數字為什麼變了)', () => {
    expect(isUsableOverride(ov({ dismissed: true, reason: '' }))).toBe(false);
    expect(isUsableOverride(ov({ dismissed: true, reason: '   ' }))).toBe(false);
  });

  test('沒有覆寫者 → 不可用(覆寫必須可歸責)', () => {
    expect(isUsableOverride(ov({ dismissed: true, by: '' }))).toBe(false);
  });

  test('什麼都沒改 → 不可用', () => {
    expect(isUsableOverride(ov())).toBe(false);
    expect(isUsableOverride(ov({ dismissed: false }))).toBe(false);
  });

  test('不認識的分類或嚴重性不放行', () => {
    expect(isUsableOverride(ov({ classification: 'WHATEVER' as never }))).toBe(false);
    expect(isUsableOverride(ov({ severity: 'catastrophic' as never }))).toBe(false);
  });

  test('非物件一律不可用', () => {
    for (const x of [null, undefined, 'x', 42, []]) expect(isUsableOverride(x)).toBe(false);
  });
});

describe('套用:原判定永久保留', () => {
  test('改嚴重性時,原值留在 override.original', () => {
    const [f] = applyFindingOverrides([finding()], [ov({ severity: 'low' })]);
    expect(f!.severity).toBe('low');
    expect(f!.override!.original).toEqual({ classification: 'GAME_FAILURE', severity: 'high' });
    expect(f!.override!.reason).toBe('載入中的正常狀態,不是缺陷');
    expect(f!.override!.by).toBe('tester@example.test');
    expect(f!.override!.at).toBe('2026-11-09T10:00:00.000Z');
  });

  test('改分類時也一樣保留原判定', () => {
    const [f] = applyFindingOverrides(
      [finding({ classification: 'NEEDS_TRIAGE' })],
      [ov({ classification: 'GAME_FAILURE', reason: '我重現過,是真的缺陷' })],
    );
    expect(f!.classification).toBe('GAME_FAILURE');
    expect(f!.override!.original.classification).toBe('NEEDS_TRIAGE');
    expect(f!.override!.dismissed).toBe(false);
  });
});

describe('標為誤判:降級而不是刪除', () => {
  test('缺陷仍在清單上,但降為待判讀', () => {
    const out = applyFindingOverrides([finding()], [ov({ dismissed: true })]);
    // 刪除會讓報告看起來從來沒發現過這件事 —— 那是偽造證據
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('F-07');
    expect(out[0]!.classification).toBe('NEEDS_TRIAGE');
    expect(out[0]!.override!.dismissed).toBe(true);
    // 原判定還在,讀者看得到「AI 曾經判為已確認的遊戲缺陷」
    expect(out[0]!.override!.original.classification).toBe('GAME_FAILURE');
  });

  test('標為誤判時忽略同時送來的分類(以誤判為準,不做半套)', () => {
    const out = applyFindingOverrides([finding()], [ov({ dismissed: true, classification: 'ENVIRONMENT' })]);
    expect(out[0]!.classification).toBe('NEEDS_TRIAGE');
  });
});

describe('多筆覆寫', () => {
  test('同一筆缺陷被改多次,以時間最晚的為準', () => {
    const out = applyFindingOverrides([finding()], [
      ov({ dismissed: true, at: '2026-11-09T10:00:00.000Z' }),
      ov({ severity: 'critical', reason: '查過了,確實是缺陷而且更嚴重', at: '2026-11-09T12:00:00.000Z' }),
    ]);
    expect(out[0]!.severity).toBe('critical');
    expect(out[0]!.override!.dismissed).toBe(false);
  });

  test('陣列順序與時間相反時仍以時間為準(儲存順序不保證等於時間順序)', () => {
    const out = applyFindingOverrides([finding()], [
      ov({ severity: 'critical', at: '2026-11-09T12:00:00.000Z' }),
      ov({ dismissed: true, at: '2026-11-09T10:00:00.000Z' }),
    ]);
    expect(out[0]!.severity).toBe('critical');
  });

  test('只影響指名的那一筆,其他缺陷不動', () => {
    const out = applyFindingOverrides(
      [finding({ id: 'F-01' }), finding({ id: 'F-07' })],
      [ov({ findingId: 'F-07', dismissed: true })],
    );
    expect(out[0]!.override).toBeUndefined();
    expect(out[1]!.override).toBeDefined();
  });

  test('指向不存在的缺陷 id 不會造成錯誤或幽靈項目', () => {
    const out = applyFindingOverrides([finding()], [ov({ findingId: 'F-99', dismissed: true })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.override).toBeUndefined();
  });
});

describe('不可用的覆寫被忽略', () => {
  test('沒有理由的覆寫不會改到任何東西', () => {
    const out = applyFindingOverrides([finding()], [ov({ dismissed: true, reason: '' })]);
    expect(out[0]!.classification).toBe('GAME_FAILURE');
    expect(out[0]!.override).toBeUndefined();
  });

  test('沒有覆寫時原陣列原樣回傳', () => {
    const list = [finding()];
    expect(applyFindingOverrides(list, [])).toBe(list);
    expect(applyFindingOverrides(list, undefined)).toBe(list);
  });
});

describe('摘要', () => {
  test('分別數出標為誤判與改判的件數', () => {
    const out = applyFindingOverrides(
      [finding({ id: 'F-01' }), finding({ id: 'F-02' }), finding({ id: 'F-03' })],
      [
        ov({ findingId: 'F-01', dismissed: true }),
        ov({ findingId: 'F-02', severity: 'low' }),
      ],
    );
    expect(hasOverrides(out)).toBe(true);
    expect(overrideSummary(out)).toEqual({ total: 2, dismissed: 1, reclassified: 1 });
  });

  test('沒有覆寫時摘要全為 0,且 hasOverrides 為假', () => {
    const out = [finding()];
    expect(hasOverrides(out)).toBe(false);
    expect(overrideSummary(out)).toEqual({ total: 0, dismissed: 0, reclassified: 0 });
  });
});

// ───────────────────── 接進引擎:判定是否真的重算 ─────────────────────

/**
 * 這一段是「單一套用點」設計的全部理由。
 *
 * findings 會餵給驗收條件(AC-G02 當機、AC-G03 嚴重缺陷)、品質儀表板、
 * 模組統計、指標與放行規則。覆寫只在 findings 剛組好時套用一次,所以整條
 * 判定鏈應該自然跟著變 —— 如果這些測試過不了,就代表某個消費端讀的是
 * 另一份未覆寫的資料,那會造成「某幾個數字算進覆寫、某幾個沒算」的報告。
 */
describe('接進引擎:覆寫後判定重算', () => {
  /**
   * 製造一次「疑似閃退」的執行。
   *
   * 觸發條件取自引擎本身(不是猜的):某一步 foregroundLost 為真、
   * 上一步動作不是 launch/back、而且 appState <= 1 且有值 ——
   * appState 為 undefined 時只會判成待判讀,不是已確認的遊戲缺陷。
   */
  const crashRun = (overrides?: FindingOverride[]) =>
    buildStructuredReport({
      raw: {
        state: 'fail',
        task: '探索遊戲',
        steps: [
          { index: 0, screen: '大廳', action: 'tap', x: 5, y: 5 },
          { index: 1, screen: '大廳', action: 'tap', x: 5, y: 5, prevAction: 'tap', foregroundLost: true, appState: 0 },
          { index: 2, screen: '大廳', action: 'done' },
        ],
      },
      job: { jobId: 'job-test' },
      app: { genre: 'slot' },
      ...(overrides ? { overrides } : {}),
    } as never);

  test('未覆寫時:當機被判為已確認的遊戲缺陷', () => {
    const r = crashRun();
    const crash = r.findings.find((f) => f.category === 'crash');
    expect(crash, '這個情境應該要產生當機缺陷').toBeDefined();
    expect(crash!.classification).toBe('GAME_FAILURE');
    expect(r.counts.defects.critical).toBeGreaterThan(0);
  });

  test('標為誤判後:缺陷統計與驗收條件一起變,不是只有缺陷卡片變', () => {
    const before = crashRun();
    const crash = before.findings.find((f) => f.category === 'crash')!;

    const after = crashRun([{
      findingId: crash.id,
      dismissed: true,
      reason: '裝置被系統回收,不是遊戲崩潰',
      by: 'tester@example.test',
      at: '2026-11-09T10:00:00.000Z',
    }]);

    // 1. 缺陷降級、原判定保留
    const sameFinding = after.findings.find((f) => f.id === crash.id)!;
    expect(sameFinding.classification).toBe('NEEDS_TRIAGE');
    expect(sameFinding.override!.original.classification).toBe('GAME_FAILURE');

    // 2. 重大缺陷統計跟著降
    expect(after.counts.defects.critical).toBeLessThan(before.counts.defects.critical);

    // 3. 驗收條件也要重算(AC-G02 當機)—— 這一條若沒過,代表 acceptance
    //    讀的是未覆寫的 findings
    const acBefore = before.acceptance.criteria.find((c) => c.id === 'AC-G02')!;
    const acAfter = after.acceptance.criteria.find((c) => c.id === 'AC-G02')!;
    expect(acBefore.result).toBe('fail');
    expect(acAfter.result, 'AC-G02 應隨覆寫重算').not.toBe('fail');
  });

  test('報告要明文標示含人工覆寫,不能靜默重算', () => {
    const before = crashRun();
    expect(before.release.overrides, '沒有覆寫時不該多一個 0 欄位').toBeUndefined();
    expect(before.notes.some((n) => n.zh.includes('人工覆寫'))).toBe(false);

    const crash = before.findings.find((f) => f.category === 'crash')!;
    const after = crashRun([{
      findingId: crash.id, dismissed: true, reason: '環境問題', by: 'tester@example.test',
      at: '2026-11-09T10:00:00.000Z',
    }]);

    expect(after.release.overrides).toEqual({ total: 1, dismissed: 1, reclassified: 0 });
    const note = after.notes.find((n) => n.zh.includes('人工覆寫'));
    expect(note, '必須有一條說明,讀者才知道統計含人為調整').toBeDefined();
    expect(note!.zh).toContain('已依覆寫後的值重算');
    expect(note!.zh).toContain('原判定');
  });

  test('改判嚴重性也會影響統計', () => {
    const before = crashRun();
    const crash = before.findings.find((f) => f.category === 'crash')!;
    const after = crashRun([{
      findingId: crash.id, severity: 'low', reason: '只在這一台裝置偶發,影響有限',
      by: 'tester@example.test', at: '2026-11-09T10:00:00.000Z',
    }]);
    expect(after.counts.defects.critical).toBeLessThan(before.counts.defects.critical);
    expect(after.counts.defects.low).toBeGreaterThan(before.counts.defects.low);
    expect(after.release.overrides).toEqual({ total: 1, dismissed: 0, reclassified: 1 });
  });
});
