/**
 * 死循環護欄:判斷任務是不是真的卡在同一個畫面,該提早收斂省錢。
 *
 * 判準演進(兩次都踩在同一個坑的不同層,記下來免得再來第三次)
 * ──────────────────────────────────────────────────
 * v1「同一個畫面名出現 N 次就判死」
 *   把兩件完全不同的事混在一起:
 *     (A) 真的卡死 —— 做了動作,頁面毫無反應
 *     (B) 正在同一個畫面上做事 —— 登入表單、設定頁,本來就要在一個畫面待很多步
 *   實測 job-mvg3h10o:登入表單至少十步都在「會員登入」,第 8 步被砍,
 *   當時距離登入完成只差 4 個動作,而那 8 步裡有 7 步畫面確實在變。
 *
 * v2「做了動作但畫面沒變才計數」,變化訊號用截圖 pHash
 *   方向對,但訊號選錯。pHash 的門檻必須留餘裕給裝飾性動畫當雜訊,於是偵測不到
 *   「在輸入框打一個字」。在表單上「pHash 沒變」是每一步的常態 —— 等於換了一種誤判。
 *   實測 job-mvgdtt5i:驗證碼欄 8 → 80 → 080 每步都有效,pHash 全回報沒變,
 *   第 17 步被砍,砍在 AI 正確決定「清除鍵不穩,改按刷新驗證碼」那一步。
 *
 * v3(現在)判準不變,但**變化訊號由呼叫端決定**,而且可以是多個訊號的聯集。
 *   web runner 餵「DOM 互動狀態指紋有沒有變 或 pHash 有沒有變」:
 *     - 表單打字 → DOM 抓得到(input.value 必變),pHash 抓不到
 *     - canvas 遊戲 → pHash 抓得到,DOM 抓不到(DOM 是靜態的)
 *   兩個都說沒變,才算一次無效操作。護欄只在「所有訊號都看不到反應」時才計數。
 *
 * 配對關係(很容易寫錯)
 * ──────────────────
 * changed 是「上一步動作執行後,狀態有沒有變」,所以要配 prevAction(上一步做了什麼),
 * 不能配這一步還沒執行的 action。拿這一步的動作去配上一步的結果,會把
 * 「上一步 wait 沒變化 + 這一步要 tap」錯算成一次無效操作。
 *
 * 拿不到任何變化訊號時(changed = null)
 * ──────────────────
 * 退回 v1 的「同畫面名計數」。寧可偶爾誤殺,也不能讓成本護欄整個消失 —— 否則任務只剩
 * 步數上限與預算在擋,會一路空轉燒到底。
 */

/** 不算「對頁面動手」的動作:等待載入是正常行為;done 是宣告完成,不是操作。 */
const PASSIVE_ACTIONS = new Set(['wait', 'done']);

/**
 * @typedef {object} LoopObservation
 * @property {string} screen   這一步的畫面名(AI 給的分類標籤)
 * @property {number} step     步序(0 起算;第 0 步沒有「上一步」可比)
 * @property {string} action   這一步準備執行的動作
 * @property {string|null} [prevAction] 上一步實際執行的動作(changed 的成因)
 * @property {boolean|null} changed 上一步執行後狀態有沒有變;null = 完全拿不到訊號
 */

/**
 * @typedef {object} LoopVerdict
 * @property {boolean} abort   是否該中止任務
 * @property {number} seen     這個畫面名目前累計的無效操作次數
 * @property {boolean} counted 這一步有沒有被計入
 * @property {'no_response'|'repeat'} reason 判死依據
 */

export function createLoopGuard(options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 8;
  /** 畫面名 → 無效操作累計次數 */
  const seenByScreen = new Map();

  return {
    get limit() {
      return limit;
    },

    /** 目前各畫面的累計次數(除錯用快照)。 */
    snapshot() {
      return new Map(seenByScreen);
    },

    /** 換新的被測目標/重啟後歸零,次數不跟前一段混。 */
    reset() {
      seenByScreen.clear();
    },

    /**
     * 記一步並回報是否該中止。
     * @param {LoopObservation} o
     * @returns {LoopVerdict}
     */
    observe(o) {
      const screen = String(o?.screen ?? '');
      const changed = o?.changed;
      const hasSignal = changed === true || changed === false;

      const counted = hasSignal
        // 主判準:上一步做了實質動作,但所有訊號都看不到反應。
        // 第 0 步沒有「上一步」,changed 無意義,一律不計。
        ? Number(o?.step) > 0
          && !!o?.prevAction
          && !PASSIVE_ACTIONS.has(String(o.prevAction))
          && changed === false
        // 退路:拿不到變化訊號時只能數畫面名,但仍排除純等待與宣告完成。
        : !PASSIVE_ACTIONS.has(String(o?.action ?? ''));

      let seen = seenByScreen.get(screen) || 0;
      if (counted) {
        seen += 1;
        seenByScreen.set(screen, seen);
      }
      return {
        abort: seen >= limit,
        seen,
        counted,
        reason: hasSignal ? 'no_response' : 'repeat',
      };
    },

    /** 中止訊息:把「為什麼判死」寫清楚,報告端才不會把量測問題寫成遊戲缺陷。 */
    message(screen, seen, reason) {
      return reason === 'repeat'
        ? `偵測到死循環:畫面「${screen}」反覆出現 ${seen} 次仍無法前進,提早結束。`
        : `偵測到死循環:畫面「${screen}」連續 ${seen} 次操作後,頁面狀態與畫面都沒有任何變化,提早結束。`;
    },
  };
}
