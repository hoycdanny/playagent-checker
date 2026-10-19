import { describe, expect, test } from 'vitest';
import { fill, loc5, pick5, type L5 } from './locale5.ts';

const V: L5 = ['繁中', 'English', '简中', '日本語', '한국어'];

describe('loc5', () => {
  test('五種語系各自對應;認不出來退回英文', () => {
    expect(loc5('zh-Hant')).toBe('zh-Hant');
    expect(loc5('en')).toBe('en');
    expect(loc5('zh-Hans')).toBe('zh-Hans');
    expect(loc5('ja')).toBe('ja');
    expect(loc5('ko')).toBe('ko');
    expect(loc5('de')).toBe('en');
    expect(loc5('')).toBe('en');
    // 不做前綴推斷:'zh' 不是支援的 locale,照 fallback 規則走
    expect(loc5('zh')).toBe('en');
  });
});

describe('pick5', () => {
  test('依語系取值', () => {
    expect(pick5(V, 'zh-Hant')).toBe('繁中');
    expect(pick5(V, 'en')).toBe('English');
    expect(pick5(V, 'zh-Hans')).toBe('简中');
    expect(pick5(V, 'ja')).toBe('日本語');
    expect(pick5(V, 'ko')).toBe('한국어');
  });

  test('缺值退回英文(漏填不會變成空白)', () => {
    const holes = ['繁中', 'English', '', '', ''] as unknown as L5;
    expect(pick5(holes, 'ja')).toBe('English');
  });
});

describe('fill', () => {
  test('換掉佔位符;沒給變數就原樣回傳', () => {
    expect(fill('已停用 {n} 項', { n: 3 })).toBe('已停用 3 項');
    expect(fill('{a} / {j}', { a: 1, j: 2 })).toBe('1 / 2');
    expect(fill('沒有佔位符')).toBe('沒有佔位符');
    // 找不到對應變數時留著原樣,不會變成 undefined
    expect(fill('版本 {v}', { other: 1 })).toBe('版本 {v}');
  });
});
