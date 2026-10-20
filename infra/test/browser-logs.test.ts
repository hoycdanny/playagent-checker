import { describe, expect, test } from 'vitest';
import {
  cleanMessage,
  cleanTag,
  collapseRepeats,
  createBrowserLogs,
  formatLine,
  levelOf,
} from '../../agent/browserLogs.mjs';
/**
 * 註:「輸出格式前端解析得出來」這條約束的測試放在 web 專案
 * (web/src/components/tasks/browserConsole.test.ts),因為 parser 在那邊,
 * 而 infra 的 moduleResolution 是 node16,無法引用前端的 .ts 原始碼。
 * 這裡只測不依賴前端的部分。
 */

/**
 * 瀏覽器 console log。關鍵約束:輸出必須能被前端的 parseLogcat 解析 —— 整套 UI
 * (等級篩選、來源篩選、時間軸連動)是沿用真機 logcat 那條管線的。
 * 所以這裡直接拿前端的 parser 來驗,而不是自己再寫一份期望格式。
 */

describe('levelOf:console 類型 → logcat 等級', () => {
  test('常見類型對應', () => {
    expect(levelOf('error')).toBe('E');
    expect(levelOf('warning')).toBe('W');
    expect(levelOf('info')).toBe('I');
    expect(levelOf('log')).toBe('I');
    expect(levelOf('debug')).toBe('D');
  });

  test('沒見過的類型當一般訊息,不會漏掉', () => {
    expect(levelOf('somethingNew')).toBe('I');
    expect(levelOf(undefined)).toBe('I');
  });
});

describe('cleanMessage / cleanTag', () => {
  test('堆疊追蹤的換行併成一行(logcat 一行一筆)', () => {
    expect(cleanMessage('Error: boom\n  at f()\n  at g()')).toBe('Error: boom |   at f() |   at g()');
  });

  test('超長訊息截斷', () => {
    const out = cleanMessage('x'.repeat(5000));
    expect(out.length).toBeLessThan(2100);
    expect(out).toContain('已截斷');
  });

  test('來源標籤不能含冒號(parseLogcat 以第一個冒號切 tag/msg)', () => {
    expect(cleanTag('console:error')).toBe('console-error');
    expect(cleanTag('')).toBe('console');
  });
});

describe('formatLine', () => {
  test('欄位順序與分隔:<epoch秒.毫秒> <分頁> <tid> <等級> <來源>: <訊息>', () => {
    const line = formatLine({ at: 1_793_000_000_123, level: 'E', tag: 'page-error', msg: 'TypeError: boom', pageIndex: 2 });
    expect(line).toBe('1793000000.123  2  0  E  page-error: TypeError: boom');
  });

  test('epoch 秒至少 9 位數(parseLogcat 的 LINE_RE 要求)', () => {
    const line = formatLine({ at: 1_793_000_000_000, level: 'I', tag: 'console', msg: 'x' });
    expect(/^\d{9,}\.\d{3}\s/.test(line)).toBe(true);
  });

  test('沒給分頁序號時預設 1', () => {
    expect(formatLine({ at: 1_793_000_000_000, level: 'I', tag: 'console', msg: 'x' })).toContain('  1  0  I  ');
  });
});

describe('collapseRepeats:遊戲每幀印同一行時不該塞滿面板', () => {
  test('連續相同的合併成一筆並計數', () => {
    const e = (msg: string, at: number) => ({ level: 'I', tag: 'console', msg, pageIndex: 1, at });
    const out = collapseRepeats([e('tick', 1), e('tick', 2), e('tick', 3), e('other', 4), e('tick', 5)]);
    expect(out.map((x) => [x.msg, x.count])).toEqual([['tick', 3], ['other', 1], ['tick', 1]]);
  });

  test('合併後時間取最後一次(時間軸才對得上最新那筆)', () => {
    const e = (at: number) => ({ level: 'I', tag: 'console', msg: 'same', pageIndex: 1, at });
    expect(collapseRepeats([e(10), e(20), e(30)])[0]!.at).toBe(30);
  });

  test('等級不同就不合併(錯誤不能被一般訊息吃掉)', () => {
    const out = collapseRepeats([
      { level: 'I', tag: 'console', msg: 'x', pageIndex: 1, at: 1 },
      { level: 'E', tag: 'console', msg: 'x', pageIndex: 1, at: 2 },
    ]);
    expect(out).toHaveLength(2);
  });
});

/** 造一個收集器,並記下所有上傳。 */
function setup(now = () => 1_793_000_000_000) {
  const puts = new Map<string, string>();
  const logs = createBrowserLogs({
    put: async (k: string, b: string) => { puts.set(k, b); },
    prefix: 'tenants/t1/jobs/job-1',
    now,
  });
  return { logs, puts };
}

describe('createBrowserLogs:寫出的片段', () => {
  test('路徑與序號符合 devlogs/console/<6位>.txt', async () => {
    const { logs, puts } = setup();
    logs.push({ type: 'log', msg: 'first' });
    await logs.collect(0);
    logs.push({ type: 'log', msg: 'second' });
    await logs.collect(1);
    expect([...puts.keys()]).toEqual([
      'tenants/t1/jobs/job-1/devlogs/console/000000.txt',
      'tenants/t1/jobs/job-1/devlogs/console/000001.txt',
    ]);
  });

  test('沒有訊息就不寫檔(不產生一堆空片段)', async () => {
    const { logs, puts } = setup();
    expect(await logs.collect(0)).toBe(false);
    expect(puts.size).toBe(0);
  });

  test('標頭帶 step / url / dev / sent;dev 與 sent 一致(同容器同時鐘 → 位移 0)', async () => {
    const { logs, puts } = setup();
    logs.push({ type: 'error', msg: 'boom' });
    await logs.collect(3, 'https://example.test/play');
    const head = [...puts.values()][0]!.split('\n')[0]!;
    expect(head).toContain('step=3');
    expect(head).toContain('url=https://example.test/play');
    expect(head).toContain('dev=1793000000.000');
    expect(head).toContain('sent=1793000000000');
  });

  test('每一則都是獨立一行,等級與來源寫對', async () => {
    const { logs, puts } = setup();
    logs.push({ type: 'log', msg: 'hello' });
    logs.push({ level: 'E', tag: 'page-error', msg: 'TypeError: boom' });
    logs.push({ level: 'W', tag: 'network', msg: 'HTTP 404 https://x.test/a.js' });
    await logs.collect(1);
    const body = [...puts.values()][0]!.split('\n').slice(1).filter(Boolean);
    expect(body).toHaveLength(3);
    expect(body[0]).toContain('  I  console: hello');
    expect(body[1]).toContain('  E  page-error: TypeError: boom');
    expect(body[2]).toContain('  W  network: HTTP 404');
  });

  test('collect 之後緩衝清空,同一則不會寫兩次', async () => {
    const { logs, puts } = setup();
    logs.push({ type: 'log', msg: 'once' });
    await logs.collect(0);
    expect(await logs.collect(1)).toBe(false);
    expect(puts.size).toBe(1);
  });

  test('每步行數上限,超過會留下「已省略」而不是整批吞掉', async () => {
    const { logs, puts } = setup();
    for (let i = 0; i < 700; i++) logs.push({ type: 'log', msg: `line ${i}` });
    await logs.collect(0);
    const body = [...puts.values()][0]!.split('\n').slice(1).filter(Boolean);
    expect(body).toHaveLength(501); // 500 筆 + 1 筆省略說明
    expect(body[500]).toContain('已省略 200 筆');
  });

  test('上傳失敗不拋錯(log 不該弄掉整個任務)', async () => {
    const logs = createBrowserLogs({
      put: async () => { throw new Error('s3 down'); },
      prefix: 'p',
    });
    logs.push({ type: 'log', msg: 'x' });
    await expect(logs.collect(0)).resolves.toBe(false);
  });
});

describe('createBrowserLogs:統計(報告會引用)', () => {
  test('分開數錯誤與警告', async () => {
    const { logs } = setup();
    logs.push({ type: 'log', msg: 'a' });
    logs.push({ type: 'error', msg: 'b' });
    logs.push({ type: 'warning', msg: 'c' });
    logs.push({ level: 'F', tag: 'page-error', msg: 'crash' });
    expect(logs.stats).toMatchObject({ all: 4, error: 2, warn: 1, pending: 4 });
    await logs.collect(0);
    expect(logs.stats).toMatchObject({ all: 4, pending: 0, chunks: 1 });
  });

  test('空白訊息不計入', () => {
    const { logs } = setup();
    logs.push({ type: 'log', msg: '   ' });
    logs.push({ type: 'log', msg: '' });
    expect(logs.stats.all).toBe(0);
  });
});
