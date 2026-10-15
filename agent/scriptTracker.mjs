/**
 * 測項為主(scripted)的進度追蹤:看得到畫面的視覺 Agent 判斷「做到第幾項」,runner 據此推進與結束。
 *
 * 背景(job-mv95w48j-37kbi3):腳本 4 項「點 PLAY → 領獎 → 關彈窗 → 進任一款遊戲」,第 9 步(約 2 分鐘)
 * 就進了遊戲,但進度原本由看不到畫面的決策 Agent(Nova Micro)猜,它一直沒判斷出第 4 項完成,
 * 又被遊戲自己的新手任務(Spin 3 次、Mission 10/10)與知識庫的「測試重點」帶著走,跑了 2 小時 462 步。
 *
 * 規則:
 *  - 視覺 Agent 每步回報 scriptDone(已完成到第幾項),只增不減。
 *  - 宣告「全部完成」時先停手(這一步不再操作),下一張畫面再確認一次;兩次都成立才結束(防弱模型誤判)。
 *  - 每一項有步數上限(時間盒,預設 20 步);超過 → 判 Blocked,並指出卡在哪一項。
 *    需要重複 / 長時間的測項(「轉 500 局」「AutoSpin」「持續 10 分鐘」)不設上限,由既有的卡死 / 時數保護把關。
 */

/** 長時間 / 重複型測項(不套時間盒):自動旋轉、持續一段時間、RTP / 壓力 / 穩定性。 */
const LONG_ITEM_RE = /auto\s*spin|自動旋轉|自动旋转|持續|持续|连续|連續|直到|until|RTP|壓力|压力|穩定性|稳定性|soak|\d+\s*(?:分鐘|分钟|min(?:ute)?s?|小時|小时|hours?)/i;
/** 「N 局 / N 次 / N spins」:N ≥ 10 才算長測項(轉 3 次這種小測項仍套時間盒)。 */
const COUNT_RE = /(\d[\d,]*)\s*(?:局|次|轉|转|輪|轮|回合|把|場|场|spins?|rounds?|games?|times)/gi;

export const DEFAULT_ITEM_BUDGET = 20;

/** 這一項的步數上限(Infinity = 不限)。 */
export function itemBudgetFor(text, budget = DEFAULT_ITEM_BUDGET) {
  const s = String(text ?? '');
  if (LONG_ITEM_RE.test(s)) return Infinity;
  for (const m of s.matchAll(COUNT_RE)) {
    if (Number(m[1].replace(/,/g, '')) >= 10) return Infinity;
  }
  return budget;
}

/**
 * @param {object} o
 * @param {string[]} o.items 測項原文(與決策 Agent / 前端打勾清單同一份編號)
 * @param {number} [o.itemBudget] 每項步數上限
 */
export function createScriptTracker({ items, itemBudget = DEFAULT_ITEM_BUDGET }) {
  const list = (items ?? []).map((t) => String(t).trim()).filter(Boolean);
  const total = list.length;
  let done = 0; // 已確認完成的項數
  let pendingFinal = false; // 已宣告全部完成,等下一張畫面再確認
  let itemSteps = 0; // 目前這一項已花的步數
  let lastEvidence = '';

  const current = () => Math.min(total, done + 1);
  const setDone = (n) => {
    if (n !== done) itemSteps = 0;
    done = n;
  };

  return {
    get total() { return total; },
    get done() { return done; },
    get current() { return current(); },
    get pendingFinal() { return pendingFinal; },
    get itemSteps() { return itemSteps; },
    get evidence() { return lastEvidence; },
    items: () => list.slice(),

    /**
     * 視覺 Agent 這一步回報的進度。回傳:
     *  - complete:兩次確認都成立 → 所有測項完成
     *  - confirm:第一次宣告全部完成 → 這一步停手,下一張畫面再確認
     *  - advanced:推進到新的項目
     */
    observe(raw, evidence = '') {
      const res = { complete: false, confirm: false, advanced: false, retracted: false };
      if (total === 0) return res;
      const n = Math.max(0, Math.min(total, Math.floor(Number(raw))));
      if (!Number.isFinite(n)) {
        // 確認回合沒有回報 → 視同沒確認(不能讓「沒說」變成通過)。
        if (pendingFinal) { pendingFinal = false; res.retracted = true; }
        return res;
      }
      if (typeof evidence === 'string' && evidence.trim()) lastEvidence = evidence.trim().slice(0, 160);
      if (n >= total) {
        if (pendingFinal) { res.complete = true; done = total; return res; }
        pendingFinal = true;
        // 最後一項先記成「待確認」;前面的項目已確認。
        if (total - 1 > done) { setDone(total - 1); res.advanced = true; }
        res.confirm = true;
        return res;
      }
      if (pendingFinal) { pendingFinal = false; res.retracted = true; }
      if (n > done) { setDone(n); res.advanced = true; }
      return res;
    },

    /** 每執行一步呼叫一次;超過這一項的時間盒回傳 blocked 資訊。 */
    tick() {
      if (total === 0 || pendingFinal) return null;
      itemSteps++;
      const idx = current();
      const budget = itemBudgetFor(list[idx - 1], itemBudget);
      if (itemSteps > budget) return { item: idx, text: list[idx - 1], steps: itemSteps - 1, budget };
      return null;
    },

    /** 系統提示:測項清單 + 回報規則(取代知識庫延伸)。 */
    promptSection() {
      if (total === 0) return '';
      return [
        '',
        '',
        '【測試腳本|測項為主|最高原則】這次只做下面這些測項,全部做到就結束,不要延伸到腳本以外:',
        ...list.map((t, k) => `${k + 1}. ${t}`),
        '規則:',
        `- 每一步的 JSON 都要多加 "scriptDone":<已完成到第幾項,0~${total}> 與 "scriptEvidence":"畫面上證明它完成的東西(30 字內)"。只算你在畫面上看得到證據的項目。`,
        '- 條件式測項(「如果看到…就…」「若出現…」):條件沒有出現就算完成,不用等它出現;已經處理過也算完成。',
        '- 畫面已經證明後面的測項達成(例如已經進入某款遊戲的畫面),前面還沒遇到的條件式測項一併算完成。',
        `- 全部測項都達成時 scriptDone 填 ${total},系統會停手再看一張畫面確認,確認後直接判定通過並結束。不要為了「多驗證一點」繼續操作。`,
        '- 遊戲本身的任務 / 新手任務 / 每日獎勵 / 指定轉動次數(例如「Spin 3 次」「Mission 7/10」)不是測試腳本:測項沒寫就不要去完成。新手教學只在擋住下一個測項時才照做。',
        '- 知識庫與背景知識只用來看懂畫面,不要照它延伸測試(例如多轉幾局、測免費遊戲、逛其他頁面)。',
      ].join('\n');
    },

    /** 每一回合的進度提示。 */
    turnNote() {
      if (total === 0) return '';
      if (pendingFinal) {
        return `\n【測項確認|測項為主】上一步你回報 ${total} 項全部完成(證據:${lastEvidence || '—'})。請看這張最新畫面再確認一次:` +
          `仍符合最後一項「${list[total - 1]}」→ scriptDone 填 ${total} 並用 wait;不符合 → scriptDone 填 ${total - 1} 並繼續做這一項。`;
      }
      const cur = current();
      const budget = itemBudgetFor(list[cur - 1], itemBudget);
      const left = Number.isFinite(budget) ? `(這一項還剩 ${Math.max(0, budget - itemSteps)} 步,做不到會判 Blocked)` : '';
      return `\n【測項進度|測項為主】已完成 ${done}/${total}。目前第 ${cur} 項:「${list[cur - 1]}」${left}。只做這一項需要的操作。`;
    },
  };
}
