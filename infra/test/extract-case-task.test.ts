import { describe, test, expect } from 'vitest';
import { extractCaseTask } from '../lambda/api/core.js';

describe('extractCaseTask — 案例 YAML 取 task', () => {
  test('YAML 區塊純量 task: | 取完整多行(含登入帳密)', () => {
    const yaml = [
      'name: 金好運測試',
      'app: app-1',
      'task: |',
      '  1. 開啟金好運娛樂城應用',
      '  2. 若出現登入頁,使用帳號 hoyc.danny 密碼 kiss5891 登入',
      '  3. 進入拉霸遊戲',
      'assertions:',
      '  - 成功進入',
    ].join('\n');
    const t = extractCaseTask(yaml);
    expect(t).toContain('1. 開啟金好運娛樂城應用');
    expect(t).toContain('帳號 hoyc.danny 密碼 kiss5891');
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
