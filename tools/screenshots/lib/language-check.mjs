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
  // 內建知識庫的名稱 / 說明來自後端(繁體中文),顯示名稱另有解析,說明文字是知識內容。
  '.kb__card-desc',
  // 知識庫是跨租戶共用的,使用者自己複製 / 建立的知識庫名稱是使用者打的字(例如「賓果(我的版本)」),
  // 屬於資料。內建知識庫的顯示名稱由 kbDisplayName 翻譯,已有單元測試;這幾處清單同時列出兩種,只能整格遮掉。
  '.apps__kb-option > span',
  '.ws__kb-list label > span',
  '.tform__chip > span',
  '.kb__card:not(.kb__card--template) .kb__card-name',
  '.kb__form-sub',
  // 系統更新頁的 commit 訊息來自 GitHub(開發者寫的 git log),是資料,不是介面用語。
  '.sysupd__subject',
  '.sysupd__commits li',
  'td .sysupd__muted',
  // 明確標記為資料的節點(擷取腳本自己加的遮罩也用這個屬性)。
  '[data-capture-data]',
];

/**
 * 「產生出來的文字」區塊:AI 代理與報告引擎的輸出。部署中的代理一律用繁體中文寫步驟說明與畫面名稱
 * (agent/uitarsClient.mjs 預設 Traditional Chinese),報告引擎也會在英文欄位裡寫中文句子,
 * 都不跟介面語系走。這是已知的未完成項目(生成文字的在地化),不是介面翻譯缺漏。
 *
 * 處理方式和 DATA_REGIONS 不同:不會整塊略過。檢查先在「沒遮罩的 DOM」上跑,
 * 只有落在這些區塊裡、而且對該語系違規的那一段文字(連續的中日韓字元)才會在截圖上
 * 蓋一塊明顯的斜紋遮罩,並逐筆寫進 docs/screenshots/<locale>/masks.json。
 * 區塊內語系正確的文字(介面標籤、數字、英文)照原樣留著;區塊外的違規照樣算失敗。
 */
export const GENERATED_REGIONS = [
  // 任務詳情:每一步的畫面名稱、推理、目標、覆核備註、標題。
  { sel: '.detail__step-screen', why: 'agent step: screen name' },
  { sel: '.detail__step-think', why: 'agent step: reasoning' },
  { sel: '.detail__step-goal', why: 'agent step: goal' },
  { sel: '.detail__step-title', why: 'agent step: page title' },
  { sel: '.detail__step-team', why: 'agent step: review notes (title attribute)' },
  { sel: '.detail__head-row', why: 'agent status message' },
  { sel: '.detail__triage', why: 'report verdict reason' },
  { sel: '.detail__booting-text', why: 'agent status message' },
  // 「這一刻」動態、時間軸、彈出式即時畫面。
  { sel: '.mfeed__title', why: 'agent step: screen name and action' },
  { sel: '.mfeed__now-step', why: 'agent step: screen name' },
  { sel: '.mfeed__now-think', why: 'agent step: reasoning' },
  { sel: '.mfeed__body', why: 'agent step: reasoning' },
  { sel: '.ttl__step', why: 'agent step: screen name' },
  { sel: '.ttl__mark', why: 'agent step: screen name (title attribute)' },
  { sel: '.ttl__clip', why: 'agent step: screen name (title attribute)' },
  { sel: '.liveview__step', why: 'agent step: screen name' },
  { sel: '.liveview__msg', why: 'agent status message' },
  { sel: '.devlogs__muted', why: 'agent step: screen name' },
  { sel: '.devlogs__msg', why: 'browser log line annotated by the agent (agent/browserLogs.mjs)' },
  { sel: '.taskicon', why: 'task result message from the report engine (tooltip)' },
  { sel: '.opchat__screen', why: 'agent step: screen name' },
  { sel: '.taskask__msg', why: 'Ask AI answer' },
  { sel: '.tasks__col-case', why: 'task result message (title attribute)' },
  { sel: '.tasks__msg', why: 'task result message' },
  // 指標分析:指標名稱來自後端 {zh,en} 資料。
  { sel: '.lana__label', why: 'backend metric label' },
  // 記憶地圖:畫面名稱與路徑由 AI 在測試中命名。
  { sel: '.sg-node', why: 'memory map: AI-named screen' },
  { sel: '.react-flow__edges', why: 'memory map: AI-named transition (edge label)' },
  { sel: '.react-flow__edgelabel-renderer', why: 'memory map: AI-named transition (edge label)' },
  { sel: '.memory__card', why: 'memory map: AI-named screen' },
  { sel: '.memmap__node', why: 'memory map: AI-named screen' },
  { sel: '.studio__title', why: 'memory map: AI-named screen' },
  { sel: '.studio__tabs', why: 'memory map: AI-named screen (aria-label)' },
  { sel: '.studio__path', why: 'memory map: AI-named screen' },
  { sel: '.studio__stage-name', why: 'memory map: AI-named screen' },
  { sel: '.studio__step-at', why: 'memory map: AI-named screen' },
  { sel: '.studio__step-to', why: 'memory map: AI-named screen' },
  { sel: '.studio__dest', why: 'memory map: AI-named screen' },
  { sel: '.studio__stage-back', why: 'memory map: AI-named screen' },
  { sel: '.studio select', why: 'memory map: AI-named screens in the destination picker' },
  { sel: '.memedit__edge-to', why: 'memory map: AI-named screen' },
  { sel: '.navgraph', why: 'report: AI-named screens' },
  // 結構化報告、AI 洞察、報告助手:報告引擎與模型的輸出。
  { sel: '.srep', why: 'report body generated by the report engine' },
  { sel: '.vm', why: 'report verdict matrix generated by the report engine' },
  { sel: '.ins', why: 'AI insights' },
  { sel: '.report__gallery', why: 'report evidence captions (AI-named screens)' },
  { sel: '.report__trace-reason', why: 'report trace reason' },
  { sel: '.rasst__msg', why: 'report assistant answer' },
  { sel: '.rasst__card', why: 'report assistant: report-engine text' },
  { sel: '.rasst__review', why: 'report assistant: report-engine review items' },
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
  // 與 texts 對齊的來源描述(最近兩層有 class 的祖先),檢查失敗時用來指出是哪個區塊。
  const origins = [];
  const describe = (el, attr) => {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 2; n = n.parentElement) {
      const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      if (cls) parts.unshift(`${n.tagName.toLowerCase()}.${cls}`);
    }
    return `${parts.join(' > ') || el.tagName.toLowerCase()}${attr ? ` [${attr}]` : ''}`;
  };
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
    else {
      texts.push(value);
      origins.push(describe(el));
    }
  }
  for (const el of document.body.querySelectorAll('[placeholder],[title],[aria-label]')) {
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      if (isMasked(el)) maskedChars += v.length;
      else {
        texts.push(v);
        origins.push(describe(el, attr));
      }
    }
  }
  return { texts, origins, maskedChars };
}

/**
 * 對 collectDomText 的結果做檢查。回傳 { ok, violations, maskedChars, sources }。
 * sources:有違規字元的文字來自哪些區塊(去重,附一小段原文),只在帶 origins 時才有內容。
 */
export function checkCollected(locale, collected) {
  const res = checkText(locale, collected.texts.join('\n'));
  const sources = [];
  if (!res.ok && Array.isArray(collected.origins)) {
    const seen = new Set();
    collected.texts.forEach((text, i) => {
      if (checkText(locale, text).ok) return;
      const origin = collected.origins[i] ?? '?';
      if (seen.has(origin)) return;
      seen.add(origin);
      sources.push(`${origin}: ${text.trim().slice(0, 40)}`);
    });
  }
  return { ...res, maskedChars: collected.maskedChars, sources };
}

/**
 * 在瀏覽器裡執行(page.evaluate):收集所有文字節點與 placeholder / title / aria-label 屬性,
 * 並標出各自落在哪個 DATA_REGIONS(data: true)或 GENERATED_REGIONS(gen: 區塊索引,-1 = 不在)。
 * 文字節點暫存在 window.__paCaptureNodes,paintMasks 用索引取回。必須自成一體(會被序列化)。
 */
export function collectDomItems({ data, generated }) {
  const nodes = [];
  window.__paCaptureNodes = nodes;
  const dataSet = new Set();
  for (const sel of data) {
    try {
      document.querySelectorAll(sel).forEach((n) => dataSet.add(n));
    } catch {
      /* 無效的選擇器略過 */
    }
  }
  const genMap = new Map();
  generated.forEach((sel, i) => {
    try {
      document.querySelectorAll(sel).forEach((n) => {
        if (!genMap.has(n)) genMap.set(n, i);
      });
    } catch {
      /* 無效的選擇器略過 */
    }
  });
  // 遮罩自己不算畫面內容。
  const isMaskNode = (el) => !!el.closest('[data-capture-mask]');
  const regionOf = (el) => {
    let gen = -1;
    let inData = false;
    for (let n = el; n; n = n.parentElement) {
      if (dataSet.has(n)) inData = true;
      if (gen < 0 && genMap.has(n)) gen = genMap.get(n);
    }
    return { data: inData, gen };
  };
  const describe = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 2; n = n.parentElement) {
      const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      if (cls) parts.unshift(`${n.tagName.toLowerCase()}.${cls}`);
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  };
  const items = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || isMaskNode(el)) continue;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
    const text = node.nodeValue ?? '';
    if (!text.trim()) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
    // 視覺上隱藏(visually-hidden 的 1px 方塊)的文字不會出現在圖裡。
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    const visible = r.width * r.height >= 16;
    nodes.push(node);
    items.push({ kind: 'text', node: nodes.length - 1, text, origin: describe(el), visible, ...regionOf(el) });
  }
  for (const el of document.body.querySelectorAll('[placeholder],[title],[aria-label]')) {
    if (isMaskNode(el)) continue;
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      // placeholder 會畫在輸入框裡;title / aria-label 不會出現在圖裡。
      const visible = attr === 'placeholder' && !el.value;
      items.push({ kind: 'attr', attr, node: -1, text: v, origin: `${describe(el)} [${attr}]`, visible, ...regionOf(el) });
    }
  }
  return items;
}

/** 連續的中日文字段(漢字、假名、全形標點),中間夾的短英數 / 空白算同一段。韓文不在內。 */
const CJK = '\\u2e80-\\u2fff\\u3000-\\u303f\\u3040-\\u30ff\\u31f0-\\u31ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const CJK_RUN = new RegExp(`[${CJK}]+(?:[\\w \\/·.,:;()#%+'"-]{1,12}[${CJK}]+)*`, 'gu');

/**
 * 日文不會用的字形:繁體中文字形和日本新字體不同的字(戲/戯、廳/庁、證/証…),
 * 以及日文不用的中文字(們、麼、沒…)。正確的日文介面不可能出現這些字。
 * 日文介面本來就用漢字,所以只能用這組字認出「這段是中文」;只由中日共用漢字組成的中文
 * (例如「登入前頁面」)認不出來,不會被遮,這是已知限制。
 */
export const JA_NEVER =
  '來會點擊錄擇戲驗證體關數據對應圖檔變檢說權讀寫總當歸條從裝畫參發營稱覽廳傳實轉鈕滾嘗續顯戶訊' +
  '彈觀號碼聽雙繼們麼沒與處夠啟嗎讓';

/** 這段文字對該語系算不算違規。產生文字區塊裡的日文介面另加一條:含 JA_NEVER 的字就是中文。 */
function wrongLocale(locale, text, inGenerated) {
  if (!checkText(locale, text).ok) return true;
  if (locale === 'ja' && inGenerated && [...text].some((ch) => JA_NEVER.includes(ch))) return true;
  return false;
}

/**
 * 依收集到的項目決定:哪些是真的違規(不在產生文字區塊裡)、哪些要蓋遮罩(可見的產生文字)、
 * 哪些是看不到的產生文字(只在屬性或隱藏節點裡,不用畫,但要記錄)。
 * 回傳 { preMaskViolations, residual, masks, hidden, dataChars }。
 *   preMaskViolations:沒遮罩的 DOM 上違規的項目數(不含 DATA_REGIONS)。
 *   residual:遮罩後仍違規的項目,必須是 0,否則擷取失敗。
 */
export function planMasks(locale, items) {
  const residual = [];
  const masks = [];
  const hidden = [];
  let preMaskViolations = 0;
  let dataChars = 0;
  for (const item of items) {
    if (item.data) {
      dataChars += item.text.trim().length;
      continue;
    }
    const inGen = item.gen >= 0;
    if (!wrongLocale(locale, item.text, inGen)) continue;
    preMaskViolations += 1;
    if (!inGen) {
      residual.push(item);
      continue;
    }
    if (item.kind === 'attr' || !item.visible) {
      hidden.push(item);
      continue;
    }
    let rest = '';
    let last = 0;
    for (const m of item.text.matchAll(CJK_RUN)) {
      if (!wrongLocale(locale, m[0], true, item.text)) continue;
      masks.push({ node: item.node, start: m.index, end: m.index + m[0].length, text: m[0], gen: item.gen, origin: item.origin });
      rest += item.text.slice(last, m.index);
      last = m.index + m[0].length;
    }
    rest += item.text.slice(last);
    if (!checkText(locale, rest).ok) residual.push({ ...item, text: rest });
  }
  return { preMaskViolations, residual, masks, hidden, dataChars };
}

/**
 * 在瀏覽器裡執行:為每一段要遮的文字蓋上斜紋遮罩(明顯是遮罩,不是模糊)。遮罩掛在最近的
 * 定位祖先裡,跟著它捲動;中間有 overflow 裁切的祖先時,遮罩也一起裁切。
 * 回傳每一段實際畫出的方塊([x, y, w, h],以視窗座標)。
 */
export function paintMasks(requests) {
  const nodes = window.__paCaptureNodes ?? [];
  const out = [];
  for (const req of requests) {
    const node = nodes[req.node];
    const boxes = [];
    let misaligned = false;
    if (node && node.isConnected && node.parentElement) {
      const el = node.parentElement;
      let host = el;
      const clips = [];
      for (; host && host !== document.body; host = host.parentElement) {
        const cs = getComputedStyle(host);
        // 遮罩是 HTML div,只能掛在 HTML 元素下(SVG 裡的文字往上找)。
        if (host !== el && cs.position !== 'static' && host instanceof HTMLElement) break;
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') clips.push(host.getBoundingClientRect());
      }
      if (!host || host === document.documentElement) host = document.body;
      const range = document.createRange();
      const len = (node.nodeValue ?? '').length;
      range.setStart(node, Math.min(req.start, len));
      range.setEnd(node, Math.min(req.end, len));
      // 宿主可能被 CSS transform 縮放 / 位移(例如 React Flow 的 viewport,本身寬高是 0):
      // 放一個 100×100 的探針量出宿主座標系在視窗裡的原點與縮放比,不靠 offsetWidth 推算。
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;left:0;top:0;width:100px;height:100px;visibility:hidden;pointer-events:none';
      host.appendChild(probe);
      const pr = probe.getBoundingClientRect();
      probe.remove();
      const sx = pr.width / 100 || 1;
      const sy = pr.height / 100 || 1;
      const hostRect = { left: pr.left, top: pr.top };
      const bx = 0;
      const by = 0;
      for (const r of range.getClientRects()) {
        let x1 = r.left - 1;
        let y1 = r.top - 1;
        let x2 = r.right + 1;
        let y2 = r.bottom + 1;
        for (const c of clips) {
          x1 = Math.max(x1, c.left);
          y1 = Math.max(y1, c.top);
          x2 = Math.min(x2, c.right);
          y2 = Math.min(y2, c.bottom);
        }
        if (x2 - x1 < 2 || y2 - y1 < 2) continue;
        // getClientRects 會對同一行回傳重複或被包含的方塊,畫一次就好。
        if (boxes.some(([bx1, by1, bw, bh]) => x1 >= bx1 - 1 && y1 >= by1 - 1 && x2 <= bx1 + bw + 1 && y2 <= by1 + bh + 1)) continue;
        const d = document.createElement('div');
        d.setAttribute('data-capture-mask', '');
        d.setAttribute('aria-hidden', 'true');
        d.style.cssText = [
          'position:absolute',
          `left:${(x1 - hostRect.left) / sx - bx}px`,
          `top:${(y1 - hostRect.top) / sy - by}px`,
          `width:${(x2 - x1) / sx}px`,
          `height:${(y2 - y1) / sy}px`,
          'z-index:2147483647',
          'pointer-events:none',
          'box-sizing:border-box',
          'border:1px solid #374151',
          'background:repeating-linear-gradient(135deg,#4b5563 0 3px,#d1d5db 3px 6px)',
        ].join(';');
        host.appendChild(d);
        // 畫完量一次:遮罩實際落點必須蓋住那段文字(誤差 2px 內),不然就是沒對準,交給呼叫端判失敗。
        const got = d.getBoundingClientRect();
        if (Math.abs(got.left - x1) > 2 || Math.abs(got.top - y1) > 2 || Math.abs(got.right - x2) > 2 || Math.abs(got.bottom - y2) > 2) {
          misaligned = true;
        }
        boxes.push([Math.round(x1), Math.round(y1), Math.round(x2 - x1), Math.round(y2 - y1)]);
      }
    }
    out.push({ boxes, misaligned });
  }
  return out;
}

/** 在瀏覽器裡執行:拿掉所有遮罩與暫存。 */
export function clearMasks() {
  document.querySelectorAll('[data-capture-mask]').forEach((n) => n.remove());
  delete window.__paCaptureNodes;
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
