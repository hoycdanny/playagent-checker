import { describe, expect, test } from 'vitest';
import { insightsInput, sanitizeInsights } from '../lambda/api/report/insights.js';
import type { StructuredReport } from '../lambda/api/report/types.js';

const L = (s: string) => ({ zh: s, en: s });

const metric = (id: string, profile: string, value: number | null, status: 'ok' | 'not_collected' = 'ok') => ({
  id, label: L(id), unit: 'count', group: 'genre', source: 'objective', value, status, profile,
});

/** 最小可用的結構化報告(只填 insightsInput / sanitizeInsights 真的會讀的欄位)。 */
function fixture(over: Partial<Record<string, unknown>> = {}): StructuredReport {
  const base = {
    header: { gameName: 'FaFaFa', genre: 'slot', platform: 'android', device: 'S23' },
    overallStatus: 'PASS',
    statusReason: L('通過'),
    terminal: { state: 'pass' },
    release: {
      readiness: 'READY_WITH_RISK',
      hits: [{ ruleId: 'REL-RTP', outcome: 'READY_WITH_RISK', metric: 'observed_rtp', reason: L('RTP 偏離標稱值') }],
      thresholds: { rtp_deviation_pp: 5, min_spins: 100 },
    },
    summaryLines: [L('共 50 局')],
    counts: { totalChecks: 1, executedChecks: 1, passed: 1, failed: 0, unclear: 0, blocked: 0, skipped: 0, passRate: 100, executionRate: 100, defects: {} },
    // 刻意把通用指標放前面:輸出要被重排成「類型專屬優先」。
    metrics: [
      metric('tokens_total', 'global', 12345),
      metric('observed_rtp', 'slot', 579.85),
      metric('spin_count', 'slot', 50),
      metric('fps_avg', 'global', null, 'not_collected'),
      metric('autospin_rtp', 'slot', null),
    ],
    dashboard: [{ dimension: 'economy', score: 70, executed: true, findingCount: 0, metrics: [] }],
    scope: [],
    coverage: { feature: [{ covered: true }, { covered: false }], mechanic: [{ covered: true }], gameState: [], scenario: [], device: [] },
    modules: [],
    mechanics: [],
    testCase: { name: '完成50次拉霸機', category: 'test', testSteps: '1. 按 SPIN', expectedResult: '餘額正確' },
    checks: [{ id: 'CHK-1', result: 'pass', title: L('ok') }],
    findings: [{ id: 'DEF-001', title: L('x'), classification: 'game', severity: 'high', category: 'economy', description: L('d'), firstStep: 1, lastStep: 2, frequency: 1 }],
    aiFailures: [],
    risks: [{ id: 'RISK-1', level: 'high', title: L('RTP 異常'), evidence: L('observed_rtp=579.85'), impact: L('營收'), relatedSteps: [], relatedFindings: [] }],
    charts: [],
    sections: [],
    profiles: [{ id: 'global', version: '1.0', label: L('通用') }, { id: 'slot', version: '1.2', label: L('拉霸') }],
    spec: { values: { nominal_rtp: 96 }, sources: ['kb-builtin-slot'] },
    evidence: [{ index: 1, screen: '轉軸', action: 'tap' }, { index: 2, screen: '結果', action: 'tap' }],
    notes: [],
    ...over,
  };
  return base as unknown as StructuredReport;
}

describe('insightsInput — 把算出來的數字餵給模型', () => {
  const r = fixture();
  const input = insightsInput(r) as Record<string, any>;

  // 這是這次改動的核心:原本完全沒送 metrics,模型是在沒看到數字的情況下寫總結。
  test('送出有量到的指標,而且類型專屬的排在通用的前面', () => {
    const ids = input['metrics'].map((m: any) => m.id);
    expect(ids).toContain('observed_rtp');
    expect(ids).toContain('spin_count');
    expect(ids).toContain('tokens_total');
    // slot 的兩個要在 global 的前面
    expect(ids.indexOf('observed_rtp')).toBeLessThan(ids.indexOf('tokens_total'));
    expect(ids.indexOf('spin_count')).toBeLessThan(ids.indexOf('tokens_total'));
  });

  test('沒量到的指標不混進數字裡,而是單獨列出(避免被當成 0)', () => {
    const ids = input['metrics'].map((m: any) => m.id);
    expect(ids).not.toContain('fps_avg');
    expect(ids).not.toContain('autospin_rtp'); // status ok 但 value 為 null
    expect(input['metricsNotCollected']).toEqual(expect.arrayContaining(['fps_avg', 'autospin_rtp']));
  });

  test('帶上門檻、規格值、觸發的放行規則與套用的樣板', () => {
    expect(input['thresholds']).toEqual({ rtp_deviation_pp: 5, min_spins: 100 });
    expect(input['spec']).toEqual({ values: { nominal_rtp: 96 }, sources: ['kb-builtin-slot'] });
    expect(input['releaseHits'][0]).toMatchObject({ ruleId: 'REL-RTP', metric: 'observed_rtp' });
    // 樣板版本要帶,模型才知道是用哪一版類型標準在看
    expect(input['profiles']).toEqual([
      { id: 'global', version: '1.0', label: '通用' },
      { id: 'slot', version: '1.2', label: '拉霸' },
    ]);
  });

  test('覆蓋率摘要與風險清單都是精簡形式(控制 token)', () => {
    expect(input['coverage']).toEqual({ feature: '1/2', mechanic: '1/1' });
    expect(input['risks'][0]).toMatchObject({ id: 'RISK-1', level: 'high', title: 'RTP 異常' });
    // 風險不要整個物件塞進去(relatedSteps / L10n 都是雜訊)
    expect(input['risks'][0]).not.toHaveProperty('relatedSteps');
  });

  test('指標被截斷時要讓模型知道還有多少沒看到', () => {
    const many = Array.from({ length: 80 }, (_, i) => metric(`m${i}`, 'global', i));
    const big = insightsInput(fixture({ metrics: many })) as Record<string, any>;
    expect(big['metrics'].length).toBe(60);
    expect(big['metricsOmitted']).toBe(20);
  });
});

describe('sanitizeInsights — watchouts(需要注意的點)', () => {
  const r = fixture();

  test('字串與 { zh, en } 兩種形式都收', () => {
    const out = sanitizeInsights(
      { watchouts: ['observed_rtp 579.85% 遠高於標稱 96%', { zh: 'spin_count 僅 50 局,樣本不足', en: 'only 50 spins' }] },
      r, 'm', new Date(), 'zh',
    );
    expect(out.watchouts).toHaveLength(2);
    expect(out.watchouts[0]!.zh).toContain('579.85');
    expect(out.watchouts[1]!.en).toBe('only 50 spins');
  });

  test('去重、丟空值、最多 6 條', () => {
    const out = sanitizeInsights(
      { watchouts: ['A', 'A', '', '   ', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] },
      r, 'm', new Date(), 'zh',
    );
    expect(out.watchouts.map((w) => w.zh)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  // 舊的快取檔與不聽話的模型都不能讓整份分析掛掉。
  test('模型沒給 watchouts 時回空陣列,不是 undefined', () => {
    expect(sanitizeInsights({ summary: 'x' }, r, 'm').watchouts).toEqual([]);
    expect(sanitizeInsights({ watchouts: 'not-an-array' }, r, 'm').watchouts).toEqual([]);
    expect(sanitizeInsights({}, r, 'm').watchouts).toEqual([]);
  });

  test('summary 缺漏時退回程式算出的結論(不留空)', () => {
    expect(sanitizeInsights({}, r, 'm').summary.zh).toBe('通過');
  });
});
