/**
 * 記憶導覽圖(Memory Navigation Graph)—— runner 與 API 共用的純函式(無 I/O、無相依)。
 *
 * 問題(舊做法):page id = hash(AI 自由命名的畫面名)。AI 對同一畫面每步命名不同
 * (「大廳」「大廳頁面」「大廳-機台列表空白」),於是同一畫面變成多個節點;邊又在任何
 * 相鄰兩步都建立(含 wait、動畫),關係圖雜亂,也無法拿來引導 agent。
 *
 * 新做法(更接近遊戲的正式畫面流程圖):
 *  1. 畫面身分 = 視覺指紋(pHash,保留多個樣本以容忍動畫)+ 正規化畫面名 + AI 標的模組。
 *     - 視覺很接近且名稱相容 → 同一畫面(AI 換了說法也合併)。
 *     - 正規化名稱相同且模組相同 → 同一畫面(戰鬥/轉軸等動態畫面視覺每幀不同)。
 *     - 其餘才建新節點。所有見過的命名都記為 aliases,節點顯示最常用的名字。
 *  2. 載入/過場類畫面統一收斂成「載入中」節點(transient),不會到處長出孤兒節點。
 *  3. 邊只在「畫面真的換了」時建立:觸發 = 上一步的動作 + 目標元件(如 tap PLAY);
 *     上一步是 wait 則記為 auto(自動轉場)。自環不存。
 *  4. 同一個操作在某畫面沒效果(畫面沒變)→ 該操作既有邊的 missCount+1,標示不可靠路徑。
 *  5. compactStructure() 可把舊格式的雜亂資料就地收斂(讀取時套用,舊資料也變乾淨)。
 *  6. summarizeForAgent() 把圖轉成精簡文字注入 agent(已知畫面與可靠路徑),正確引導測試引擎。
 */

export const GRAPH_SCHEMA_VERSION = 2;

/** 視覺「幾乎相同」門檻(1024-bit pHash 漢明距離;同畫面通常 < 40)。 */
const STRONG_MATCH = 48;
/** 視覺「相近」門檻(需再搭配名稱相容才合併)。 */
const WEAK_MATCH = 110;
/** 每個節點保留的 pHash 樣本數(動態畫面需要多個樣本)。 */
const MAX_HASH_SAMPLES = 6;
const INTERACTIVE = new Set(['tap', 'swipe', 'move', 'type', 'back', 'launch', 'hold', 'key']);
/** 可以由記憶直接重播的動作(launch 會重開遊戲,不重播)。 */
const REPLAYABLE = new Set(['tap', 'swipe', 'hold', 'back', 'type', 'key', 'move']);
const OP_DIRS = new Set(['up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright']);
/** 同一畫面上的操作(例如 SPIN)最多記幾種。 */
const MAX_SELF_OPS = 12;

const TRANSIENT_RE = /loading|載入|载入|請稍候|请稍候|連線中|连接中|connecting|進場|进场|過場|过场|splash|logo|品牌動畫|品牌动画|config\s*ready|installing|安裝中|安装中/i;
/** 沒有描述是哪一種載入時的預設名稱。 */
export const TRANSIENT_NAME = '載入中';
/** 只有「載入中」這類泛稱、沒說是載入什麼的名稱(這種只能靠畫面長相分辨)。 */
const GENERIC_TRANSIENT_RE = /^(載入中?|载入中?|讀取中|读取中|loading|請稍候|请稍候|連線中|连接中|connecting|過場|过场|進場|进场|splash|logo|載入畫面|载入画面|loading screen)$/i;

/**
 * 載入/過場類畫面(Logo、廣告載入、機台載入…)。2026-10-11 起「每一種載入畫面各自一個節點」:
 * 以前全部併成單一「載入中」,但不同載入畫面載的是不同東西(遊戲啟動、機台、活動廣告),
 * 併在一起後流程看不出是從哪裡載入到哪裡。現在仍標 transient(可隱藏、不給 AI 當目標),但身分各自獨立。
 */
export function isTransientName(name) {
  return TRANSIENT_RE.test(String(name ?? ''));
}
function isGenericTransient(canon) {
  return !canon || GENERIC_TRANSIENT_RE.test(canon.replace(/\s+/g, ' ').trim());
}
/** 載入畫面的顯示名:保留「載入什麼」的描述,只去掉進度數字(「LOADING 100%」「(3/3)」)。 */
function transientDisplayName(name) {
  const s = String(name ?? '')
    .replace(/\s*[\d.]+\s*%/g, '')
    .replace(/\s*[((]?\s*\d+\s*\/\s*\d+\s*[))]?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 「載入中(Newbie's Mission) LOADING」:描述之後多餘的進度字樣去掉(只剩泛稱時保留)。
  const tail = s.replace(/\s*(loading|now loading|載入中|读取中|讀取中)\s*[.…]*$/i, '').trim();
  return (tail && tail !== s && !isGenericTransient(tail.toLowerCase()) ? tail : s) || TRANSIENT_NAME;
}

/** 1024-bit hex pHash 的漢明距離;無法比較回 Infinity。 */
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/**
 * 正規化畫面名:去掉 AI 加的狀態描述/裝飾,只留「這是哪個畫面」。
 * 例:「大廳-機台列表空白」→「大廳」;「轉軸畫面(第 3 次 Spin)」→「轉軸」;「Main Menu Screen」→「main menu」。
 */
/** runner 在 AI 沒給畫面名時用的佔位名(如「畫面 27」)—— 不是真的畫面,不進圖。 */
const PLACEHOLDER_RE = /^(畫面|画面|screen)\s*\d+$/i;
export function isPlaceholderName(name) {
  return !String(name ?? '').trim() || PLACEHOLDER_RE.test(String(name).trim());
}

/** 去掉 AI 加在畫面名上的狀態描述、序號、泛稱尾綴(保留原大小寫,供顯示)。 */
export function displayName(name) {
  let s = String(name ?? '').trim();
  if (!s) return '';
  if (TRANSIENT_RE.test(s)) return transientDisplayName(s);
  const orig = s;
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.split(/\s*[-–—:：|/／>→+]\s*/)[0];                                   // 去掉「-狀態描述」「1/7」
    s = s.replace(/[（(\[【「].*$/, '');                                         // 去掉括號補充
    s = s.replace(/\s*(剩|第)?\s*[\d,.]+\s*(次|步|關|关|波|k|K|m|M)?\s*$/, '');  // 去掉尾端數字(計數/金額/序號)
    s = s.trim();
    if (s === before) break;
  }
  return s || orig;
}

/** 比對用的正規化名稱(displayName + 小寫 + 去空白)。 */
export function canonicalName(name) {
  const d = displayName(name);
  if (isTransientName(d)) return d.replace(/\s+/g, ' ').trim().toLowerCase();
  // 比對時再去掉「畫面/頁面/screen」等泛稱尾綴(顯示名保留,讀起來較自然)。
  const stripped = d.replace(/\s*(畫面|画面|頁面|页面|介面|界面|視窗|视窗|screen|page|view)\s*$/i, '').trim() || d;
  return stripped.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 只是修飾、不改變「是哪個畫面」的字(差異只由這些字組成時視為同名)。 */
const FILLER_RE = /^(主|遊戲|游戏|進行|进行|中|的|game|main|the|s|\s)+$/i;

/** 兩個正規化名稱是否視為同一畫面:相同,或一方包含另一方且差異只有修飾字(「大廳」≈「遊戲大廳」,但「免費遊戲」≠「免費遊戲結算」)。 */
function namesEquivalent(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 2 || !long.includes(short)) return false;
  const rest = long.replace(short, '');
  return FILLER_RE.test(rest);
}

/** 兩個正規化名稱是否相容(可在視覺很接近時合併):相等、包含關係。 */
function namesCompatible(a, b) {
  if (!a || !b) return true;
  if (a === b) return true;
  return a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));
}

function stableId(seed) {
  let h = 2166136261;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return `page_${h.toString(16).padStart(8, '0')}`;
}

export function emptyStructure(appName) {
  return { schemaVersion: GRAPH_SCHEMA_VERSION, appName: appName ?? '', rootPageId: null, pages: {}, edges: [], lastUpdatedAt: null };
}

function pageHashes(p) {
  const list = Array.isArray(p.pHashes) ? p.pHashes : [];
  return p.pHash && !list.includes(p.pHash) ? [p.pHash, ...list] : list;
}

function bumpAlias(page, rawName) {
  const n = String(rawName ?? '').trim();
  if (!n) return;
  page.aliases = page.aliases && typeof page.aliases === 'object' ? page.aliases : {};
  page.aliases[n] = (page.aliases[n] ?? 0) + 1;
  refreshName(page);
}

/** 顯示名 = 最常用命名去掉狀態描述/序號後的形式;載入畫面優先用「有說載入什麼」的命名。 */
function refreshName(page) {
  const ranked = Object.entries(page.aliases ?? {}).sort((a, b) => b[1] - a[1]);
  if (page.transient) {
    const specific = ranked.find(([n]) => !isGenericTransient(canonicalName(n)));
    page.name = transientDisplayName((specific ?? ranked[0])?.[0] ?? TRANSIENT_NAME);
    return;
  }
  const top = ranked[0];
  if (top) page.name = displayName(top[0]) || top[0];
}

/** 找最佳匹配頁;回 page id 或 null。 */
function findMatch(struct, { canon, pHash, module, transient = false }) {
  let best = null;
  let bestScore = Infinity;
  for (const p of Object.values(struct.pages)) {
    const pc = p.canonical ?? canonicalName(p.name);
    const sameModule = !module || !p.module || p.module === module;
    const dist = pHash ? Math.min(Infinity, ...pageHashes(p).map((h) => hamming(pHash, h))) : Infinity;
    if (transient || p.transient) {
      // 載入畫面只跟載入畫面比:長得幾乎一樣 = 同一個;或描述了「載入什麼」且描述相同。
      // 只寫「載入中」的泛稱不靠名字合併(否則不同的載入畫面又全疊在一起)。
      if (!(transient && p.transient)) continue;
      let score = Infinity;
      if (dist <= STRONG_MATCH) score = dist;
      else if (canon === pc && !isGenericTransient(canon) && sameModule) score = STRONG_MATCH + 1;
      if (score < bestScore) { bestScore = score; best = p.id; }
      continue;
    }
    let score = Infinity;
    // 視覺幾乎相同:還需名稱相容,或兩邊都有標模組且相同(避免把「純色背景上的不同彈窗」硬併)。
    const bothSameModule = Boolean(module && p.module && module === p.module);
    if (dist <= STRONG_MATCH && (namesCompatible(canon, pc) || bothSameModule)) score = dist;
    else if (canon && canon === pc && sameModule) score = STRONG_MATCH + 1;                         // 同名同模組(動態畫面)
    else if (namesEquivalent(canon, pc) && sameModule) score = STRONG_MATCH + 2;                    // 只差修飾字(「大廳」≈「遊戲大廳」)
    else if (dist <= WEAK_MATCH && namesCompatible(canon, pc) && sameModule) score = STRONG_MATCH + 3 + dist; // 相近 + 名稱相容
    if (score < bestScore) { bestScore = score; best = p.id; }
  }
  return best;
}

/**
 * 加入/命中一個畫面。回 { pageId, isNew }。
 * frame: { name, pHash?, module?, at? }
 */
export function upsertPage(struct, frame) {
  // AI 沒給畫面名(解析失敗等)時不進圖:回 null,呼叫端維持上一個畫面當起點。
  if (isPlaceholderName(frame.name)) return { pageId: null, isNew: false };
  const now = frame.at ?? new Date().toISOString();
  const canon = canonicalName(frame.name);
  const transient = isTransientName(frame.name);
  const id = findMatch(struct, { canon, pHash: frame.pHash, module: frame.module, transient });
  if (id) {
    const p = struct.pages[id];
    p.visitCount = (p.visitCount ?? 0) + 1;
    p.lastSeenAt = now;
    if (frame.module && !p.module) p.module = frame.module;
    if (frame.pHash) {
      const hs = pageHashes(p);
      // 只收「與既有樣本有明顯差異」的新樣本,保留代表性。
      if (!hs.some((h) => hamming(h, frame.pHash) <= 16)) p.pHashes = [...hs, frame.pHash].slice(-MAX_HASH_SAMPLES);
    }
    bumpAlias(p, frame.name);
    return { pageId: id, isNew: false };
  }
  const newId = stableId(`${canon}|${frame.module ?? ''}|${frame.pHash?.slice(0, 32) ?? ''}|${Object.keys(struct.pages).length}`);
  struct.pages[newId] = {
    id: newId,
    name: transient ? transientDisplayName(frame.name) : String(frame.name ?? '').trim() || '未命名畫面',
    canonical: canon,
    ...(frame.module ? { module: frame.module } : {}),
    ...(transient ? { transient: true } : {}),
    pHash: frame.pHash ?? '',
    pHashes: frame.pHash ? [frame.pHash] : [],
    aliases: {},
    screenshotRef: `screenshots/${newId}.png`,
    knownControlLabels: [],
    visitCount: 1,
    hitCount: 1,
    firstSeenAt: now,
    lastSeenAt: now,
  };
  bumpAlias(struct.pages[newId], frame.name);
  if (!struct.rootPageId && !transient) struct.rootPageId = newId;
  return { pageId: newId, isNew: true };
}

export function normTarget(t) {
  return String(t ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

/** 動作 → 導覽圖邊的觸發種類(互動動作照原樣,其餘如 wait 視為自動轉場 auto)。 */
export function edgeKind(action) {
  return INTERACTIVE.has(action) ? action : 'auto';
}

/**
 * 操作細節(可重播):座標用 0~1 相對比例(不綁解析度),ms = 滑動 / 按住毫秒。
 * { a:動作, x, y, x2?, y2?, ms?, dir?, key?, n?(連按), text?, ar?(錄製時寬高比), v?(App 版本), at? }
 * 格式不對回 null(API 驗證使用者編修也用這個)。
 */
export function sanitizeOp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const a = String(raw.a ?? '').trim().toLowerCase();
  if (!REPLAYABLE.has(a)) return null;
  const unit = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 10000) / 10000 : undefined;
  };
  const op = { a };
  const x = unit(raw.x);
  const y = unit(raw.y);
  const needsXY = a === 'tap' || a === 'swipe' || a === 'hold';
  if (needsXY && (x === undefined || y === undefined)) return null;
  if (x !== undefined && y !== undefined) { op.x = x; op.y = y; }
  if (a === 'swipe') {
    const x2 = unit(raw.x2);
    const y2 = unit(raw.y2);
    if (x2 === undefined || y2 === undefined) return null;
    op.x2 = x2; op.y2 = y2;
  }
  const ms = Number(raw.ms);
  if ((a === 'swipe' || a === 'hold' || a === 'move' || a === 'key') && Number.isFinite(ms) && ms > 0) op.ms = Math.min(10_000, Math.round(ms));
  if (a === 'move') {
    const dir = String(raw.dir ?? '').toLowerCase();
    if (!OP_DIRS.has(dir)) return null;
    op.dir = dir;
  }
  if (a === 'key') {
    const key = String(raw.key ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_]{1,16}$/.test(key)) return null;
    op.key = key;
    const n = Number(raw.n);
    if (Number.isInteger(n) && n > 1 && n <= 20) op.n = n;
  }
  if (a === 'type') {
    const text = typeof raw.text === 'string' ? raw.text.slice(0, 200) : '';
    if (!text) return null;
    op.text = text;
  }
  const ar = Number(raw.ar);
  if (Number.isFinite(ar) && ar > 0.1 && ar < 10) op.ar = Math.round(ar * 1000) / 1000;
  if (typeof raw.v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(raw.v)) op.v = raw.v;
  if (typeof raw.at === 'string' && raw.at.length <= 40) op.at = raw.at;
  return op;
}

/**
 * 記錄一次轉場。action = 上一步動作(tap/swipe/back/move/type/launch/wait…),target = 上一步目標元件文字。
 * 只有 from !== to 才建邊;上一步非互動動作 → kind='auto'(自動轉場,如載入完成)。
 * op = 上一步實際執行的操作細節(sanitizeOp 格式);有的話記在邊上(最新一次),供記憶腳本重播。
 */
export function recordTransition(struct, fromId, toId, { action, target, op } = {}) {
  if (!fromId || !toId || fromId === toId) return;
  if (!struct.pages[fromId] || !struct.pages[toId]) return;
  const kind = INTERACTIVE.has(action) ? action : 'auto';
  const tgt = kind === 'auto' ? '' : normTarget(target);
  const label = kind === 'auto' ? 'auto' : tgt ? `${kind} ${tgt}` : kind;
  let edge = struct.edges.find((e) => e.fromPageId === fromId && e.toPageId === toId && (e.trigger?.kind ?? '') === kind && normTarget(e.trigger?.target) === tgt);
  if (!edge) {
    edge = { fromPageId: fromId, toPageId: toId, trigger: { kind, label, ...(tgt ? { target: tgt } : {}) }, hitCount: 0, missCount: 0 };
    struct.edges.push(edge);
  }
  edge.hitCount += 1;
  const clean = kind !== 'auto' ? sanitizeOp(op) : null;
  if (clean && clean.a === kind) edge.op = clean;
  if (tgt && !struct.pages[fromId].knownControlLabels.includes(tgt)) {
    struct.pages[fromId].knownControlLabels = [...struct.pages[fromId].knownControlLabels, tgt].slice(-30);
  }
}

/** 互動動作後畫面沒變:對同畫面、同動作+目標的既有出邊記一次 miss(路徑可靠度)。 */
export function recordMiss(struct, pageId, { action, target } = {}) {
  if (!INTERACTIVE.has(action) || !struct.pages[pageId]) return;
  const tgt = normTarget(target);
  for (const e of struct.edges) {
    if (e.fromPageId === pageId && e.trigger?.kind === action && normTarget(e.trigger?.target) === tgt) e.missCount += 1;
  }
  for (const s of struct.pages[pageId].selfOps ?? []) {
    if (s.kind === action && normTarget(s.target) === tgt) s.missCount = (s.missCount ?? 0) + 1;
  }
}

/**
 * 同一畫面上「畫面有變、但還是同一個畫面」的操作(例如拉霸機按 SPIN 轉輪、切換分頁)。
 * 記在 page.selfOps(以動作 + 目標去重,最多 12 種),SPIN 迴圈靠它知道要點哪裡。
 */
export function recordSelfOp(struct, pageId, { action, target, op } = {}) {
  const page = struct.pages?.[pageId];
  if (!page || !REPLAYABLE.has(action)) return;
  const tgt = normTarget(target);
  if (!tgt) return; // 沒有目標名稱的點擊無法辨識是哪個按鈕
  const clean = sanitizeOp(op);
  const list = Array.isArray(page.selfOps) ? page.selfOps : [];
  let s = list.find((x) => x.kind === action && normTarget(x.target) === tgt);
  if (!s) {
    s = { kind: action, target: tgt, hitCount: 0, missCount: 0 };
    list.push(s);
  }
  s.hitCount += 1;
  if (clean && clean.a === action) s.op = clean;
  page.selfOps = list.sort((a, b) => b.hitCount - a.hitCount).slice(0, MAX_SELF_OPS);
}

/**
 * 只用畫面指紋判斷「目前是記憶裡的哪個畫面」(不用 AI 命名)。
 * 最近的頁要夠近(≤ maxDist),且比第二近的「別的頁」明顯更近(差距 ≥ margin),否則回 null(寧可交給 AI)。
 * 回 { pageId, dist, transient }。
 */
export function identifyPage(struct, pHash, { maxDist = 40, margin = 12 } = {}) {
  if (!pHash || !struct?.pages) return null;
  let best = null;
  let second = Infinity;
  for (const p of Object.values(struct.pages)) {
    const d = Math.min(Infinity, ...pageHashes(p).map((h) => hamming(pHash, h)));
    if (!best || d < best.dist) {
      if (best) second = Math.min(second, best.dist);
      best = { pageId: p.id, dist: d, transient: Boolean(p.transient) };
    } else if (d < second) second = d;
  }
  if (!best || best.dist > maxDist) return null;
  if (second - best.dist < margin) return null;
  return best;
}

/**
 * 把舊格式/雜亂的結構就地收斂:依新規則重新歸併頁面、重導邊、合併重複邊、去自環與懸空邊。
 * 回新的結構物件(不修改輸入)。可重複套用(冪等)。
 */
export function compactStructure(input) {
  const src = input && typeof input === 'object' ? input : emptyStructure();
  const out = emptyStructure(src.appName);
  out.lastUpdatedAt = src.lastUpdatedAt ?? null;
  const remap = new Map();
  // 依訪問次數由多到少歸併,讓主要畫面成為代表節點。
  // 佔位名(「畫面 27」= AI 當步沒給畫面名)不是真畫面:整個丟掉,連到它的邊也不留。
  const pages = Object.values(src.pages ?? {})
    .filter((p) => !isPlaceholderName(p.name) || Object.keys(p.aliases ?? {}).some((n) => !isPlaceholderName(n)))
    .sort((a, b) => (b.visitCount ?? 0) - (a.visitCount ?? 0));
  for (const p of pages) {
    // 一律以目前規則重算(舊資料的 canonical 可能是舊版演算法算的)。
    const topAlias = Object.entries(p.aliases ?? {}).filter(([n]) => !isPlaceholderName(n)).sort((a, b) => b[1] - a[1])[0]?.[0];
    const canon = canonicalName(topAlias ?? p.name);
    const hashes = pageHashes(p);
    const transient = Boolean(p.transient) || isTransientName(topAlias ?? p.name);
    const match = findMatch(out, { canon, pHash: hashes[0], module: p.module, transient });
    if (match) {
      const t = out.pages[match];
      t.visitCount += p.visitCount ?? 1;
      t.hitCount = (t.hitCount ?? 0) + (p.hitCount ?? 0);
      t.firstSeenAt = [t.firstSeenAt, p.firstSeenAt].filter(Boolean).sort()[0];
      t.lastSeenAt = [t.lastSeenAt, p.lastSeenAt].filter(Boolean).sort().slice(-1)[0];
      for (const h of hashes) if (!t.pHashes.some((x) => hamming(x, h) <= 16)) t.pHashes = [...t.pHashes, h].slice(-MAX_HASH_SAMPLES);
      const aliases = p.aliases && Object.keys(p.aliases).length ? p.aliases : { [p.name]: p.visitCount ?? 1 };
      for (const [n, c] of Object.entries(aliases)) if (!isPlaceholderName(n)) t.aliases[n] = (t.aliases[n] ?? 0) + c;
      refreshName(t);
      t.knownControlLabels = [...new Set([...(t.knownControlLabels ?? []), ...(p.knownControlLabels ?? [])])].slice(-30);
      if (Array.isArray(p.selfOps) && p.selfOps.length) t.selfOps = mergeSelfOps(t.selfOps, p.selfOps);
      remap.set(p.id, match);
      continue;
    }
    const aliases = Object.fromEntries(
      Object.entries(p.aliases && Object.keys(p.aliases).length ? p.aliases : { [p.name]: p.visitCount ?? 1 }).filter(([n]) => !isPlaceholderName(n)),
    );
    const { transient: _old, ...rest } = p;
    out.pages[p.id] = {
      ...rest,
      canonical: canon,
      ...(transient ? { transient: true } : {}),
      pHash: hashes[0] ?? '',
      pHashes: hashes.slice(0, MAX_HASH_SAMPLES),
      aliases,
      knownControlLabels: [...(p.knownControlLabels ?? [])],
      visitCount: p.visitCount ?? 1,
    };
    refreshName(out.pages[p.id]);
    remap.set(p.id, p.id);
  }
  const root = src.rootPageId ? remap.get(src.rootPageId) : null;
  out.rootPageId = root && !out.pages[root]?.transient ? root : (Object.values(out.pages).find((p) => !p.transient)?.id ?? null);
  for (const e of src.edges ?? []) {
    const from = remap.get(e.fromPageId);
    const to = remap.get(e.toPageId);
    if (!from || !to || from === to) continue;
    // 舊資料的 label 只有動作名(tap/wait…);wait 視為 auto。
    // 舊格式:kind 固定 'tap'、label = 上一步動作名;新格式:kind = 動作、label = 「動作 目標」。
    const k = e.trigger?.kind;
    const first = String(e.trigger?.label ?? '').split(' ')[0];
    const rawKind = k && k !== 'tap' ? k : (first || k || 'auto');
    const kind = INTERACTIVE.has(rawKind) ? rawKind : 'auto';
    const tgt = kind === 'auto' ? '' : normTarget(e.trigger?.target);
    let edge = out.edges.find((x) => x.fromPageId === from && x.toPageId === to && x.trigger.kind === kind && normTarget(x.trigger.target) === tgt);
    if (!edge) {
      edge = { fromPageId: from, toPageId: to, trigger: { kind, label: kind === 'auto' ? 'auto' : tgt ? `${kind} ${tgt}` : kind, ...(tgt ? { target: tgt } : {}) }, hitCount: 0, missCount: 0 };
      out.edges.push(edge);
    }
    edge.hitCount += e.hitCount ?? 1;
    edge.missCount += e.missCount ?? 0;
    // 操作細節:保留最新的一次(合併重複邊時以錄製時間較新者為準)。
    const op = sanitizeOp(e.op);
    if (op && op.a === kind && (!edge.op || String(op.at ?? '') >= String(edge.op.at ?? ''))) edge.op = op;
    // 人工標註(只出現在套過 edits 的讀取結果;runner 寫回的 structure.json 不含)。
    if (e.manual) edge.manual = true;
  }
  return out;
}

/** 合併兩份同畫面操作清單(次數相加、操作細節取較新)。 */
function mergeSelfOps(a, b) {
  const out = (Array.isArray(a) ? a : []).map((s) => ({ ...s }));
  for (const s of Array.isArray(b) ? b : []) {
    if (!s || !REPLAYABLE.has(s.kind)) continue;
    const t = out.find((x) => x.kind === s.kind && normTarget(x.target) === normTarget(s.target));
    if (!t) { out.push({ ...s }); continue; }
    t.hitCount = (t.hitCount ?? 0) + (s.hitCount ?? 0);
    t.missCount = (t.missCount ?? 0) + (s.missCount ?? 0);
    if (s.op && (!t.op || String(s.op.at ?? '') >= String(t.op.at ?? ''))) t.op = s.op;
  }
  return out.sort((x, y) => (y.hitCount ?? 0) - (x.hitCount ?? 0)).slice(0, MAX_SELF_OPS);
}

/**
 * 把導覽圖轉成給 agent 的精簡文字(低優先參考,畫面以截圖為準)。
 * 只列可靠路徑(hit > miss),依使用次數排序,控制長度。
 */
export function summarizeForAgent(struct, maxChars = 1800) {
  const s = compactStructure(struct);
  const pages = Object.values(s.pages).filter((p) => !p.transient);
  if (pages.length === 0) return '';
  const nameOf = (id) => s.pages[id]?.name ?? id;
  const lines = [];
  lines.push(`已知畫面(${pages.length}):` + pages
    .sort((a, b) => b.visitCount - a.visitCount)
    .slice(0, 20)
    .map((p) => {
      const alts = Object.keys(p.aliases ?? {}).filter((n) => n !== p.name).slice(0, 2);
      return alts.length ? `${p.name}(又稱 ${alts.join('、')})` : p.name;
    })
    .join('、'));
  // 人工標註的路徑(測試人員在記憶關係圖親手畫的)一律視為可靠並排最前面。
  const edges = s.edges
    .filter((e) => (e.manual || e.hitCount > e.missCount) && (e.manual || !s.pages[e.fromPageId]?.transient))
    .sort((a, b) => (b.manual ? 1 : 0) - (a.manual ? 1 : 0) || b.hitCount - a.hitCount);
  if (edges.length) {
    lines.push('已驗證的操作路徑(成功次數/失敗次數;標「人工標註」= 測試人員親自確認的正確路徑,優先參考):');
    for (const e of edges.slice(0, 40)) {
      const how = e.trigger.kind === 'auto' ? '自動轉場' : e.trigger.label;
      lines.push(`- 「${nameOf(e.fromPageId)}」 --${how}--> 「${nameOf(e.toPageId)}」${e.manual ? '(人工標註)' : `(${e.hitCount}/${e.missCount})`}`);
    }
  }
  const unreliable = s.edges.filter((e) => !e.manual && e.missCount >= e.hitCount && e.missCount > 0).slice(0, 10);
  if (unreliable.length) {
    lines.push('常失敗的操作(避免重複嘗試):');
    for (const e of unreliable) lines.push(`- 在「${nameOf(e.fromPageId)}」${e.trigger.label}(成功 ${e.hitCount} / 失敗 ${e.missCount})`);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…';
  return text;
}
