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
    expect(p.releaseRules.map((r) => r.metric).sort()).toEqual(['balance_mismatch_count', 'casino_rounds']);
    expect(p.riskRules.map((r) => r.metric).sort()).toEqual(['balance_mismatch_count', 'bet_out_of_range_count']);
    expect(p.thresholds).toMatchObject({ casinoMinRounds: 100 });
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
