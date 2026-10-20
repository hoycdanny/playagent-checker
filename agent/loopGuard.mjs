/**
 * 死循環護欄:判斷任務是不是真的卡在同一個畫面,該提早收斂省錢。
 *
 * 為什麼要有這個模組
 * ──────────────────
 * 舊判準是「AI 給畫面取的名字重複出現 N 次就判死」。這個判準把兩件完全不同的事混在一起:
 *   (A) 真的卡死 —— 做了動作,畫面毫無反應(例:登入失敗彈窗關掉又立刻跳回來)
 *   (B) 正在同一個畫面上做事 —— 登入表單、設定頁、連續 SPIN,本來就要在一個畫面待很多步
 * 只數畫面名的話 (B) 會被誤判成 (A)。實測 job-mvg3h10o:登入表單要「帳號聚焦→輸入→密碼
 * 聚焦→輸入→驗證碼聚焦→四位數字各按一下→送出」至少十步,全部都在「會員登入」這一個畫面,
 * 第 8 步就被判死循環砍掉,當時距離登入完成只差 4 個動作,而那 8 步裡有 7 步畫面確實在變。
 *
 * 現在的判準:**做了動作,畫面卻沒有任何變化**,才算一次無效操作。畫面有變就代表被測目標
 * 有回應,不是卡死 —— 不管它停在同一個畫面名幾次。
 *
 * 配對關係(很容易寫錯)
 * ──────────────────
 * screenChanged 是「上一步動作執行後,畫面有沒有變」,所以要配 prevAction(上一步做了什麼),
 * 不能配這一步還沒執行的 action。拿這一步的動作去配上一步的結果,會把「上一步 wait 沒變化
 * + 這一步要 tap」錯算成一次無效操作。
 *
 * 沒有變化訊號時的退路
 * ──────────────────
 * screenChanged 依賴 pHash,pHash 依賴 ImageMagick(容器裡有裝,但可用性是執行期探測)。
 * 探測失敗時 screenChanged 會恆為 true,新判準就永遠不會觸發 —— 任務失去唯一的收斂保護、
 * 無上限空轉計費。這種環境下退回舊的「同畫面名計數」:寧可偶爾誤殺,也不能讓成本護欄消失。
 */

/** 不算「對畫面動手」的動作:等待載入是正常行為;done 是宣告完成,不是操作。 */
const PASSIVE_ACTIONS = new Set(['wait', 'done']);

/**
 * @typedef {object} LoopObservation
 * @property {string} screen        這一步的畫面名(AI 給的分類標籤)
 * @property {number} step          步序(0 起算;第 0 步沒有「上一步」可比)
 * @property {string} action        這一步準備執行的動作
 * @property {string|null} [prevAction] 上一步實際執行的動作(screenChanged 的成因)
 * @property {boolean} screenChanged 上一步執行後畫面有沒有變
 * @property {boolean} haveChangeSignal 這一步有沒有算出 pHash(false = 拿不到變化訊號)
 */

/**
 * @typedef {object} LoopVerdict
 * @property {boolean} abort   是否該中止任務
 * @property {number} seen     這個畫面名目前累計的無效操作次數
 * @property {boolean} counted 這一步有沒有被計入
 * @property {string} reason   'no_response'(做了動作沒反應)或 'repeat'(退路:同畫面名重複)
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
      const haveChangeSignal = o?.haveChangeSignal !== false;
      const reason = haveChangeSignal ? 'no_response' : 'repeat';

      const counted = haveChangeSignal
        // 主判準:上一步做了實質動作,但畫面毫無反應。
        // 第 0 步沒有「上一步」,screenChanged 無意義,一律不計。
        ? Number(o?.step) > 0
          && !!o?.prevAction
          && !PASSIVE_ACTIONS.has(String(o.prevAction))
          && o?.screenChanged === false
        // 退路:拿不到變化訊號時只能數畫面名,但仍排除純等待與宣告完成。
        : !PASSIVE_ACTIONS.has(String(o?.action ?? ''));

      let seen = seenByScreen.get(screen) || 0;
      if (counted) {
        seen += 1;
        seenByScreen.set(screen, seen);
      }
      return { abort: seen >= limit, seen, counted, reason };
    },

    /** 中止訊息:把「為什麼判死」寫清楚,報告端才不會把量測問題寫成遊戲缺陷。 */
    message(screen, seen, reason) {
      return reason === 'repeat'
        ? `偵測到死循環:畫面「${screen}」反覆出現 ${seen} 次仍無法前進,提早結束。`
        : `偵測到死循環:畫面「${screen}」連續 ${seen} 次操作後畫面都沒有任何反應,提早結束。`;
    },
  };
}
