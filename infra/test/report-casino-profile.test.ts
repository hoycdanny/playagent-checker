import { describe, expect, test } from 'vitest';
import { getGenreProfile, mergeProfiles } from '../lambda/api/report/profiles.js';
import { computeMetric, type MetricContext } from '../lambda/api/report/metrics.js';
import type { EvidenceStep } from '../lambda/api/report/types.js';

const step = (obs: Record<string, unknown>): EvidenceStep => ({ index: 1, screen: 's', action: 'tap', obs } as unknown as EvidenceStep);
const ctx = (steps: EvidenceStep[]): MetricContext => ({ steps, values: {} } as unknown as MetricContext);

describe('obs_distinct_count(玩過幾種玩法)', () => {
  const calc = { kind: 'obs_distinct_count', key: 'game_kind' } as const;

  test('算不同值的個數,大小寫與前後空白視為同一種', () => {
    const v = computeMetric(calc, ctx([
      step({ game_kind: 'roulette' }),
      step({ game_kind: 'Roulette ' }),
      step({ game_kind: 'blackjack' }),
      step({ game_kind: 'SICBO' }),
    ]));
    expect(v).toBe(3);
  });

  // 0 會被讀成「一種玩法都沒玩」,那是錯的 —— 沒人回報過這個欄位就是「未覆蓋」。
  test('從來沒回報過這個欄位 → null(未覆蓋),不是 0', () => {
    expect(computeMetric(calc, ctx([step({ bet: 10 })]))).toBeNull();
    expect(computeMetric(calc, ctx([]))).toBeNull();
  });

  test('空字串與 null 不算一種', () => {
    expect(computeMetric(calc, ctx([step({ game_kind: '' }), step({ game_kind: null })]))).toBeNull();
    expect(computeMetric(calc, ctx([step({ game_kind: '' }), step({ game_kind: 'fish' })]))).toBe(1);
  });
});

describe('casino 類型樣板', () => {
  const p = getGenreProfile('casino')!;

  test('觀測欄位沿用 slot 的 bet/win/balance key(才能重用既有的餘額對帳 builtin)', () => {
    const keys = p.observe.map((o) => o.key);
    expect(keys).toEqual(expect.arrayContaining(['bet', 'win', 'balance', 'round_settled', 'game_kind']));
    expect(p.observe.find((o) => o.key === 'round_settled')!.type).toBe('boolean');
    expect(p.observe.find((o) => o.key === 'game_kind')!.type).toBe('string');
  });

  test('有樣本量、覆蓋與下注範圍的指標', () => {
    const ids = p.metrics.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([
      'casino_rounds', 'games_played', 'total_bet', 'total_win',
      'bet_min_seen', 'bet_max_seen', 'balance_checks', 'balance_accuracy',
      'balance_mismatch_count', 'bet_out_of_range_count',
    ]));
    expect(p.version).toBe('1.1');
  });

  // 政策②:遊戲設計規格一律留空,沒填就不判定。
  test('標稱返還率是規格值(留空給客戶填),不是門檻', () => {
    const spec = (p.specValues ?? []).map((v) => v.key);
    expect(spec).toContain('nominalReturnPct');
    expect(Object.keys(p.thresholds ?? {})).not.toContain('nominalReturnPct');
  });

  // 政策①:只有技術硬指標與樣本量參與判定。
  test('判定只用技術硬指標與局數,不用任何類型參考值', () => {
    expect(p.releaseRules.map((r) => r.metric).sort()).toEqual(['balance_accuracy', 'casino_rounds']);
    expect(p.riskRules.map((r) => r.metric).sort()).toEqual(['balance_accuracy', 'bet_out_of_range_count']);
    expect(p.thresholds).toMatchObject({ casinoMinRounds: 100, balanceAccuracyMin: 98 });
  });

  // 逐局數字是 AI 讀畫面來的,偶發讀錯在所難免。看「不符次數 > 0」會讓一次讀錯就判 critical,
  // 和驗收引擎(≥3 次且佔比 >20% 才算遊戲缺陷)結論相反 —— job-mvfcpfig 實測踩到。
  test('餘額判定看正確率而不是不符次數(與驗收引擎同一個判準)', () => {
    expect(p.riskRules.find((r) => r.id === 'balance_mismatch')).toMatchObject({
      metric: 'balance_accuracy', op: '<', value: { threshold: 'balanceAccuracyMin' },
    });
    expect(p.releaseRules.map((r) => r.metric)).not.toContain('balance_mismatch_count');
  });

  // 政策③的核心保證:參考區間的指標不得出現在任何判定規則裡。
  test('參考區間的指標絕不出現在風險 / 放行規則中', () => {
    const bandMetrics = (p.referenceBands ?? []).map((b) => b.metric);
    expect(bandMetrics).toEqual(expect.arrayContaining(['games_played', 'balance_checks', 'casino_rounds']));
    const ruleMetrics = new Set([...p.riskRules, ...p.releaseRules].map((r) => r.metric));
    // casino_rounds 例外:它同時是樣本量門檻(①),但那條規則只會讓結論變成
    // INSUFFICIENT_TESTING(資料不足),不會判遊戲不合格。
    for (const m of bandMetrics.filter((x) => x !== 'casino_rounds')) {
      expect(ruleMetrics.has(m), `${m} 不該參與判定`).toBe(false);
    }
    const roundsRule = p.releaseRules.find((r) => r.metric === 'casino_rounds')!;
    expect(roundsRule.outcome).toBe('INSUFFICIENT_TESTING');
  });

  test('每條參考區間都寫明「不是驗收標準」', () => {
    for (const b of p.referenceBands ?? []) {
      expect(b.note.zh, b.metric).toMatch(/不是驗收標準|不作為判定|只代表/);
      expect(b.note.en, b.metric).toBeTruthy();
    }
  });
});

describe('slot 類型樣板:機台覆蓋與 RTP 樣本量', () => {
  const p = getGenreProfile('slot')!;

  // 2026-10 實測:同一款遊戲各跑 50 局,RTP 分別算出 20.68% / 662.65% / 579.85%。
  // 那不是 bug 而是 50 局的統計極限,報告必須講出這件事而不是把 662% 當結論。
  test('局數不足時提醒 RTP 不會收斂,而且不參與判定', () => {
    const band = (p.referenceBands ?? []).find((b) => b.metric === 'spin_count')!;
    expect(band.min).toBe(1000);
    expect(band.note.zh).toMatch(/收斂|信賴區間/);
    expect(band.note.zh).toContain('不是驗收標準');
    // 判定仍然只看 rtp_significant_deviation_pp(它自己有 rtpMinSamples 把關)
    expect([...p.riskRules, ...p.releaseRules].map((r) => r.metric)).not.toContain('spin_count');
  });

  // 區間語意是「低於 min 或高於 max 才提醒」,所以「只玩一台」要寫成 min: 2。
  // 寫 max: 1 的話剛好 1 台會落在範圍內而永遠不觸發(實測 job-mvfcpfig 抓到過)。
  test('只玩一台機台時說明取樣範圍(大廳型 App 每台數學模型不同)', () => {
    const band = (p.referenceBands ?? []).find((b) => b.metric === 'machines_played')!;
    expect(band.min).toBe(2);
    expect(band.max).toBeUndefined();
    expect(band.note.zh).toContain('不是驗收標準');
    expect(p.observe.map((o) => o.key)).toContain('machine_kind');
    expect(p.observe.find((o) => o.key === 'machine_kind')!.type).toBe('string');
    expect(p.metrics.map((m) => m.id)).toContain('machines_played');
  });

  test('機台覆蓋數不參與判定', () => {
    expect([...p.riskRules, ...p.releaseRules].map((r) => r.metric)).not.toContain('machines_played');
  });

  test('餘額判定改看正確率,少量不符降級為判讀提醒', () => {
    expect(p.riskRules.find((r) => r.id === 'balance_mismatch')).toMatchObject({
      metric: 'balance_accuracy', op: '<', value: { threshold: 'balanceAccuracyMin' },
    });
    expect(p.thresholds).toMatchObject({ balanceAccuracyMin: 98 });
    expect([...p.riskRules, ...p.releaseRules].map((r) => r.metric)).not.toContain('balance_mismatch_count');
    const band = (p.referenceBands ?? []).find((b) => b.metric === 'balance_mismatch_count')!;
    expect(band.max).toBe(0);
    expect(band.note.zh).toContain('不是驗收標準');
  });

  test('版本跟著內容一起升(內建知識庫的版本是從這裡來的)', () => {
    expect(p.version).toBe('1.3');
  });
});

/**
 * 經濟類數字的來源優先序。job-mvfcpfig 實測:同一次測試,SPIN 迴圈逐局帳算 21.74%、
 * 從 steps 重建算 15.79%,而報告只用了重建的那個 —— 封面訊息與指標表對不上。
 */
describe('observed_rtp / spin_count 的來源優先序', () => {
  const ctxWith = (spinLoop?: MetricContext['spinLoop']): MetricContext =>
    ({ steps: [], values: {}, ...(spinLoop ? { spinLoop } : {}) } as unknown as MetricContext);
  const loop = { rounds: 50, totalBet: 165000, totalWin: 35875, rtpPercent: 21.74 };

  test('有 SPIN 迴圈逐局帳時以它為準(每局都等停輪才讀,品質最高)', () => {
    const c = ctxWith(loop);
    expect(computeMetric({ kind: 'builtin', fn: 'observed_rtp' }, c)).toBe(21.74);
    expect(computeMetric({ kind: 'builtin', fn: 'spin_count' }, c)).toBe(50);
    expect(computeMetric({ kind: 'builtin', fn: 'total_bet' }, c)).toBe(165000);
    expect(computeMetric({ kind: 'builtin', fn: 'total_win' }, c)).toBe(35875);
  });

  test('沒有迴圈帳時退回原本的重建算法(舊任務不受影響)', () => {
    const c = ctxWith();
    // steps 為空 → 重建不出交易 → null(未覆蓋),而不是 0
    expect(computeMetric({ kind: 'builtin', fn: 'observed_rtp' }, c)).toBeNull();
  });
});

describe('mergeProfiles', () => {
  test('參考區間會跟著合併(通用 + 類型)', () => {
    const m = mergeProfiles(['casino']);
    expect((m.referenceBands ?? []).map((b) => b.metric)).toEqual(
      expect.arrayContaining(['games_played', 'balance_checks', 'casino_rounds']),
    );
  });

  test('沒有參考區間的類型合併後是空陣列,不是 undefined', () => {
    expect(mergeProfiles(['puzzle']).referenceBands).toEqual([]);
  });

  test('casino 的觀測欄位與指標都進得了合併結果', () => {
    const m = mergeProfiles(['casino']);
    expect(m.observe.map((o) => o.key)).toEqual(expect.arrayContaining(['round_settled', 'game_kind']));
    expect(m.metrics.map((x) => x.id)).toEqual(expect.arrayContaining(['casino_rounds', 'games_played']));
  });
});
