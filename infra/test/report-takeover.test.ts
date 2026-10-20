import { describe, expect, test } from 'vitest';
import { buildStructuredReport } from '../lambda/api/report/engine.js';

/**
 * 接管模式與報告數字。
 *
 * 這是正確性問題,不是美觀問題:接管時是「人」幫 AI 過了關。若把那些步驟算進 AI 指標,
 * 報告會告訴客戶「AI 成功率很高」,而實際上是測試人員自己點完的。
 */

/** 跑一次報告引擎。 */
function build(steps: Array<Record<string, unknown>>) {
  return buildStructuredReport({
    raw: { state: 'pass', task: '登入並進入主畫面', steps },
    job: { jobId: 'job-takeover' },
    app: { genre: 'slot' },
  });
}

/** AI 的一步(有 expect;下一步的 prevResult 才是這一步的判定)。 */
const aiStep = (index: number, screen: string) => ({
  index, action: 'tap', screen, x: 10, y: 10,
  expect: '進到下一個畫面', thinking: 'go',
  prevResult: 'pass', screenChanged: true,
});

/** 測試人員接管時手動操作的一步。 */
const opStep = (index: number, screen: string) => ({
  index, action: 'tap', screen, x: 20, y: 20,
  by: 'operator', takeover: true, thinking: '測試人員接管:tap',
});

function metric(r: { metrics?: Array<{ id: string; value: number | null }> }, id: string): number | null | undefined {
  return r.metrics?.find((m) => m.id === id)?.value;
}

describe('人工接管的步驟不計入 AI 指標', () => {
  test('AI 操作數只數 AI 的步驟', () => {
    const r = build([aiStep(0, '首頁'), aiStep(1, '登入'), opStep(2, '登入'), opStep(3, '登入'), opStep(4, '大廳')]);
    expect(metric(r, 'ai_action_count')).toBe(2);
  });

  test('AI 與人工的步數分開呈現(加起來才是整場)', () => {
    const r = build([aiStep(0, '首頁'), opStep(1, '登入'), opStep(2, '大廳')]);
    expect(metric(r, 'ai_action_count')).toBe(1);
    expect(metric(r, 'operator_step_count')).toBe(2);
  });

  test('人工接管比例算得出來(比例高就代表 AI 指標不能代表品質)', () => {
    const r = build([aiStep(0, '首頁'), opStep(1, '登入'), opStep(2, '大廳'), opStep(3, '大廳')]);
    expect(metric(r, 'operator_step_rate')).toBe(75);
  });

  test('只有 takeover=true(沒有 by)也要被認出來', () => {
    const r = build([aiStep(0, '首頁'), { index: 1, action: 'tap', screen: '登入', x: 1, y: 1, takeover: true }]);
    expect(metric(r, 'operator_step_count')).toBe(1);
    expect(metric(r, 'ai_action_count')).toBe(1);
  });

  test('完全沒有接管時,數字與舊行為一致', () => {
    const r = build([aiStep(0, '首頁'), aiStep(1, '登入'), aiStep(2, '大廳')]);
    expect(metric(r, 'operator_step_count')).toBe(0);
    expect(metric(r, 'operator_step_rate')).toBe(0);
    expect(metric(r, 'ai_action_count')).toBe(3);
  });
});

describe('人工接管不會美化 AI 的成功率', () => {
  test('AI 的動作沒效果 → 成功率不因為後面人工做成功而變高', () => {
    const r = build([
      { index: 0, action: 'tap', screen: '登入', x: 1, y: 1, expect: '聚焦帳號欄', thinking: 'a' },
      { index: 1, action: 'tap', screen: '登入', x: 1, y: 1, expect: '聚焦帳號欄', thinking: 'b', prevResult: 'fail', screenChanged: false },
      { index: 2, action: 'tap', screen: '登入', x: 1, y: 1, prevResult: 'fail', screenChanged: false, by: 'operator', takeover: true },
      { index: 3, action: 'tap', screen: '大廳', x: 1, y: 1, by: 'operator', takeover: true },
    ]);
    const rate = metric(r, 'ai_action_success_rate');
    expect(typeof rate === 'number' ? rate < 100 : true).toBe(true);
    expect(metric(r, 'operator_step_count')).toBe(2);
  });

  test('無效輸出比例的分母是 AI 步數,不被人工步驟稀釋', () => {
    const steps: Array<Record<string, unknown>> = [
      { index: 0, action: 'wait', screen: '首頁', parseFailed: true, thinking: '' },
      aiStep(1, '首頁'),
    ];
    for (let i = 2; i < 10; i++) steps.push(opStep(i, '大廳'));
    const r = build(steps);
    // 分母若含人工步驟會變成 1/10 = 10%;正確是 1/2 = 50%。
    expect(metric(r, 'invalid_action_rate')).toBe(50);
  });
});

describe('整場性的指標照樣算人工走過的畫面', () => {
  test('畫面轉換數包含人工接管走過的路徑', () => {
    const r = build([aiStep(0, '首頁'), opStep(1, '登入'), opStep(2, '大廳')]);
    // 首頁→登入→大廳 = 2 次轉換(人走的也是這場測試走過的畫面)。
    expect(metric(r, 'screen_transitions')).toBe(2);
  });
});
