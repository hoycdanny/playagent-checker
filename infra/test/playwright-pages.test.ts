import { describe, expect, test } from 'vitest';
import { createPageTracker, safePageUrl } from '../../agent/pageTracker.mjs';

/**
 * 分頁追蹤:點連結開新視窗時,Chromium 會建立另一個 Page 物件,原本那個完全不變。
 * 追蹤器若不跟著換,截圖/DOM 指紋/點擊都還對著舊分頁 —— AI 看到的畫面像凍住、
 * 怎麼點都沒反應,最後被死循環護欄判定卡死。
 *
 * pageTracker 刻意不依賴 playwright,只靠 Page/Context 的鴨子型別,所以用假物件就測得到。
 */

type Handler = (...args: unknown[]) => void;

/** 假的 Page:只實作追蹤器會用到的方法。 */
function fakePage(url: string) {
  const handlers = new Map<string, Handler[]>();
  return {
    _url: url,
    _closed: false,
    url() {
      if (this._closed) throw new Error('page closed');
      return this._url;
    },
    isClosed() { return this._closed; },
    on(ev: string, fn: Handler) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev)!.push(fn);
    },
    /** 測試用:模擬分頁被關掉(自己關或我們關)。 */
    emitClose() {
      this._closed = true;
      for (const fn of handlers.get('close') ?? []) fn();
    },
  };
}

/** 假的 Context:可以模擬「冒出一個新分頁」。 */
function fakeContext(initial: ReturnType<typeof fakePage>[]) {
  const handlers = new Map<string, Handler[]>();
  return {
    _pages: [...initial],
    pages() { return this._pages; },
    on(ev: string, fn: Handler) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev)!.push(fn);
    },
    /** 測試用:模擬使用者點了 target=_blank 的連結。 */
    emitNewPage(p: ReturnType<typeof fakePage>) {
      this._pages.push(p);
      for (const fn of handlers.get('page') ?? []) fn(p);
    },
  };
}

function setup(startUrl = 'https://main.test/') {
  const main = fakePage(startUrl);
  const context = fakeContext([main]);
  const switched: string[] = [];
  const tracker = createPageTracker({
    context: context as never,
    page: main as never,
    onActiveChange: (p) => switched.push(safePageUrl(p as never)),
  });
  return { tracker, context, main, switched };
}

describe('開新分頁時,作用中分頁要跟著換', () => {
  test('新分頁出現 → active() 指向新分頁(這就是原本卡住的根因)', () => {
    const { tracker, context, main } = setup();
    expect(tracker.active()).toBe(main);
    const popup = fakePage('https://popup.test/a');
    context.emitNewPage(popup);
    expect(tracker.active()).toBe(popup);
  });

  test('切換會通知呼叫端(client 要帶到前景並重綁即時串流)', () => {
    const { context, switched } = setup();
    context.emitNewPage(fakePage('https://popup.test/a'));
    expect(switched).toEqual(['https://popup.test/a']);
  });

  test('分頁數跟著變', () => {
    const { tracker, context } = setup();
    expect(tracker.count).toBe(1);
    context.emitNewPage(fakePage('https://popup.test/a'));
    expect(tracker.count).toBe(2);
  });

  test('連開兩個分頁 → 停在最後開的那個', () => {
    const { tracker, context } = setup();
    context.emitNewPage(fakePage('https://popup.test/a'));
    const second = fakePage('https://popup.test/b');
    context.emitNewPage(second);
    expect(tracker.active()).toBe(second);
    expect(tracker.count).toBe(3);
  });
});

describe('告訴 AI 畫面為什麼變了', () => {
  test('切換後留下說明,取走一次就清空', () => {
    const { tracker, context } = setup();
    expect(tracker.consumeNote()).toBe('');
    context.emitNewPage(fakePage('https://popup.test/a'));
    const note = tracker.consumeNote();
    expect(note).toContain('新分頁');
    expect(note).toContain('https://popup.test/a');
    expect(tracker.consumeNote()).toBe(''); // 只講一次
  });

  test('分頁關閉也留下說明', () => {
    const { tracker, context } = setup();
    const popup = fakePage('https://popup.test/a');
    context.emitNewPage(popup);
    tracker.consumeNote(); // 清掉「開了新分頁」那則
    popup.emitClose();
    expect(tracker.consumeNote()).toContain('已關閉');
  });
});

describe('分頁關閉後要退回,不能停在死掉的 Page 上', () => {
  test('彈出視窗自己關掉 → 退回原分頁', () => {
    const { tracker, context, main } = setup();
    const popup = fakePage('https://popup.test/a');
    context.emitNewPage(popup);
    expect(tracker.active()).toBe(popup);
    popup.emitClose();
    expect(tracker.active()).toBe(main);
    expect(tracker.count).toBe(1);
  });

  test('關掉的不是作用中分頁 → 作用中分頁不動', () => {
    const { tracker, context, main } = setup();
    const a = fakePage('https://popup.test/a');
    const b = fakePage('https://popup.test/b');
    context.emitNewPage(a);
    context.emitNewPage(b);
    a.emitClose();
    expect(tracker.active()).toBe(b);
    expect(tracker.count).toBe(2);
    expect(main.isClosed()).toBe(false);
  });

  test('作用中分頁被關但沒觸發事件時,active() 仍會自己退回', () => {
    const { tracker, context, main } = setup();
    const popup = fakePage('https://popup.test/a');
    context.emitNewPage(popup);
    popup._closed = true; // 只標關閉,不發事件
    expect(tracker.active()).toBe(main);
  });
});

describe('back 能不能關掉目前分頁', () => {
  test('只有一個分頁 → 不能關(否則整個任務就沒頁面了)', () => {
    const { tracker } = setup();
    expect(tracker.canClosePopup()).toBe(false);
  });

  test('有彈出視窗 → 可以關掉以返回', () => {
    const { tracker, context } = setup();
    context.emitNewPage(fakePage('https://popup.test/a'));
    expect(tracker.canClosePopup()).toBe(true);
  });
});

describe('起始載入期間自己彈出的分頁', () => {
  test('納入管理但不搶焦點(起始網址才是要測的目標)', () => {
    const main = fakePage('https://main.test/');
    const ad = fakePage('https://ad.test/');
    const context = fakeContext([main, ad]);
    const switched: string[] = [];
    const tracker = createPageTracker({
      context: context as never,
      page: main as never,
      onActiveChange: (p) => switched.push(safePageUrl(p as never)),
    });
    expect(tracker.active()).toBe(main);
    expect(tracker.count).toBe(2);
    expect(switched).toEqual([]);       // 第 0 步不該被廣告頁蓋掉
    expect(tracker.consumeNote()).toBe('');
    expect(tracker.canClosePopup()).toBe(true); // 但關得掉
  });
});

describe('safePageUrl', () => {
  test('已關閉的 Page 讀網址不拋錯', () => {
    const p = fakePage('https://x.test/');
    p._closed = true;
    expect(safePageUrl(p as never)).toBe('about:blank');
  });

  test('空網址視為 about:blank', () => {
    expect(safePageUrl(fakePage('') as never)).toBe('about:blank');
    expect(safePageUrl(null)).toBe('about:blank');
  });
});
