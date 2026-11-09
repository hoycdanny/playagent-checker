import { describe, expect, test } from 'vitest';
import {
  conditionRecord,
  describeCondition,
  parseNetworkCondition,
  toCdpPayload,
} from '../../agent/networkConditions.mjs';
import { buildStructuredReport } from '../lambda/api/report/engine.js';

/**
 * 弱網條件。
 *
 * 這組測試守的核心是:**報告只有在條件真的套用時才可以主張「這個條件下驗過」。**
 * 案例寫了 1000ms、實際沒生效、報告照樣寫弱網通過 —— 那是最糟的結果,比測不到還糟。
 */

type RawStep = Record<string, unknown>;
const st = (i: number, screen: string, action: string, extra: RawStep = {}): RawStep => ({ index: i, screen, action, ...extra });
const report = (networkConditions?: unknown) =>
  buildStructuredReport({
    raw: {
      state: 'pass', task: '弱網下驗證購買', steps: [st(0, '商城', 'tap', { x: 5, y: 5 }), st(1, '商城', 'done')],
      ...(networkConditions ? { networkConditions } : {}),
    },
    job: { jobId: 'job-test' },
    app: { genre: 'slot' },
  } as never);

describe('條件解析', () => {
  test('單一延遲', () => {
    expect(parseNetworkCondition('latency=1000')).toEqual({ latencyMs: 1000 });
  });

  test('延遲加上下行頻寬', () => {
    expect(parseNetworkCondition('latency=1000,down=400,up=200')).toEqual({
      latencyMs: 1000, downloadKbps: 400, uploadKbps: 200,
    });
  });

  test('接受帶單位的寫法', () => {
    expect(parseNetworkCondition('latency=500ms,down=256kbps,loss=10%')).toEqual({
      latencyMs: 500, downloadKbps: 256, lossPct: 10,
    });
  });

  test('offline 與物件形式', () => {
    expect(parseNetworkCondition('offline')).toEqual({ offline: true });
    expect(parseNetworkCondition({ latencyMs: 300 })).toEqual({ latencyMs: 300 });
  });

  test('看不懂的鍵忽略而不是猜(猜錯會讓報告主張沒套用的條件)', () => {
    expect(parseNetworkCondition('jitter=50')).toBeNull();
    expect(parseNetworkCondition('latency=abc')).toBeNull();
    expect(parseNetworkCondition('latency=1000,jitter=50')).toEqual({ latencyMs: 1000 });
  });

  test('空值與關閉寫法回 null(等同不施加)', () => {
    for (const v of ['', '  ', 'off', 'none', '0', null, undefined]) {
      expect(parseNetworkCondition(v as string)).toBeNull();
    }
  });

  test('負值與零不算條件;過大的延遲被夾住', () => {
    expect(parseNetworkCondition('latency=0')).toBeNull();
    expect(parseNetworkCondition('latency=-5')).toBeNull();
    expect(parseNetworkCondition('latency=999999')!.latencyMs).toBe(60000);
    expect(parseNetworkCondition('loss=500')!.lossPct).toBe(100);
  });
});

describe('轉成 CDP 參數', () => {
  test('延遲與頻寬換算成 CDP 的 bytes/s', () => {
    const { payload, applied } = toCdpPayload({ latencyMs: 1000, downloadKbps: 400 });
    expect(payload.latency).toBe(1000);
    expect(payload.downloadThroughput).toBe(50000); // 400 kbps = 50,000 bytes/s
    expect(payload.uploadThroughput).toBe(-1); // 未指定 = 不限制
    expect(payload.offline).toBe(false);
    expect(applied).toEqual({ latencyMs: 1000, downloadKbps: 400 });
  });

  test('丟包要被標成做不到,不可當成已套用', () => {
    const { applied, unsupported } = toCdpPayload({ latencyMs: 1000, lossPct: 10 });
    expect(applied).not.toHaveProperty('lossPct');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]!.key).toBe('lossPct');
    expect(unsupported[0]!.reason).toContain('丟包');
  });

  test('offline 原樣帶過', () => {
    expect(toCdpPayload({ offline: true }).payload.offline).toBe(true);
  });
});

describe('施加紀錄', () => {
  test('成功時才有 applied,且預設標為未獨立驗證', () => {
    const r = conditionRecord({ requested: { latencyMs: 1000 }, applied: { latencyMs: 1000 }, unsupported: [], ok: true });
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual({ latencyMs: 1000 });
    // CDP 接受參數 ≠ 行為達到該延遲,沒有量測就不宣稱已驗證
    expect(r.verified).toBe(false);
    expect(r.summary).toContain('1000ms');
  });

  test('失敗時 applied 為 null、summary 為 null,錯誤原因保留', () => {
    const r = conditionRecord({ requested: { latencyMs: 1000 }, ok: false, error: 'CDP detached' });
    expect(r.applied).toBeNull();
    expect(r.summary).toBeNull();
    expect(r.error).toContain('CDP detached');
  });

  test('有獨立量測才標 verified', () => {
    const r = conditionRecord({ requested: { latencyMs: 1000 }, applied: { latencyMs: 1000 }, ok: true, measuredRttMs: 1042 });
    expect(r.verified).toBe(true);
    expect(r.measuredRttMs).toBe(1042);
  });

  test('摘要把各項條件講清楚', () => {
    expect(describeCondition({ latencyMs: 1000, downloadKbps: 400, lossPct: 10 })).toBe('延遲 1000ms、下行 400kbps、丟包 10%');
    expect(describeCondition(null)).toBeNull();
  });
});

describe('報告的適用邊界', () => {
  test('條件成功套用 → 可主張該條件,但限定在該條件', () => {
    const r = report({ requested: { latencyMs: 1000 }, applied: { latencyMs: 1000 }, unsupported: [], ok: true, verified: false, summary: '延遲 1000ms' });
    const net = r.claimScope.notVaried.find((n) => n.id === 'network')!;
    expect(net.note.zh).toContain('已施加');
    expect(net.note.zh).toContain('延遲 1000ms');
    expect(net.note.zh).toContain('僅適用於這個網路條件');
  });

  test('有做不到的項目 → 該項明確標為不得視為已驗', () => {
    const r = report({
      requested: { latencyMs: 1000, lossPct: 10 }, applied: { latencyMs: 1000 },
      unsupported: [{ key: 'lossPct', reason: '瀏覽器後端無封包遺失控制' }],
      ok: true, verified: false, summary: '延遲 1000ms',
    });
    const net = r.claimScope.notVaried.find((n) => n.id === 'network')!;
    expect(net.note.zh).toContain('lossPct');
    expect(net.note.zh).toContain('不得視為已驗');
  });

  test('施加失敗 → 明講這是一次沒有條件的普通執行', () => {
    const r = report({ requested: { latencyMs: 1000 }, applied: null, unsupported: [], ok: false, verified: false, summary: null, error: 'CDP detached' });
    const net = r.claimScope.notVaried.find((n) => n.id === 'network')!;
    expect(net.note.zh).toContain('施加失敗');
    expect(net.note.zh).toContain('不得主張弱網已驗');
  });

  test('沒有施加條件 → 維持原本的保守陳述', () => {
    const net = report().claimScope.notVaried.find((n) => n.id === 'network')!;
    expect(net.note.zh).toContain('未施加任何網路條件');
  });

  test('紀錄本身也進適用邊界,報告可回溯要求了什麼', () => {
    const rec = { requested: { latencyMs: 1000 }, applied: { latencyMs: 1000 }, unsupported: [], ok: true, verified: false, summary: '延遲 1000ms' };
    expect(report(rec).claimScope.network).toMatchObject({ ok: true, summary: '延遲 1000ms' });
    expect(report().claimScope.network).toBeUndefined();
  });
});
