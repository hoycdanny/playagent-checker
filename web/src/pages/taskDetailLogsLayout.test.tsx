import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { I18nProvider } from '../i18n/I18nProvider.tsx';
import { TakeoverScriptSave } from '../components/tasks/TakeoverScriptSave.tsx';

/**
 * 任務詳情頁「完整日誌」分頁的版面契約。
 *
 * 跑版的成因(兩件事湊在一起):
 *   1. 接管區塊 TakeoverScriptSave 的根節點掛 .dstage__panel,而 .dstage__panel 是設計給
 *      「填滿整個 stage 的頂層面板」用的,帶著 flex: 1 1 0。被重用成 .dstage__logs 的子元素
 *      之後,它就跟日誌面板平分整欄高度 —— 一半給日誌,一半給一個標題加一顆按鈕。
 *      日誌那一半先被標題 / 分頁列 / 篩選列 / 行數列吃掉,.devlogs__log 自己是 overflow: auto
 *      的捲動容器(捲動容器的自動最小高度是 0),所以被壓到只剩一兩行;壓不下的固定列又從
 *      沒有 overflow 的 .devlogs 溢出去,正好疊在接管區塊的標題上。
 *   2. 接管區塊在「這次沒接管過」時照樣整塊渲染,要等使用者按下按鈕、後端回 404 才說沒紀錄。
 *      絕大多數任務沒接管過,所以它對他們永遠是純佔位,擠掉的是日誌的高度。
 *
 * jsdom 不做版面計算,量不到實際高度,所以這裡守的是讓這個版面成立的結構條件:
 * 沒接管過就不渲染、有接管過也只拿自然高度、日誌面板與日誌本體各有最小高度下限,
 * 以及高度不夠時由外層整欄捲動(而不是裁掉或疊住接管區塊)。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const pageCss = readFileSync(join(HERE, 'TaskDetailPage.css'), 'utf8');
const logsCss = readFileSync(join(HERE, '..', 'components', 'tasks', 'DeviceLogsPanel.css'), 'utf8');

/**
 * 取某個選擇器(完全相符)的所有宣告,串成一段文字。
 * 同一支 CSS 裡後面的規則覆蓋前面的,而這裡要問的是「有沒有設過這條」,所以串起來看就夠。
 */
function declsOf(css: string, selector: string): string {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (sels.includes(selector)) out.push(m[2]!);
  }
  return out.join('\n');
}

/** 取某個屬性最後一次被設定的值(沒設過回 null)。 */
function prop(decls: string, name: string): string | null {
  const hits = [...decls.matchAll(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;}]+)`, 'g'))];
  return hits.length ? hits[hits.length - 1]![1]!.trim() : null;
}

describe('接管區塊與日誌面板是同一個 flex 欄的兄弟', () => {
  test('TakeoverScriptSave 的根節點掛 dstage__panel(CSS 修法鎖的就是這個選擇器)', () => {
    const { container } = render(
      <I18nProvider><TakeoverScriptSave jobId="job-1" /></I18nProvider>,
    );
    const root = container.firstElementChild!;
    expect(root.tagName).toBe('SECTION');
    expect(root.classList.contains('dstage__panel')).toBe(true);
  });

  test('TaskDetailPage 把日誌面板與接管區塊放進同一個 .dstage__logs', () => {
    const tsx = readFileSync(join(HERE, 'TaskDetailPage.tsx'), 'utf8');
    const block = tsx.slice(tsx.indexOf('detail__col--devlogs dstage__logs'));
    expect(block.indexOf('<DeviceLogsPanel')).toBeGreaterThan(-1);
    expect(block.indexOf('<TakeoverScriptSave')).toBeGreaterThan(block.indexOf('<DeviceLogsPanel'));
  });
});

/**
 * 這組是跑版的另一半,而且是使用者真正在抱怨的那一半:接管區塊在「這次沒接管過」時
 * 照樣整塊渲染,擠掉日誌的高度,換來的只是一顆按下去才說「這裡沒東西」的按鈕。
 *
 * 這裡是**原始碼層級**的斷言,不是渲染測試:TaskDetailPage 要先 mock useJobStream 與
 * 一整排 API 才渲染得起來,目前沒有那個骨架。所以它守得住的是「有人把條件拿掉」,
 * 守不住「條件寫錯」。條件本身的正確性靠的是 runner 那邊寫入欄位的程式碼
 * (agent/explorationRunner.mjs 的 by:'operator' + takeover:true)。
 */
describe('沒接管過就不要畫接管區塊', () => {
  const tsx = readFileSync(join(HERE, 'TaskDetailPage.tsx'), 'utf8');

  test('渲染處被條件守住,不是無條件畫出來', () => {
    const at = tsx.indexOf('<TakeoverScriptSave');
    expect(at).toBeGreaterThan(-1);
    // 往前看一小段,要有 `{xxx && ` 把它包起來。
    const before = tsx.slice(Math.max(0, at - 160), at);
    expect(before, '<TakeoverScriptSave 看起來是無條件渲染的').toMatch(/\{\s*\w+\s*&&\s*$/);
  });

  test('判斷依據是步驟上的接管標記,而不是「有沒有 jobId」之類無關的條件', () => {
    const at = tsx.indexOf('<TakeoverScriptSave');
    const guard = /\{\s*(\w+)\s*&&\s*$/.exec(tsx.slice(Math.max(0, at - 160), at))?.[1];
    expect(guard).toBeTruthy();
    // 那個變數的定義要真的去看 steps 的 takeover / by 欄位。
    const def = new RegExp(`const\\s+${guard}\\s*=\\s*([^;]+);`).exec(tsx)?.[1] ?? '';
    expect(def, `${guard} 的定義沒有看 steps`).toContain('steps');
    expect(def, `${guard} 的定義沒有看接管標記`).toMatch(/takeover|operator/);
  });

  test('步驟型別宣告了這兩個欄位(沒宣告的話條件會永遠是 false,而且 tsc 不會攔)', () => {
    const stream = readFileSync(join(HERE, '..', 'api', 'useJobStream.ts'), 'utf8');
    const step = stream.slice(stream.indexOf('export interface Step'));
    const body = step.slice(0, step.indexOf('}'));
    expect(body).toMatch(/\btakeover\?:\s*boolean/);
    expect(body).toMatch(/\bby\?:\s*string/);
  });
});

describe('完整日誌分頁的高度分配', () => {
  test('接管區塊只拿自然高度,不跟日誌面板分一半', () => {
    const flex = prop(declsOf(pageCss, '.dstage__logs > .dstage__panel'), 'flex');
    expect(flex, '.dstage__logs > .dstage__panel 沒有把通用的 flex: 1 1 0 收掉').not.toBeNull();
    expect(flex).toMatch(/^(none|0 0 auto)$/);
  });

  test('日誌面板有最小高度,不准被壓到只剩標題列', () => {
    const minH = prop(declsOf(pageCss, '.dstage__logs > .devlogs'), 'min-height');
    expect(minH, '.dstage__logs > .devlogs 沒有設 min-height').not.toBeNull();
    expect(minH, '.dstage__logs > .devlogs 的 min-height 還是 0').not.toBe('0');
  });

  test('高度不夠時整欄自己捲動,而不是裁掉或疊住接管區塊', () => {
    const decls = declsOf(pageCss, '.dstage__logs');
    expect(prop(decls, 'overflow-y'), '.dstage__logs 仍是 overflow: hidden,接管區塊會被裁掉').toBe('auto');
  });
});

describe('日誌本體的高度下限', () => {
  const SELECTOR = '.devlogs > .devlogs__log';
  const MIN_PX = 120;

  test('日誌本體自己是捲動容器(所以自動最小高度是 0,非得明寫下限不可)', () => {
    expect(prop(declsOf(logsCss, '.devlogs__log'), 'overflow')).toBe('auto');
  });

  test('三個捲動容器都有像素下限,擠不下就由外層捲動', () => {
    const decls = declsOf(logsCss, SELECTOR);
    const minH = prop(decls, 'min-height');
    expect(minH, `${SELECTOR} 的 min-height 是 ${minH}`).toMatch(/^\d+px$/);
    expect(Number.parseInt(minH!, 10)).toBeGreaterThanOrEqual(MIN_PX);
    // 音效表格與 Agent 軌跡跟日誌本體共用同一條規則,一起守。
    for (const sel of ['.devlogs > .devlogs__agent-wrap', '.devlogs > .devlogs__table-wrap']) {
      expect(prop(declsOf(logsCss, sel), 'min-height'), `${sel} 沒有高度下限`).toBe(minH);
    }
  });
});
