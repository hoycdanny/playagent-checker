/**
 * 「剛才那段字到底有沒有進到欄位裡」的判斷 —— 讀回欄位內容之後的三態結論。
 *
 * ⚠ 抽成獨立模組的唯一理由是「讓它可以被測試」(同 frameSignal.mjs / gestures.mjs):
 *   讀欄位要靠 Appium 連真機,但「讀到什麼算成功」是純判斷,而且這個判斷錯了會直接
 *   重現客戶回報的問題 —— 真機上 `mobile: type` 遇到遊戲自繪輸入框會靜默無效,
 *   runner 只看到「type 成功」,於是「測試憑證預設值只能在模擬器上用」。
 *
 * 三態是刻意的,不可以塌成布林:
 *   true  欄位裡確實有這段字 → 成功
 *   false 欄位讀回來明確沒有這段字 → 確定失敗,換下一個輸入管道
 *   null  無法確認(讀不到元件、密碼遮罩)→ 不知道。【不知道不能當成成功】,
 *         但也不能當成失敗去無限重試:呼叫端把它當「可以收工,但不保證」。
 */

/** 密碼欄位常見的遮罩字元(讀回來不是明文,只能看長度)。 */
const MASK = /^[•*●·\u2022\u25cf\u2219\u00b7]+$/;

/**
 * @param {string} want 送進去的字
 * @param {string|null|undefined} got 讀回來的欄位內容
 * @returns {boolean|null}
 */
export function judgeTypedText(want, got) {
  const w = String(want ?? '');
  if (!w) return null;                       // 沒送東西,沒什麼要驗
  const g = got === null || got === undefined ? '' : String(got);
  if (!g) return null;                       // 讀不到內容(Unity canvas、沒有可讀元件)
  if (g.includes(w)) return true;
  const trimmed = g.trim();
  // 密碼遮罩:長度對得上就是「可能成功但無法確認」;長度不對就是確定沒進去
  // (例如欄位只有 2 個點,卻送了 8 個字 —— 那是前一次殘留,不是這次的輸入)。
  if (MASK.test(trimmed)) return trimmed.length === w.length ? null : false;
  return false;
}
