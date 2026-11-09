import { describe, test, expect } from 'vitest';
import { extractCaseNetwork, extractCaseTask } from '../lambda/api/core.js';

describe('extractCaseTask — 案例 YAML 取 task', () => {
  test('YAML 區塊純量 task: | 取完整多行(含登入帳密)', () => {
    const yaml = [
      'name: 範例老虎機測試',
      'app: app-1',
      'task: |',
      '  1. 開啟範例老虎機應用',
      '  2. 若出現登入頁,使用帳號 test.user 密碼 REDACTED 登入',
      '  3. 進入拉霸遊戲',
      'assertions:',
      '  - 成功進入',
    ].join('\n');
    const t = extractCaseTask(yaml);
    expect(t).toContain('1. 開啟範例老虎機應用');
    expect(t).toContain('帳號 test.user 密碼 REDACTED');
    expect(t).toContain('3. 進入拉霸遊戲');
    // 不可只剩區塊指示符
    expect(t).not.toBe('|');
    // 不可把後續的 assertions key 吃進來
    expect(t).not.toContain('assertions');
  });

  test('行內 task: 文字', () => {
    const yaml = 'name: x\napp: app-1\ntask: 走到大廳並點開始\n';
    expect(extractCaseTask(yaml)).toBe('走到大廳並點開始');
  });

  test('task: > 折疊區塊也支援', () => {
    const yaml = 'task: >\n  第一行\n  第二行\n';
    const t = extractCaseTask(yaml);
    expect(t).toContain('第一行');
    expect(t).toContain('第二行');
  });

  test('無 task 欄位 → undefined', () => {
    expect(extractCaseTask('name: x\napp: app-1\n')).toBeUndefined();
  });

  test('task: | 但無內容 → undefined', () => {
    expect(extractCaseTask('task: |\nassertions:\n  - a\n')).toBeUndefined();
  });
});

/**
 * extractCaseNetwork —— 案例 YAML 取弱網條件。
 *
 * 在提交時解析一次並快照進 job.json 是刻意的:emulator 的 run.sh 直接讀 job.json,
 * web 的 engine 走 readCaseTarget。各自解析案例 YAML 的話,同一個案例可能在兩個
 * 後端得到不同條件,而報告會以為自己驗的是案例寫的那一個。
 */
describe('extractCaseNetwork — 案例 YAML 取弱網條件', () => {
  test('行內條件取出來', () => {
    expect(extractCaseNetwork('name: x\nnetwork: latency=1000,loss=5\ntask: 測購買\n'))
      .toBe('latency=1000,loss=5');
  });

  test('引號會剝掉', () => {
    expect(extractCaseNetwork('network: "offline"\n')).toBe('offline');
  });

  test('無 network 欄位 → undefined', () => {
    expect(extractCaseNetwork('name: x\ntask: 走到大廳\n')).toBeUndefined();
  });

  test('空值 → undefined(不回空字串,避免下游誤判成「有宣告」)', () => {
    expect(extractCaseNetwork('network:\ntask: x\n')).toBeUndefined();
    expect(extractCaseNetwork('network:   \ntask: x\n')).toBeUndefined();
  });

  test('不會把別的鍵裡含 network 的字樣誤認', () => {
    expect(extractCaseNetwork('networkNotes: latency=1000\n')).toBeUndefined();
    expect(extractCaseNetwork('task: 檢查 network: latency=1\n')).toBeUndefined();
  });

  test('語意不在這裡判斷:看不懂的值照樣取出,交給下游把關', () => {
    // 形狀把關在 engine 的 sanitizeNetworkSpec,語意解析在 runner 的
    // parseNetworkCondition。這裡多做一層判斷只會讓三處邏輯有機會分歧。
    expect(extractCaseNetwork('network: bogus=1\n')).toBe('bogus=1');
  });
});
