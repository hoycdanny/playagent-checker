/**
 * 分頁追蹤:決定「現在該對哪個分頁截圖/點擊」。
 *
 * 為什麼需要這個
 * ──────────────
 * 點了 target=_blank 的連結或 window.open 時,Chromium 會建立**另一個 Page 物件**,
 * 原本那個完全不變。如果 client 還抓著舊的 Page:
 *   - 截圖拍到的是沒變化的舊畫面
 *   - DOM 指紋讀的是舊分頁 → 死循環護欄會判定「頁面對操作沒有反應」
 *   - 點擊打在舊分頁上,可能誤觸別的東西
 * 結果就是 AI 看起來卡在原地不動,最後被判卡死。
 *
 * 規則
 * ────
 * 1. 冒出新分頁 → 切過去(使用者點連結的預期就是看新開的那頁)
 * 2. 作用中分頁被關掉 → 退回最近一個還開著的
 * 3. 起始載入期間就自己彈出來的分頁(多半是廣告)→ 納入管理但**不**搶焦點,
 *    因為起始網址是刻意導航的測試目標,不該在第 0 步就被廣告頁蓋掉
 * 4. 每次切換留下一則說明,runner 會轉告 AI —— 否則它看到毫無關聯的新畫面,
 *    會誤以為自己上一步做錯而亂改做法
 *
 * 這個模組刻意不 import playwright:只靠 Page/Context 的鴨子型別,才能用假物件測試。
 */

/** 分頁網址(已關閉的 Page 讀 url() 會拋錯);只用於寫給 AI / log 的說明文字。 */
export function safePageUrl(p) {
  try { return (p && p.url()) || 'about:blank'; } catch { return 'about:blank'; }
}

/**
 * @param {object} o
 * @param {{ on(ev:string, fn:Function):unknown, pages():unknown[] }} o.context
 * @param {object} o.page 起始分頁
 * @param {(p:object)=>unknown} [o.onActiveChange] 作用中分頁換人時呼叫(帶到前景、重綁串流)
 * @param {(m:string)=>unknown} [o.log]
 */
export function createPageTracker({ context, page, onActiveChange = () => {}, onPageAdded = () => {}, log = () => {} }) {
  let pages = [page];
  let active = page;
  let note = '';
  /** 分頁序號(1 起算):console log 借 logcat 的 pid 欄位呈現「這是哪一個分頁」。 */
  let nextIndex = 1;
  const indexOf = new Map();

  /** 納管一個分頁:編號 + 監聽關閉 + 通知呼叫端(掛 console 監聽)。 */
  function adopt(p) {
    if (indexOf.has(p)) return;
    indexOf.set(p, nextIndex++);
    watch(p);
    try { onPageAdded(p, indexOf.get(p)); } catch { /* 監聽掛不上不影響主流程 */ }
  }

  const alive = () => pages.filter((p) => p && !p.isClosed());

  const watch = (p) => {
    p.on('close', () => {
      pages = pages.filter((x) => x !== p);
      if (active === p) {
        const next = [...alive()].reverse()[0];
        if (next) {
          note = `剛才的分頁已關閉,畫面回到上一個分頁(${safePageUrl(next)})。`;
          setActive(next);
        }
      }
    });
  };

  function setActive(p) {
    active = p;
    log(`[pages] 作用中分頁 → ${safePageUrl(p)}(共 ${alive().length} 個)`);
    try { onActiveChange(p); } catch { /* 切換失敗不影響主流程 */ }
  }

  // 起始分頁先編 1 號,再納管起始載入期間已存在的其他分頁(規則 3:不切過去)。
  adopt(page);
  for (const p of context.pages()) {
    if (p !== page) { pages.unshift(p); adopt(p); }
  }

  // 規則 1:之後冒出來的新分頁一律切過去。
  context.on('page', (p) => {
    pages.push(p);
    adopt(p);
    note = `剛才的操作開啟了新分頁,畫面已切換到新分頁(${safePageUrl(p)})。這是正常的,請依新分頁的內容繼續;要回到原本的分頁就用 back。`;
    setActive(p);
  });

  return {
    /**
     * 目前該操作的分頁。作用中分頁若已被關閉(彈出視窗自己關掉),退回還開著的 ——
     * 對已關閉的 Page 操作會拋錯並中斷整個 runner。
     */
    active() {
      if (!active || active.isClosed()) {
        const next = [...alive()].reverse()[0];
        if (next) active = next;
      }
      return active;
    },

    /** 目前開著的分頁數。 */
    get count() {
      return alive().length;
    },

    /** back 用:是不是還有別的分頁可以退回(只剩一個就不能關,否則任務沒頁面了)。 */
    canClosePopup() {
      return alive().length > 1;
    },

    /** 取走「分頁切換了」的說明(取走即清空,只講一次)。 */
    consumeNote() {
      const n = note;
      note = '';
      return n;
    },

    /** 某個分頁的序號(1 起算);沒納管過回 0。 */
    indexOf(p) {
      return indexOf.get(p) ?? 0;
    },
  };
}
