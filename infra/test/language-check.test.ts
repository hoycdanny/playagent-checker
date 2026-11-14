import { describe, expect, test } from 'vitest';
import {
  DATA_REGIONS,
  LOCALES,
  SIMPLIFIED_ONLY,
  TRADITIONAL_ONLY,
  GENERATED_REGIONS,
  JA_NEVER,
  checkCollected,
  checkText,
  collectDomText,
  planMasks,
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

/** 產生文字的遮罩規劃:只遮產生文字區塊裡違規的那一段;區塊外的違規照樣失敗。 */
describe('generated-text masking plan', () => {
  const text = (t: string, gen: number, extra: Record<string, unknown> = {}) => ({
    kind: 'text' as const, node: 0, text: t, origin: 'x', visible: true, data: false, gen, ...extra,
  });

  test('every GENERATED_REGIONS entry has a selector and a reason, and none is also a data region', () => {
    expect(GENERATED_REGIONS.length).toBeGreaterThan(10);
    for (const g of GENERATED_REGIONS) {
      expect(g.sel.trim().length, g.sel).toBeGreaterThan(0);
      expect(g.why.trim().length, g.sel).toBeGreaterThan(0);
      expect(DATA_REGIONS).not.toContain(g.sel);
    }
  });

  test('a violation outside generated regions stays a failure and is not masked', () => {
    const plan = planMasks('en', [text('Settings 設定', -1)]);
    expect(plan.preMaskViolations).toBe(1);
    expect(plan.residual).toHaveLength(1);
    expect(plan.masks).toHaveLength(0);
  });

  test('only the wrong-locale run inside a generated region is masked; the rest of the text stays', () => {
    const plan = planMasks('ko', [text("'大廳'에 도착", 0)]);
    expect(plan.preMaskViolations).toBe(1);
    expect(plan.residual).toHaveLength(0);
    expect(plan.masks.map((m) => m.text)).toEqual(['大廳']);
    expect(plan.masks[0]).toMatchObject({ start: 1, end: 3 });
  });

  test('generated text in the right locale is not masked', () => {
    expect(planMasks('zh-Hant', [text('遊戲主畫面', 0)]).masks).toHaveLength(0);
    expect(planMasks('en', [text('Game lobby', 0)]).masks).toHaveLength(0);
  });

  test('zh-Hans masks Traditional runs from the backend, ja masks Chinese with no kana', () => {
    expect(planMasks('zh-Hans', [text('進入遊戲主要玩法', 0)]).masks.map((m) => m.text)).toEqual(['進入遊戲主要玩法']);
    expect(planMasks('ja', [text('遊戲載入中', 0)]).masks.map((m) => m.text)).toEqual(['遊戲載入中']);
    // 日文介面的漢字標籤(只有新字體)不遮,即使落在報告區塊裡。
    expect(planMasks('ja', [text('ゲームを読み込み中', 0)]).masks).toHaveLength(0);
    for (const label of ['合格', '理由', '評価', '未収集', '期待結果', '対象外']) {
      expect(planMasks('ja', [text(label, 0)]).masks, label).toHaveLength(0);
    }
  });

  test('attribute or invisible generated text is recorded as hidden, not painted', () => {
    const plan = planMasks('en', [
      { kind: 'attr' as const, attr: 'title', node: -1, text: '大廳', origin: 'x [title]', visible: false, data: false, gen: 0 },
      text('大廳', 0, { visible: false }),
    ]);
    expect(plan.masks).toHaveLength(0);
    expect(plan.hidden).toHaveLength(2);
    expect(plan.residual).toHaveLength(0);
  });

  test('no Japanese UI string contains a JA_NEVER character (so the ja rule can never mask UI chrome)', async () => {
    const ts = (await import('typescript')).default;
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = join(__dirname, '..', '..', 'web', 'src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p);
      }
    };
    walk(root);
    let scanned = 0;
    const bad: string[] = [];
    for (const file of files) {
      const rel = relative(root, file).replace(/\\/g, '/');
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: import('typescript').Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          const p = node.parent;
          let ja = rel === 'pages/guide/ja.ts';
          if (ts.isArrayLiteralExpression(p) && p.elements.length === 5 && p.elements.indexOf(node as import('typescript').Expression) === 3) ja = true;
          if (rel === 'i18n/messages.ts') {
            let a: import('typescript').Node | undefined = node;
            while (a && !ts.isVariableDeclaration(a)) a = a.parent;
            if (a && ts.isVariableDeclaration(a) && a.name.getText() === 'ja') ja = true;
          }
          if (ja) {
            scanned += 1;
            if ([...node.text].some((c) => JA_NEVER.includes(c))) bad.push(`${rel}: ${node.text.slice(0, 40)}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(scanned).toBeGreaterThan(1000);
    expect(bad).toEqual([]);
  });

  test('data regions are skipped and counted', () => {
    const plan = planMasks('en', [text('賓果(我的版本)', -1, { data: true })]);
    expect(plan.preMaskViolations).toBe(0);
    expect(plan.dataChars).toBe('賓果(我的版本)'.length);
  });
});
