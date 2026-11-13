/**
 * 截圖前的語言一致性檢查(純函式,可在 vitest 與擷取腳本兩邊使用)。
 *
 * 檢查對象是「畫面上的 DOM 文字」,不是像素:沒有 OCR,圖片裡的內容(遊戲畫布、串流畫面)
 * 無法檢查,這是已知限制。
 *
 * 每個語系的介面文字不得出現的字元:
 *   en       任何漢字 / 假名 / 韓文
 *   ja       韓文
 *   ko       假名、漢字(介面用韓文)
 *   zh-Hans  假名、韓文、「只在繁體出現」的字
 *   zh-Hant  假名、韓文、「只在簡體出現」的字
 * 合法地使用其他語言的資料區塊(使用者輸入、模型輸出等)由 DATA_REGIONS 先遮掉。
 */

export const LOCALES = ['zh-Hant', 'en', 'zh-Hans', 'ja', 'ko'];

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/u;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;

/** [繁體, 簡體] 字對。兩邊字形必須不同,否則該字兩種語系都合法,不能拿來當判準。 */
const TRAD_SIMP_PAIRS = [
  ['這', '这'], ['個', '个'], ['來', '来'], ['時', '时'], ['會', '会'], ['點', '点'], ['選', '选'],
  ['設', '设'], ['試', '试'], ['戶', '户'], ['務', '务'], ['資', '资'], ['訊', '讯'], ['顯', '显'],
  ['擊', '击'], ['錄', '录'], ['擇', '择'], ['類', '类'], ['態', '态'], ['載', '载'], ['執', '执'],
  ['庫', '库'], ['遊', '游'], ['戲', '戏'], ['驗', '验'], ['證', '证'], ['體', '体'], ['認', '认'],
  ['請', '请'], ['開', '开'], ['關', '关'], ['數', '数'], ['據', '据'], ['對', '对'], ['應', '应'],
  ['圖', '图'], ['檔', '档'], ['變', '变'], ['檢', '检'], ['項', '项'], ['組', '组'], ['結', '结'],
  ['構', '构'], ['說', '说'], ['權', '权'], ['層', '层'], ['錯', '错'], ['誤', '误'], ['讀', '读'],
  ['寫', '写'], ['總', '总'], ['當', '当'], ['歸', '归'], ['記', '记'], ['憶', '忆'], ['條', '条'],
  ['務', '务'], ['異', '异'], ['僅', '仅'], ['從', '从'], ['訂', '订'], ['裝', '装'], ['導', '导'],
  ['鍵', '键'], ['畫', '画'], ['頁', '页'], ['線', '线'], ['網', '网'], ['環', '环'], ['協', '协'],
  ['參', '参'], ['發', '发'], ['營', '营'], ['稱', '称'], ['覽', '览'], ['話', '话'], ['語', '语'],
];

/** 只出現在繁體的字(不含在簡體裡也合法的字)。 */
export const TRADITIONAL_ONLY = [...new Set(TRAD_SIMP_PAIRS.map((p) => p[0]))].join('');
/** 只出現在簡體的字。 */
export const SIMPLIFIED_ONLY = [...new Set(TRAD_SIMP_PAIRS.map((p) => p[1]))].join('');

/**
 * 這些節點裡的文字不是「介面用語」,檢查前先遮掉。每一項都要寫理由。
 * 遊戲畫面本身(Slotomania 的英文文字)只存在於串流 / 截圖圖片內,不在我們頁面的 DOM 裡。
 */
export const DATA_REGIONS = [
  // 使用者輸入的應用名稱(合成資料,名稱本身就是資料)。
  '.apps__card-name',
  // 使用者輸入的案例名稱與任務文字,語言由使用者決定。
  '.cases__table td:first-child',
  '.cases__textarea',
  // 登入者的信箱與租戶標籤:帳號資料,不是介面用語。
  '.topbar__user-info',
  '.usertag',
  // 每一步的推理與 AI 問答的答案:模型輸出,語言由模型與後端 {zh,en} 資料決定。
  '.taskask__msg',
  '.rasst__msg',
  '.srep__card',
  // 記憶地圖的畫面名稱等後端衍生標籤(例如「首頁」)。
  '.memory__card',
  '.memmap__node',
  // 內建知識庫的名稱 / 說明來自後端(繁體中文),顯示名稱另有解析,說明文字是知識內容。
  '.kb__card-desc',
  // 明確標記為資料的節點(擷取腳本自己加的遮罩也用這個屬性)。
  '[data-capture-data]',
];

/** 單一字元是否違規;回傳違規種類或 null。 */
function violationKind(locale, ch) {
  const isHan = HAN.test(ch);
  const isKana = KANA.test(ch);
  const isHangul = HANGUL.test(ch);
  switch (locale) {
    case 'en':
      if (isHan) return 'han';
      if (isKana) return 'kana';
      if (isHangul) return 'hangul';
      return null;
    case 'ja':
      return isHangul ? 'hangul' : null;
    case 'ko':
      if (isKana) return 'kana';
      if (isHan) return 'han';
      return null;
    case 'zh-Hans':
      if (isKana) return 'kana';
      if (isHangul) return 'hangul';
      if (TRADITIONAL_ONLY.includes(ch)) return 'traditional-only';
      return null;
    case 'zh-Hant':
      if (isKana) return 'kana';
      if (isHangul) return 'hangul';
      if (SIMPLIFIED_ONLY.includes(ch)) return 'simplified-only';
      return null;
    default:
      throw new Error(`unknown locale: ${locale}`);
  }
}

/** 檢查一段文字。回傳 { ok, violations: [{ char, kind }] }(同一個字只列一次)。 */
export function checkText(locale, text) {
  const seen = new Map();
  for (const ch of String(text ?? '')) {
    const kind = violationKind(locale, ch);
    if (kind && !seen.has(ch)) seen.set(ch, kind);
  }
  const violations = [...seen].map(([char, kind]) => ({ char, kind }));
  return { ok: violations.length === 0, violations };
}

/**
 * 在瀏覽器裡執行(page.evaluate):收集可見的介面文字,資料區塊先遮掉。
 * 必須自成一體(不能引用模組外的變數),因為會被序列化後送進頁面。
 * 回傳 { texts: string[], maskedChars: number }。
 * 包含 placeholder / title / aria-label 屬性,因為它們也是介面用語。
 */
export function collectDomText(regions) {
  const masked = new Set();
  let maskedChars = 0;
  for (const sel of regions) {
    let nodes = [];
    try {
      nodes = [...document.querySelectorAll(sel)];
    } catch {
      nodes = [];
    }
    for (const n of nodes) masked.add(n);
  }
  const isMasked = (el) => {
    for (let n = el; n; n = n.parentElement) if (masked.has(n)) return true;
    return false;
  };
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el) continue;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
    const value = node.nodeValue ?? '';
    if (!value.trim()) continue;
    // 被藏起來的節點(例如截圖前刻意隱藏的跨租戶列表)不會出現在圖裡。
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
    if (isMasked(el)) maskedChars += value.trim().length;
    else texts.push(value);
  }
  for (const el of document.body.querySelectorAll('[placeholder],[title],[aria-label]')) {
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      if (isMasked(el)) maskedChars += v.length;
      else texts.push(v);
    }
  }
  return { texts, maskedChars };
}

/** 對 collectDomText 的結果做檢查。回傳 { ok, violations, maskedChars }。 */
export function checkCollected(locale, collected) {
  const res = checkText(locale, collected.texts.join('\n'));
  return { ...res, maskedChars: collected.maskedChars };
}

/** 擷取腳本自測:植入一個違規字串,檢查器必須回報;乾淨字串必須通過。 */
export function selftest() {
  const planted = checkText('en', 'Settings 設定');
  if (planted.ok) throw new Error('selftest failed: planted Han in en was not detected');
  const planted2 = checkText('ko', 'ひらがな');
  if (planted2.ok) throw new Error('selftest failed: planted Kana in ko was not detected');
  const clean = checkText('en', 'Settings and Reports');
  if (!clean.ok) throw new Error('selftest failed: clean English text was reported');
  return { plantedViolations: planted.violations.map((v) => v.char).join('') };
}
