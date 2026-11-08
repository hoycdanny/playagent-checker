import { describe, expect, test } from 'vitest';
import { computeMetric, type MetricContext } from '../lambda/api/report/metrics.js';
import type { EvidenceStep } from '../lambda/api/report/types.js';

/**
 * 新增的三個效能指標。
 *
 * 客戶歷史門檻用過「卡頓率」「穩幀指數」「耗電量 %」,平台原本都算不出來:
 * frame_time_p95 是毫秒不是比率,battery_drain 是 mAh 不是百分比 —— 單位不同不能對門檻。
 * 這組測試釘住計算方式,並確認缺少輸入時回 null 而不是給一個看起來合理的錯數字。
 */

const step = (index: number, perf?: EvidenceStep['perf']): EvidenceStep => ({
  index,
  screen: '轉軸畫面',
  action: 'wait',
  ...(perf ? { perf } : {}),
});

const ctx = (steps: EvidenceStep[], over: Partial<MetricContext> = {}): MetricContext =>
  ({ steps, values: {}, thresholds: {}, ...over } as unknown as MetricContext);

const calc = (fn: string, c: MetricContext) => computeMetric({ kind: 'builtin', fn }, c);

describe('卡頓率', () => {
  test('是幀時間達到界線的幀數佔比,不是毫秒值', () => {
    // 100 幀:10 幀 40ms(≥32 界線)、90 幀 16ms → 10%
    const c = ctx([step(1, { frameHist: { 40: 10, 16: 90 } })]);
    expect(calc('stutter_rate', c)).toBe(10);
  });

  test('界線可由知識庫覆寫,對齊客戶自己的卡頓定義', () => {
    const hist = { 20: 50, 40: 50 };
    // 預設 32ms:只有 40ms 那半算卡頓 → 50%
    expect(calc('stutter_rate', ctx([step(1, { frameHist: hist })]))).toBe(50);
    // 界線降到 20ms:兩邊都算 → 100%
    expect(calc('stutter_rate', ctx([step(1, { frameHist: hist })], { thresholds: { stutterFrameMs: 20 } }))).toBe(100);
    // 界線拉到 50ms:都不算 → 0%
    expect(calc('stutter_rate', ctx([step(1, { frameHist: hist })], { thresholds: { stutterFrameMs: 50 } }))).toBe(0);
  });

  test('界線值本身算卡頓(≥,不是 >)', () => {
    expect(calc('stutter_rate', ctx([step(1, { frameHist: { 32: 1 } })]))).toBe(100);
    expect(calc('stutter_rate', ctx([step(1, { frameHist: { 31: 1 } })]))).toBe(0);
  });

  test('多個取樣的直方圖會合併', () => {
    const c = ctx([step(1, { frameHist: { 40: 10 } }), step(2, { frameHist: { 16: 30 } })]);
    expect(calc('stutter_rate', c)).toBe(25); // 10 / 40
  });

  test('沒有幀資料回 null,不回 0%', () => {
    expect(calc('stutter_rate', ctx([step(1, { cpuPct: 50 })]))).toBeNull();
    expect(calc('stutter_rate', ctx([]))).toBeNull();
  });
});

describe('幀時間標準差', () => {
  test('完全穩定的幀時間 → 0', () => {
    expect(calc('frame_time_stddev', ctx([step(1, { frameHist: { 16: 100 } })]))).toBe(0);
  });

  test('一半快一半慢 → 等於離均值的距離', () => {
    // 50 幀 10ms(桶中點 10.5)、50 幀 20ms(20.5);均值 15.5,每筆離均值 5 → σ = 5
    expect(calc('frame_time_stddev', ctx([step(1, { frameHist: { 10: 50, 20: 50 } })]))).toBe(5);
  });

  test('越分散,值越大', () => {
    const tight = calc('frame_time_stddev', ctx([step(1, { frameHist: { 15: 50, 17: 50 } })]))!;
    const loose = calc('frame_time_stddev', ctx([step(1, { frameHist: { 5: 50, 100: 50 } })]))!;
    expect(loose).toBeGreaterThan(tight);
  });

  test('沒有幀資料回 null', () => {
    expect(calc('frame_time_stddev', ctx([step(1, { fps: 60 })]))).toBeNull();
  });
});

describe('耗電百分比', () => {
  test('耗電 mAh ÷ 電池容量', () => {
    const c = ctx([step(1, { batteryMah: 400 })], { perfMeta: { batteryCapacityMah: 4000 } });
    expect(calc('battery_drain_pct', c)).toBe(10);
  });

  test('容量未知時回 null —— 不能把 mAh 當百分比去對「耗電 < 10%」', () => {
    const c = ctx([step(1, { batteryMah: 400 })]);
    expect(calc('battery_drain', c)).toBe(400); // mAh 仍算得出來
    expect(calc('battery_drain_pct', c)).toBeNull(); // 但百分比不行
  });

  test('容量為 0 或負數視為未知,不做除法', () => {
    for (const cap of [0, -1]) {
      const c = ctx([step(1, { batteryMah: 400 })], { perfMeta: { batteryCapacityMah: cap } });
      expect(calc('battery_drain_pct', c)).toBeNull();
    }
  });

  test('沒有耗電資料時回 null', () => {
    const c = ctx([step(1, { cpuPct: 20 })], { perfMeta: { batteryCapacityMah: 4000 } });
    expect(calc('battery_drain_pct', c)).toBeNull();
  });
});
