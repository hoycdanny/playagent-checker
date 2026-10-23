import { describe, expect, test } from 'vitest';
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const { foregroundDecision, isGameProc } = await import('../../agent/windowsClient.mjs');

/**
 * 啟動器型遊戲的追蹤規則(新楓之谷:GGMWebStart.exe → Gamania Games Manager → 真正的遊戲)。
 *
 * 真正在跑的是**另一個程序**,我們啟動的那個 exe 交棒後往往就結束了。
 * 原本 ensureForeground 只盯著啟動的 exe,會得到兩個都錯的結論:
 *   - 「程序不在了」→ 判定當掉 → 在遊戲上面一直重開啟動器
 *   - 「前景不是它」→ 判定失焦 → 把焦點從遊戲搶走
 * 兩個都讓測試看起來像遊戲壞了,其實是我們自己在搞;而且症狀很難認
 * (畫面上會有多份啟動器、或遊戲一直被壓到背景),所以把決策抽成純函式釘住。
 *
 * state 對齊 Appium 的 app state:1 = 沒在跑、3 = 在背景、4 = 在前景。
 */

const tracked = (...names: string[]) => new Set(names);

describe('存活判準:追蹤名單裡任何一個還活著就算活著', () => {
  test('啟動器已結束但遊戲還在 → 不重開(這是原本最嚴重的錯誤)', () => {
    const d = foregroundDecision({ alive: 'maplestory', fg: 'maplestory', tracked: tracked('ggmwebstart', 'maplestory') });
    expect(d).toMatchObject({ state: 4, action: 'none', foreground: true });
  });

  test('整條鏈都不在了才重開', () => {
    const d = foregroundDecision({ alive: '', fg: 'explorer', tracked: tracked('ggmwebstart') });
    expect(d).toMatchObject({ state: 1, action: 'relaunch', foreground: false });
  });
});

describe('前景換人:納入追蹤,不要搶焦點', () => {
  test('陌生的非系統程序 = 啟動器剛交棒 → adopt', () => {
    const d = foregroundDecision({ alive: 'ggmwebstart', fg: 'maplestory', tracked: tracked('ggmwebstart') });
    expect(d).toMatchObject({ state: 4, action: 'adopt', adopt: 'maplestory', foreground: true });
    // 關鍵:不是 focus。搶回啟動器等於把剛開起來的遊戲壓到背景。
    expect(d.action).not.toBe('focus');
  });

  test('大小寫不同也算同一個程序', () => {
    const d = foregroundDecision({ alive: 'maplestory', fg: 'MapleStory', tracked: tracked('maplestory') });
    expect(d).toMatchObject({ action: 'none', foreground: true });
  });

  test('更新程式也會被納入(安裝後的 patcher 是另一個程序)', () => {
    const d = foregroundDecision({ alive: 'ggmwebstart', fg: 'ggmpatcher', tracked: tracked('ggmwebstart') });
    expect(d).toMatchObject({ action: 'adopt', adopt: 'ggmpatcher' });
  });
});

describe('只有在前景是系統視窗或取不到時才搶焦點', () => {
  test.each(['explorer', 'dwm', 'node', 'powershell', 'conhost', 'textinputhost'])(
    '%s 不會被誤認為遊戲 → focus 回遊戲',
    (sys) => {
      const d = foregroundDecision({ alive: 'maplestory', fg: sys, tracked: tracked('maplestory') });
      expect(d).toMatchObject({ state: 3, action: 'focus', focus: 'maplestory', foreground: false });
    },
  );

  test('取不到前景(空字串)也是搶焦點,而不是誤 adopt 一個空名稱', () => {
    const d = foregroundDecision({ alive: 'maplestory', fg: '', tracked: tracked('maplestory') });
    expect(d).toMatchObject({ state: 3, action: 'focus', focus: 'maplestory' });
    expect(d.adopt).toBeUndefined();
  });

  test('null / undefined 不會被當成程序名', () => {
    for (const fg of [null, undefined]) {
      const d = foregroundDecision({ alive: 'maplestory', fg, tracked: tracked('maplestory') });
      expect(d.action).toBe('focus');
    }
  });
});

describe('isGameProc', () => {
  test('空值與系統視窗都不是遊戲', () => {
    for (const n of ['', '   ', null, undefined, 'explorer', 'DWM', 'Node']) {
      expect(isGameProc(n)).toBe(false);
    }
  });

  test('遊戲與啟動器都算', () => {
    for (const n of ['maplestory', 'GGMWebStart', 'ggmpatcher']) {
      expect(isGameProc(n)).toBe(true);
    }
  });
});

describe('winHost 要能回答「現在前景是誰」', () => {
  test('WinHelper 有 ForegroundName,winHost 有 fgname 指令', async () => {
    const fs = await import('node:fs/promises');
    const cs = await fs.readFile(new URL('../../agent/WinHelper.cs', import.meta.url), 'utf8');
    const ps = await fs.readFile(new URL('../../agent/winHost.ps1', import.meta.url), 'utf8');
    // 決策函式再怎麼對,拿不到「前景是誰」就全白做 —— 這兩端缺一個就整個失效。
    expect(cs).toContain('public static string ForegroundName()');
    expect(ps).toContain("'fgname'");
  });
});
