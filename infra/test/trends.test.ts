import { describe, it, expect } from 'vitest';
import { computeCaseTrend, triageHint, type RunPoint } from '../lambda/api/trends.js';

function pt(
  jobId: string,
  state: RunPoint['state'],
  artifactVersion: string,
  createdAt: string,
): RunPoint {
  return { jobId, state, artifactVersion, createdAt };
}

describe('案例趨勢(Req 12.1)', () => {
  it('計算通過率並回最近 N 次(新→舊)', () => {
    const trend = computeCaseTrend('app-1', 'case-1', [
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z'),
      pt('j2', 'fail', 'v1', '2026-09-02T00:00:00Z'),
      pt('j3', 'pass', 'v1', '2026-09-03T00:00:00Z'),
    ]);
    expect(trend.total).toBe(3);
    expect(trend.passCount).toBe(2);
    expect(trend.failCount).toBe(1);
    expect(trend.passRate).toBeCloseTo(2 / 3);
    // 最近一次(新→舊)應是 j3。
    expect(trend.recent[0]!.jobId).toBe('j3');
  });

  it('error 不計入通過率(僅 pass/fail 為確定性訊號)', () => {
    const trend = computeCaseTrend('app-1', 'case-1', [
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z'),
      pt('j2', 'error', 'v1', '2026-09-02T00:00:00Z'),
    ]);
    expect(trend.errorCount).toBe(1);
    expect(trend.passRate).toBe(1); // 1 pass / 1 deterministic
  });

  it('無確定性結果時 passRate 為 null', () => {
    const trend = computeCaseTrend('app-1', 'case-1', [
      pt('j1', 'error', 'v1', '2026-09-01T00:00:00Z'),
      pt('j2', 'queued', 'v1', '2026-09-02T00:00:00Z'),
    ]);
    expect(trend.passRate).toBeNull();
  });
});

describe('flaky 偵測(Req 12.2)', () => {
  it('同一被測版本下 pass 與 fail 皆出現 → flaky', () => {
    const trend = computeCaseTrend('app-1', 'case-1', [
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z'),
      pt('j2', 'fail', 'v1', '2026-09-02T00:00:00Z'),
      pt('j3', 'pass', 'v1', '2026-09-03T00:00:00Z'),
    ]);
    expect(trend.flaky).toBe(true);
    expect(trend.flakyReason).toContain('v1');
  });

  it('確定性 fail(同版本一路 fail)→ 不 flaky(是真缺陷)', () => {
    const trend = computeCaseTrend('app-1', 'case-1', [
      pt('j1', 'fail', 'v1', '2026-09-01T00:00:00Z'),
      pt('j2', 'fail', 'v1', '2026-09-02T00:00:00Z'),
    ]);
    expect(trend.flaky).toBe(false);
  });

  it('跨版本的 pass→fail(可能真回歸)不判 flaky', () => {
    // v1 全 pass、v2 全 fail:被測有變更,是回歸不是 flaky。
    const trend = computeCaseTrend('app-1', 'case-1', [
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z'),
      pt('j2', 'pass', 'v1', '2026-09-02T00:00:00Z'),
      pt('j3', 'fail', 'v2', '2026-09-03T00:00:00Z'),
      pt('j4', 'fail', 'v2', '2026-09-04T00:00:00Z'),
    ]);
    expect(trend.flaky).toBe(false);
  });

  it('error 反覆不觸發 flaky(非 App 行為訊號)', () => {
    const trend = computeCaseTrend('app-1', 'case-1', [
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z'),
      pt('j2', 'error', 'v1', '2026-09-02T00:00:00Z'),
    ]);
    expect(trend.flaky).toBe(false);
  });
});

describe('成因引導(Req 12.3)', () => {
  it('fail → 被測 App/案例;error → 環境/基礎設施', () => {
    expect(triageHint('fail')).toBe('app-or-case');
    expect(triageHint('error')).toBe('infra');
    expect(triageHint('pass')).toBe('none');
  });
});
