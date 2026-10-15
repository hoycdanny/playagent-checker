import { describe, expect, test } from 'vitest';
import { applyControls, readControls } from './controlsYaml.ts';
import { applyKeys, readKeys } from './keysYaml.ts';

const base = ['name: 開場', 'controls: [keyboard, mouse]', 'task: |', '  按 Enter 開始'].join('\n');

describe('keysYaml', () => {
  test('writes the keys block right after controls and reads it back', () => {
    const y = applyKeys(base, [
      { key: 'up', purpose: '往上移動' },
      { key: 'enter', purpose: '確認\n推進對話' },
    ]);
    expect(y.split('\n')).toEqual([
      'name: 開場',
      'controls: [keyboard, mouse]',
      'keys:',
      '  - up: 往上移動',
      '  - enter: 確認 推進對話',
      'task: |',
      '  按 Enter 開始',
    ]);
    expect(readKeys(y)).toEqual([
      { key: 'up', purpose: '往上移動' },
      { key: 'enter', purpose: '確認 推進對話' },
    ]);
    // controls 的讀寫不受 keys 區塊影響。
    expect(readControls(y)).toEqual(['keyboard', 'mouse']);
    expect(readControls(applyControls(y, ['keyboard']))).toEqual(['keyboard']);
    expect(readKeys(applyControls(y, ['keyboard']))).toHaveLength(2);
  });
  test('replaces an existing block and removes it when empty', () => {
    const y = applyKeys(base, [{ key: 'z', purpose: '確認' }]);
    const y2 = applyKeys(y, [{ key: 'x', purpose: '取消' }]);
    expect(readKeys(y2)).toEqual([{ key: 'x', purpose: '取消' }]);
    expect(applyKeys(y2, [])).toBe(base);
    expect(readKeys(base)).toBeUndefined();
  });
  test('empty purpose and empty yaml', () => {
    expect(applyKeys(base, [{ key: 'space', purpose: '' }])).toContain('  - space:\n');
    expect(readKeys(applyKeys(base, [{ key: 'space', purpose: '' }]))).toEqual([{ key: 'space', purpose: '' }]);
    expect(applyKeys('', [{ key: 'z', purpose: 'x' }])).toBe('');
  });
  test('no controls line → block goes after name', () => {
    const y = applyKeys('name: a\ntask: b', [{ key: 'w', purpose: '前進' }]);
    expect(y).toBe('name: a\nkeys:\n  - w: 前進\ntask: b');
  });
});
