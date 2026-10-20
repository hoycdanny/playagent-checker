import { describe, expect, it } from 'vitest';
import { parseLogcat, clockOffset, alignLogcat } from './logcat.ts';
import { formatLine, createBrowserLogs } from '../../../../agent/browserLogs.mjs';

/**
 * 格式約束:網頁任務的瀏覽器 console(agent/browserLogs.mjs)刻意輸出成與真機 logcat
 * 相同的行格式,好讓這裡的 parseLogcat 與 LogcatView 直接重用。
 *
 * 這個測試放在前端是刻意的 —— 約束的內容就是「前端解析得出來」,所以要用前端真正在用的
 * parser 來驗。在 runner 那邊自己寫一份期望格式等於沒驗到:兩邊各自改各自的,照樣會漏。
 */

describe('瀏覽器 console 的輸出能被 parseLogcat 解析', () => {
  it('單行來回:等級、來源、訊息、時間、分頁序號都對得上', () => {
    const at = 1_793_000_000_123;
    const line = formatLine({ at, level: 'E', tag: 'page-error', msg: 'TypeError: x is not a function', pageIndex: 2 });
    const { lines } = parseLogcat(line);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('E');
    expect(lines[0]!.tag).toBe('page-error');
    expect(lines[0]!.msg).toBe('TypeError: x is not a function');
    expect(lines[0]!.t).toBe(at);
    expect(lines[0]!.pid).toBe(2); // pid 欄位借來放「第幾個分頁」
  });

  it('訊息裡有冒號不會切錯來源(HTTP 網址、16:9 這類很常見)', () => {
    const { lines } = parseLogcat(
      formatLine({ at: 1_793_000_000_000, level: 'W', tag: 'network', msg: 'HTTP 404 https://x.test/a.js' }),
    );
    expect(lines[0]!.tag).toBe('network');
    expect(lines[0]!.msg).toBe('HTTP 404 https://x.test/a.js');
  });

  it('每個等級字母都解析得出來(等級篩選才有意義)', () => {
    for (const level of ['V', 'D', 'I', 'W', 'E', 'F', 'A'] as const) {
      const { lines } = parseLogcat(formatLine({ at: 1_793_000_000_000, level, tag: 'console', msg: 'x' }));
      expect(lines[0]!.level).toBe(level);
    }
  });
});

/** 造一個收集器,並記下它寫出的片段內容。 */
function setup() {
  const puts = new Map<string, string>();
  const logs = createBrowserLogs({
    put: async (k: string, b: string) => { puts.set(k, b); },
    prefix: 'p',
    now: () => 1_793_000_000_000,
  });
  const text = () => [...puts.values()][0] ?? '';
  return { logs, text };
}

describe('整個片段(含標頭)在前端的行為', () => {
  it('標頭被 clockOffset 讀成位移 0(瀏覽器與 runner 同一個容器、同時鐘)', async () => {
    const { logs, text } = setup();
    logs.push({ type: 'error', msg: 'boom' });
    await logs.collect(3, 'https://example.test/play');
    expect(clockOffset(text())).toBe(0);
  });

  it('alignLogcat 能把片段攤成依時間排序的行(時間軸連動靠它)', async () => {
    const { logs, text } = setup();
    logs.push({ type: 'log', msg: 'first' });
    logs.push({ level: 'E', tag: 'page-error', msg: 'second' });
    await logs.collect(0, 'https://example.test/');
    const rows = alignLogcat([{ text: text() }]);
    expect(rows.map((r) => r.msg)).toEqual(['first', 'second']);
    expect(rows.every((r) => Number.isFinite(r.t))).toBe(true);
  });

  it('標頭行被當註解略過,不會變成一筆假的 log', async () => {
    const { logs, text } = setup();
    logs.push({ type: 'log', msg: 'only one' });
    await logs.collect(1, 'https://example.test/');
    expect(parseLogcat(text()).lines).toHaveLength(1);
  });

  it('合併重複後的 (xN) 標記不會破壞解析', async () => {
    const { logs, text } = setup();
    logs.push({ type: 'log', msg: 'tick' });
    logs.push({ type: 'log', msg: 'tick' });
    logs.push({ type: 'log', msg: 'tick' });
    await logs.collect(0, 'https://example.test/');
    const { lines } = parseLogcat(text());
    expect(lines).toHaveLength(1);
    expect(lines[0]!.msg).toBe('tick (x3)');
  });
});
