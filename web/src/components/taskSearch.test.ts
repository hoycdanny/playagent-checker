import { describe, expect, test } from 'vitest';
import { searchTerms, taskMatchesQuery, type SearchableTask } from './taskSearch.ts';

const task: SearchableTask = {
  jobId: 'job-mvete8mq-8qsjj2',
  appId: 'app-mva95wxf-camd57',
  caseId: 'case-mvc3ig5k-z4w9fj',
  caseName: '完成50次拉霸機',
  caseVersion: '2026-1017-1549-1626',
  deviceModel: 'Samsung Galaxy S23 Ultra',
  message: '已完成50局付費Spin,系統RTP為579.85%',
  task: '1. 點選Play按鈕開始遊戲',
  submittedBy: 'cli-kiro',
};

describe('searchTerms', () => {
  test('空白分隔、去掉空詞、轉小寫', () => {
    expect(searchTerms('  Job-ABC   fail ')).toEqual(['job-abc', 'fail']);
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('   ')).toEqual([]);
  });
});

describe('taskMatchesQuery', () => {
  test('沒有搜尋字 → 全部命中(等於不篩選)', () => {
    expect(taskMatchesQuery(task, '')).toBe(true);
    expect(taskMatchesQuery(task, '   ')).toBe(true);
  });

  // 這是這個功能存在的原因:拿到一個 jobId 要能在介面上找到它。
  test('用任務編號找得到 —— 完整、前半段、不分大小寫都可以', () => {
    expect(taskMatchesQuery(task, 'job-mvete8mq-8qsjj2')).toBe(true);
    expect(taskMatchesQuery(task, 'job-mvete8mq')).toBe(true);
    expect(taskMatchesQuery(task, 'MVETE8MQ')).toBe(true);
    expect(taskMatchesQuery(task, 'job-mvep70wb')).toBe(false);
  });

  test('案例名稱 / 版本 / 裝置 / 訊息 / 測試內容 / 送出者都能搜', () => {
    expect(taskMatchesQuery(task, '拉霸')).toBe(true);
    expect(taskMatchesQuery(task, '2026-1017')).toBe(true);
    expect(taskMatchesQuery(task, 'galaxy s23')).toBe(true);
    expect(taskMatchesQuery(task, 'rtp')).toBe(true);
    expect(taskMatchesQuery(task, 'Play按鈕')).toBe(true);
    expect(taskMatchesQuery(task, 'cli-kiro')).toBe(true);
    expect(taskMatchesQuery(task, '不存在的字')).toBe(false);
  });

  test('應用名稱由呼叫端帶入(列表顯示名稱而不是 id)', () => {
    expect(taskMatchesQuery(task, 'FaFaFa')).toBe(false);
    expect(taskMatchesQuery(task, 'FaFaFa', 'FaFaFa 老虎機')).toBe(true);
    // 沒有名稱時仍可用 appId 找
    expect(taskMatchesQuery(task, 'app-mva95wxf')).toBe(true);
  });

  test('多個詞是 AND:全部都要命中', () => {
    expect(taskMatchesQuery(task, '拉霸 cli-kiro')).toBe(true);
    expect(taskMatchesQuery(task, '拉霸 不存在')).toBe(false);
  });

  test('欄位缺漏的舊任務不會壞,只是比對範圍比較小', () => {
    const old: SearchableTask = { jobId: 'job-old-1' };
    expect(taskMatchesQuery(old, 'job-old')).toBe(true);
    expect(taskMatchesQuery(old, '拉霸')).toBe(false);
    expect(taskMatchesQuery(old, '')).toBe(true);
  });
});
