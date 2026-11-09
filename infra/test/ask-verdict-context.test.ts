import { describe, expect, test } from 'vitest';
import { summarizeVerdict } from '../lambda/api/taskAsk.js';
import { buildStructuredReport } from '../lambda/api/report/engine.js';
import type { StructuredReport } from '../lambda/api/report/types.js';

/**
 * 問答的「判定與適用邊界」上下文。
 *
 * 為什麼這一段必須存在:raw report.json 只有 state 與 message,判定依據、
 * 不得主張什麼、平台做不到什麼全是報告引擎在讀取時算出來的。問答看不到它時,
 * 使用者問「音效正常嗎」,模型會從別處的資料硬湊一個答案 —— 那等於繞過報告
 * 自己的邊界聲明,比答不出來更糟。
 */
type RawStep = Record<string, unknown>;
const st = (i: number, screen: string, action: string, extra: RawStep = {}): RawStep => ({ index: i, screen, action, ...extra });
const report = (raw: RawStep = {}) =>
  buildStructuredReport({
    raw: {
      state: 'pass', task: '探索遊戲',
      steps: [st(0, '大廳', 'tap', { x: 5, y: 5 }), st(1, '選單', 'done')],
      ...raw,
    },
    job: { jobId: 'job-test' },
    app: { genre: 'slot' },
  } as never);

describe('沒有結構化報告時', () => {
  test('明說沒有,而不是靜默產出一段空白上下文', () => {
    const s = summarizeVerdict(null, 6000);
    expect(s).toContain('還沒有結構化報告');
  });

  test('undefined 也走同一條路', () => {
    expect(summarizeVerdict(undefined, 6000)).toContain('還沒有結構化報告');
  });
});

describe('判定與依據', () => {
  test('帶出整體判定與發布建議', () => {
    const s = summarizeVerdict(report(), 6000);
    expect(s).toContain('整體判定:PASS');
    expect(s).toContain('發布建議:');
  });

  test('帶出檢查項與缺陷的分級統計', () => {
    const s = summarizeVerdict(report(), 6000);
    expect(s).toMatch(/檢查項:已執行 \d+\/\d+/);
    expect(s).toMatch(/缺陷:重大 \d+/);
    // 無法認定的數量要出現 —— 少了它,PASS 看起來比實際乾淨
    expect(s).toContain('無法認定');
  });
});

describe('適用邊界:這一段是整個功能的理由', () => {
  test('逐項列出不得主張的事,不只給個數量', () => {
    const s = summarizeVerdict(report(), 6000);
    expect(s).toContain('以下各項本次不得主張');
    // slot 類型的這份報告至少會有音訊與網路兩條
    expect(s).toContain('音訊');
    expect(s).toContain('網路條件');
  });

  test('平台限制與「本次沒測到」分開陳述', () => {
    const s = summarizeVerdict(report(), 6000);
    // 混在一起會讓模型建議「重跑一次就有了」,而那對工具缺口是假的
    expect(s).toContain('平台限制');
    expect(s).toContain('重測也不會改變');
  });

  test('帶出可執行範圍與「分類數不等於測項數」的警告', () => {
    const s = summarizeVerdict(report(), 6000);
    expect(s).toContain('平台可執行範圍');
    expect(s).toContain('分類數不等於測項數');
  });
});

describe('待判讀缺陷', () => {
  test('列出 id,使用者才能指名追問或回報誤判', () => {
    const r = report() as StructuredReport;
    (r as { findings: unknown[] }).findings = [
      { id: 'F-07', classification: 'NEEDS_TRIAGE', category: 'functional', severity: 'high', title: { zh: '大廳列表空白', en: 'empty list' } },
      { id: 'F-08', classification: 'GAME_FAILURE', category: 'crash', severity: 'critical', title: { zh: '崩潰', en: 'crash' } },
    ];
    const s = summarizeVerdict(r, 6000);
    expect(s).toContain('待判讀缺陷');
    expect(s).toContain('F-07');
    expect(s).toContain('大廳列表空白');
    // 已確認的缺陷不該混進待判讀清單
    expect(s).not.toContain('F-08');
  });

  test('沒有待判讀的缺陷時不出現這一段', () => {
    expect(summarizeVerdict(report(), 6000)).not.toContain('待判讀缺陷');
  });
});

describe('預算', () => {
  test('超過預算會截斷,不會無上限灌進 prompt', () => {
    const s = summarizeVerdict(report(), 120);
    expect(s.length).toBeLessThanOrEqual(130);
  });
});
