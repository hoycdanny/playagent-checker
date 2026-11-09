import { describe, test, expect } from 'vitest';
import { extractCaseNetwork, extractCaseTask } from '../lambda/api/core.js';

/**
 * 這個 fixture 的帳密是**合成值**,不是任何真實憑證。
 *
 * 這條測試守的是「多行 task 要完整取出,包含看起來像登入步驟的那幾行」——
 * 驗這件事不需要真的帳密,合成值一樣能驗。而這支產品的設計本來就把測試帳密放在
 * 案例資料裡,所以用真實案例當重現資料,等於把憑證複製進原始碼;原始碼會進
 * 版本歷史,版本歷史不會因為之後刪掉就消失。重現問題請改用合成值。
 */
describe('extractCaseTask — 案例 YAML 取 task', () => {
  test('YAML 區塊純量 task: | 取完整多行(含登入步驟)', () => {
    const yaml = [
      'name: 範例老虎機測試',
      'app: app-1',
      'task: |',
      '  1. 開啟範例老虎機應用',
      '  2. 若出現登入頁,使用帳號 ${帳號} 密碼 ${密碼} 登入',
      '  3. 進入拉霸遊戲',
      'assertions:',
      '  - 成功進入',
    ].join('\n');
    const t = extractCaseTask(yaml);
    expect(t).toContain('1. 開啟範例老虎機應用');
    // 用 ${key} 佔位:這正是產品實際的寫法(遮蔽憑證由 runner 在輸入時填值),
    // 所以 fixture 不必、也不應該放真實帳密。
    expect(t).toContain('帳號 ${帳號} 密碼 ${密碼}');
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
