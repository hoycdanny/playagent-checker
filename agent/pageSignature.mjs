/**
 * 頁面「互動狀態」指紋 —— 這個函式會被 Playwright 序列化後丟進瀏覽器執行。
 *
 * ⚠ 必須自包含:不可引用模組作用域的任何東西(import、常數、其他函式)。
 *   Playwright 的 page.evaluate 是把 fn.toString() 送進頁面,閉包不會跟著過去。
 *   抽成獨立模組的唯一理由是「讓它可以被測試」——用 stub DOM 在 Node 裡直接呼叫。
 *
 * 用途與取捨見 loopGuard.mjs 的判準演進說明。重點:
 *   - 刻意不取整頁 innerText —— 否則輪播換字就等於「頁面有反應」,護欄會永不觸發
 *   - 取節點總數 —— 抓得到錯誤訊息/彈窗被插入或移除
 *   - 密碼欄只取長度,不取值也不取雜湊(短密碼的雜湊可離線暴力還原)
 */
export function buildPageSignature() {
  // FNV-1a 32-bit:只為了比對「有沒有變」,不是密碼學用途。
  const h = (s) => {
    let x = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x.toString(36);
  };
  const parts = [location.href];
  const active = document.activeElement;
  const fields = document.querySelectorAll('input, textarea, select');
  let i = 0;
  for (const el of fields) {
    const type = String(el.getAttribute('type') || el.tagName).toLowerCase();
    const val = typeof el.value === 'string' ? el.value : '';
    // 密碼欄只記長度;其餘記長度 + 內容雜湊(抓得到「80 → 08」這種等長換序)。
    parts.push(type === 'password' ? `${i}:pw:${val.length}` : `${i}:${type}:${val.length}:${h(val)}`);
    if (el === active) parts.push(`${i}:focus`);
    i++;
  }
  parts.push(`n:${document.getElementsByTagName('*').length}`);
  parts.push(`dlg:${document.querySelectorAll('dialog,[role="dialog"]').length}`);
  return parts.join('|');
}
