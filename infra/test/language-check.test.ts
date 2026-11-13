import { describe, expect, test } from 'vitest';
import {
  DATA_REGIONS,
  LOCALES,
  SIMPLIFIED_ONLY,
  TRADITIONAL_ONLY,
  checkCollected,
  checkText,
  collectDomText,
  selftest,
} from '../../tools/screenshots/lib/language-check.mjs';

/**
 * 截圖前的語言一致性檢查:每個語系植入一個違規字元都必須被抓到,
 * 同一段文字放進資料區塊(DATA_REGIONS)則不算違規,兩組繁/簡專用字不能有交集。
 */
describe('screenshot language check', () => {
  test('covers the five UI locales', () => {
    expect([...LOCALES].sort()).toEqual(['en', 'ja', 'ko', 'zh-Hans', 'zh-Hant']);
  });

  test('planted Han in en is reported', () => {
    const r = checkText('en', 'Settings 設定');
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.char)).toEqual(['設', '定']);
  });

  test('planted Hangul in ja is reported', () => {
    const r = checkText('ja', '設定 한국어');
    expect(r.ok).toBe(false);
    expect(r.violations.every((v) => v.kind === 'hangul')).toBe(true);
  });

  test('planted Simplified-only char in zh-Hant is reported', () => {
    const r = checkText('zh-Hant', '設定 这');
    expect(r.violations).toEqual([{ char: '这', kind: 'simplified-only' }]);
  });

  test('planted Traditional-only char in zh-Hans is reported', () => {
    const r = checkText('zh-Hans', '设置 這');
    expect(r.violations).toEqual([{ char: '這', kind: 'traditional-only' }]);
  });

  test('planted Kana in ko is reported, and Kana in zh-Hant/zh-Hans too', () => {
    expect(checkText('ko', '설정 ひらがな').ok).toBe(false);
    expect(checkText('zh-Hant', '設定 カタカナ').ok).toBe(false);
    expect(checkText('zh-Hans', '设置 カタカナ').ok).toBe(false);
  });

  test('clean UI text passes in every locale', () => {
    expect(checkText('en', 'Settings and Reports').ok).toBe(true);
    expect(checkText('ja', '設定とレポート').ok).toBe(true);
    expect(checkText('ko', '설정과 보고서').ok).toBe(true);
    expect(checkText('zh-Hans', '设置和报告').ok).toBe(true);
    expect(checkText('zh-Hant', '設定與報告').ok).toBe(true);
  });

  test('the Traditional-only and Simplified-only sets are disjoint and non-trivial', () => {
    const simplified = new Set([...SIMPLIFIED_ONLY]);
    expect([...TRADITIONAL_ONLY].filter((c) => simplified.has(c))).toEqual([]);
    expect([...TRADITIONAL_ONLY].length).toBeGreaterThanOrEqual(60);
    expect([...SIMPLIFIED_ONLY].length).toBe([...TRADITIONAL_ONLY].length);
  });

  test('every DATA_REGIONS entry is a non-empty selector', () => {
    expect(DATA_REGIONS.length).toBeGreaterThan(0);
    for (const sel of DATA_REGIONS) expect(sel.trim().length, sel).toBeGreaterThan(0);
  });

  test('selftest detects its own planted violation', () => {
    expect(selftest().plantedViolations).toContain('設');
  });

  test('the same text inside a DATA_REGIONS-masked node is not reported, outside it is', async () => {
    const jsdomName = 'jsdom';
    const { JSDOM } = (await import(jsdomName)) as { JSDOM: new (html: string) => { window: any } };
    const dom = new JSDOM(
      '<body><h1>Settings</h1><span class="apps__card-name">範例遊戲</span><p id="leak">範例遊戲</p></body>',
    );
    const g = globalThis as any;
    const saved = { document: g.document, NodeFilter: g.NodeFilter };
    g.document = dom.window.document;
    g.NodeFilter = dom.window.NodeFilter;
    try {
      // 資料區塊內的 Han 被遮掉並計數;區塊外的同一段文字仍然違規。
      const withLeak = collectDomText(DATA_REGIONS);
      expect(withLeak.maskedChars).toBe('範例遊戲'.length);
      expect(checkCollected('en', withLeak).violations.map((v) => v.char)).toEqual([...'範例遊戲']);

      dom.window.document.getElementById('leak')?.remove();
      const clean = collectDomText(DATA_REGIONS);
      const res = checkCollected('en', clean);
      expect(res.ok).toBe(true);
      expect(res.maskedChars).toBe('範例遊戲'.length);
    } finally {
      g.document = saved.document;
      g.NodeFilter = saved.NodeFilter;
    }
  });
});
