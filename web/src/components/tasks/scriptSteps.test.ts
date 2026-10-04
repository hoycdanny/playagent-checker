import { describe, expect, test } from 'vitest';
import { parseScript } from './scriptSteps.ts';

describe('parseScript', () => {
  test('numbered steps crammed in one line are split', () => {
    const p = parseScript('1. 啟動應用並等待載入完成 2. 在遊戲大廳中找到拉霸機入口 3. 連續進行10次拉霸遊戲(每次等待結果) 4. 確認10次遊戲都有正常執行');
    expect(p.steps.map((s) => s.text)).toEqual([
      '啟動應用並等待載入完成',
      '在遊戲大廳中找到拉霸機入口',
      '連續進行10次拉霸遊戲(每次等待結果)',
      '確認10次遊戲都有正常執行',
    ]);
    expect(p.intro).toEqual([]);
  });

  test('markdown with intro, numbered lines and nested bullets', () => {
    const p = parseScript('## 目標\n驗證 **SPIN** 正常\n\n1. 登入\n   - 帳號:`demo`\n2. 進入機台\n- 轉 10 次');
    expect(p.intro).toEqual(['目標', '驗證 SPIN 正常']);
    expect(p.steps).toEqual([
      { text: '登入', sub: ['帳號:demo'] },
      { text: '進入機台', sub: [] },
      { text: '轉 10 次', sub: [] },
    ]);
  });

  test('does not split non-sequential numbers like 第 10 轉', () => {
    const p = parseScript('1. 進入機台後轉 10 次 2. 確認餘額');
    expect(p.steps.map((s) => s.text)).toEqual(['進入機台後轉 10 次', '確認餘額']);
  });

  test('plain paragraph is split into sentences; empty input', () => {
    expect(parseScript('打開遊戲。進入大廳。轉一次。').steps.map((s) => s.text)).toEqual(['打開遊戲', '進入大廳', '轉一次']);
    expect(parseScript('')).toEqual({ intro: [], steps: [] });
    expect(parseScript('只有一句目標')).toEqual({ intro: ['只有一句目標'], steps: [] });
  });
});
