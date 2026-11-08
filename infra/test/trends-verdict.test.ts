import { describe, expect, it } from 'vitest';
import { computeCaseTrend, computeRetestChain, runSignal, type RunPoint } from '../lambda/api/trends.js';
import type { Verdict } from '../lambda/api/tasks.js';

/**
 * 趨勢與 flaky 必須讀「測試結論」,不是「執行結果」。
 *
 * 驗收標準 §1 把兩者分開:state 只代表 AI 有沒有走完流程,「執行完成」不等於通過。
 * 混用過去造成過「列表通過、報告失敗」的矛盾,這組測試把那個界線釘住。
 */

const pt = (
  jobId: string,
  state: RunPoint['state'],
  artifactVersion: string,
  createdAt: string,
  verdict?: Verdict,
): RunPoint => ({ jobId, state, artifactVersion, createdAt, ...(verdict ? { verdict } : {}) });

const trend = (points: RunPoint[]) => computeCaseTrend('app-1', 'case-1', points);

describe('結果訊號優先採用測試結論', () => {
  it('執行完成但結論失敗 → 算失敗,不算通過', () => {
    const sig = runSignal(pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z', 'FAIL'));
    expect(sig).toEqual({ outcome: 'fail', basis: 'verdict' });
  });

  it('通過(有風險)仍算通過:必要項目全過', () => {
    expect(runSignal(pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z', 'PASS_WITH_RISK')).outcome).toBe('pass');
  });

  it('受阻是獨立狀態,不是通過也不是失敗', () => {
    expect(runSignal(pt('j1', 'fail', 'v1', '2026-09-01T00:00:00Z', 'BLOCKED')).outcome).toBe('blocked');
  });

  it('沒有結論才退回執行結果,並標明依據', () => {
    expect(runSignal(pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z'))).toEqual({ outcome: 'pass', basis: 'execution_state' });
    expect(runSignal(pt('j2', 'error', 'v1', '2026-09-01T00:00:00Z'))).toEqual({ outcome: 'none', basis: 'execution_state' });
  });
});

describe('通過率依結論計算', () => {
  it('執行完成但結論失敗的那次,不會把通過率拉高', () => {
    const t = trend([
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z', 'PASS'),
      pt('j2', 'pass', 'v1', '2026-09-02T00:00:00Z', 'FAIL'),
    ]);
    expect(t.passCount).toBe(1);
    expect(t.failCount).toBe(1);
    expect(t.passRate).toBe(0.5);
  });

  it('受阻不進分母:那次測試沒有得出結果', () => {
    const t = trend([
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z', 'PASS'),
      pt('j2', 'fail', 'v1', '2026-09-02T00:00:00Z', 'BLOCKED'),
    ]);
    expect(t.blockedCount).toBe(1);
    expect(t.passRate).toBe(1); // 1 / (1 + 0)
    expect(t.total).toBe(2);
  });

  it('最近結果序列帶出結論與依據(UI 的結果點靠這個,不是 state)', () => {
    const t = trend([
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z', 'FAIL'),
      pt('j2', 'pass', 'v1', '2026-09-02T00:00:00Z'),
    ]);
    // 新→舊
    expect(t.recent.map((r) => [r.jobId, r.outcome, r.basis])).toEqual([
      ['j2', 'pass', 'execution_state'],
      ['j1', 'fail', 'verdict'],
    ]);
    // state 仍保留供排錯對照,但它和結論可以不一致 —— 這正是不能拿它畫結果點的原因。
    expect(t.recent.find((r) => r.jobId === 'j1')!.state).toBe('pass');
  });

  it('判定依據的組成要外顯', () => {
    const mixed = trend([
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z', 'PASS'),
      pt('j2', 'pass', 'v1', '2026-09-02T00:00:00Z'),
    ]);
    expect(mixed.verdictCoverage).toMatchObject({ withVerdict: 1, total: 2 });
    expect(mixed.verdictCoverage.note).toContain('依據混雜');

    const allVerdict = trend([pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z', 'PASS')]);
    expect(allVerdict.verdictCoverage.note).toContain('全部依測試結論');

    const none = trend([pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z')]);
    expect(none.verdictCoverage.note).toContain('執行完成不等於通過');
  });
});

describe('flaky 不會因為依據混雜而憑空出現', () => {
  it('同版本一次結論通過、一次結論失敗 → flaky', () => {
    const t = trend([
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z', 'PASS'),
      pt('j2', 'pass', 'v1', '2026-09-02T00:00:00Z', 'FAIL'),
    ]);
    expect(t.flaky).toBe(true);
    expect(t.flakyReason).toContain('v1');
  });

  it('同版本結論一路失敗,但有一次舊資料的執行結果是 pass → 不判 flaky', () => {
    // 這就是修正前會誤判的情境:execution_state 的 pass 被當成通過,
    // 與結論 FAIL 並列,看起來像反覆,其實是一貫失敗。
    const t = trend([
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z'),
      pt('j2', 'pass', 'v1', '2026-09-02T00:00:00Z', 'FAIL'),
      pt('j3', 'pass', 'v1', '2026-09-03T00:00:00Z', 'FAIL'),
    ]);
    expect(t.flaky).toBe(false);
  });

  it('完全沒有結論時仍可退回執行結果判 flaky,但理由要說明依據', () => {
    const t = trend([
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z'),
      pt('j2', 'fail', 'v1', '2026-09-02T00:00:00Z'),
    ]);
    expect(t.flaky).toBe(true);
    expect(t.flakyReason).toContain('非測試結論');
  });

  it('受阻反覆不觸發 flaky', () => {
    const t = trend([
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z', 'PASS'),
      pt('j2', 'fail', 'v1', '2026-09-02T00:00:00Z', 'BLOCKED'),
    ]);
    expect(t.flaky).toBe(false);
  });

  it('跨版本的通過→失敗是回歸,不是 flaky', () => {
    const t = trend([
      pt('j1', 'pass', 'v1', '2026-09-01T00:00:00Z', 'PASS'),
      pt('j2', 'pass', 'v2', '2026-09-02T00:00:00Z', 'FAIL'),
    ]);
    expect(t.flaky).toBe(false);
  });
});

describe('修正複驗鏈', () => {
  it('初測失敗 → 新版本通過,建立複驗連結', () => {
    const chain = computeRetestChain([
      pt('j1', 'pass', 'build-1', '2026-09-01T00:00:00Z', 'FAIL'),
      pt('j2', 'pass', 'build-2', '2026-09-04T00:00:00Z', 'PASS'),
    ]);
    expect(chain.links).toEqual([
      { failedVersion: 'build-1', failedJobId: 'j1', retestVersion: 'build-2', retestJobId: 'j2' },
    ]);
    expect(chain.unresolved).toEqual([]);
  });

  it('原版本的失敗不被複驗結果覆寫', () => {
    const chain = computeRetestChain([
      pt('j1', 'pass', 'build-1', '2026-09-01T00:00:00Z', 'FAIL'),
      pt('j2', 'pass', 'build-2', '2026-09-04T00:00:00Z', 'PASS'),
    ]);
    const first = chain.stages.find((s) => s.artifactVersion === 'build-1')!;
    expect(first.outcome).toBe('fail');
    expect(chain.note).toContain('保留不覆寫');
  });

  it('同版本重跑通過不算複驗:被測沒有變更', () => {
    const chain = computeRetestChain([
      pt('j1', 'pass', 'build-1', '2026-09-01T00:00:00Z', 'FAIL'),
      pt('j2', 'pass', 'build-1', '2026-09-02T00:00:00Z', 'PASS'),
    ]);
    expect(chain.links).toEqual([]);
    expect(chain.unresolved).toEqual([{ artifactVersion: 'build-1', jobId: 'j1' }]);
    // 段內出現過失敗,該段就記失敗,不被同版本的後續通過抹掉。
    expect(chain.stages[0]!.outcome).toBe('fail');
  });

  it('失敗後沒有任何後續版本通過 → 列為未複驗', () => {
    const chain = computeRetestChain([
      pt('j1', 'pass', 'build-1', '2026-09-01T00:00:00Z', 'FAIL'),
      pt('j2', 'pass', 'build-2', '2026-09-02T00:00:00Z', 'FAIL'),
    ]);
    expect(chain.links).toEqual([]);
    expect(chain.unresolved.map((u) => u.artifactVersion)).toEqual(['build-1', 'build-2']);
  });

  it('段落依時間新→舊排列,方便直接呈現', () => {
    const chain = computeRetestChain([
      pt('j1', 'pass', 'build-1', '2026-09-01T00:00:00Z', 'FAIL'),
      pt('j2', 'pass', 'build-2', '2026-09-02T00:00:00Z', 'PASS'),
      pt('j3', 'pass', 'build-3', '2026-09-03T00:00:00Z', 'PASS'),
    ]);
    expect(chain.stages.map((s) => s.artifactVersion)).toEqual(['build-3', 'build-2', 'build-1']);
  });

  it('沒有失敗過就沒有複驗鏈,而不是一個空殼', () => {
    const chain = computeRetestChain([pt('j1', 'pass', 'build-1', '2026-09-01T00:00:00Z', 'PASS')]);
    expect(chain.note).toContain('沒有失敗的版本');
    expect(chain.links).toEqual([]);
  });

  it('無歷史執行時說清楚,不假裝有鏈', () => {
    const chain = computeRetestChain([]);
    expect(chain.stages).toEqual([]);
    expect(chain.note).toContain('無法建立複驗鏈');
  });

  it('趨勢結果直接帶出複驗鏈', () => {
    const t = trend([
      pt('j1', 'pass', 'build-1', '2026-09-01T00:00:00Z', 'FAIL'),
      pt('j2', 'pass', 'build-2', '2026-09-02T00:00:00Z', 'PASS'),
    ]);
    expect(t.retest.links).toHaveLength(1);
  });
});
