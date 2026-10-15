/**
 * 操作員即時指令 + 應用記憶(runner 與 API 共用的純函式)。
 *
 * - 指令:前端寫 `${jobPrefix}/commands/<id>.json`;runner 每步輪詢,注入下一回合,
 *   並寫 `${jobPrefix}/commands-ack/<id>.json`(received → applied,含 AI 當步回應)。
 * - 記憶:`memory/<app>/hints.json` = 使用者教過 AI 的經驗;`edits.json` = 記憶地圖手動編修。
 */

/** 路徑識別鍵(from>to>kind>target)。 */
export function edgeKey(e) {
  return `${e.fromPageId}>${e.toPageId}>${e.trigger?.kind ?? ''}>${String(e.trigger?.target ?? '').trim()}`;
}

const MAX_MERGED_HASHES = 6;

/** 解析合併鏈(a→b、b→c ⇒ a→c;防循環)。 */
function mergeTarget(merges, id) {
  let cur = id;
  for (let i = 0; i < 50 && merges[cur] && merges[cur] !== id; i++) cur = merges[cur];
  return cur;
}

/** 合併畫面:來源頁的訪問次數/別名/pHash/控件併入目標頁,邊重導並去重(次數相加)、去自環。 */
function applyMerges(struct, merges) {
  if (!merges || typeof merges !== 'object' || !struct.pages) return;
  const remap = new Map();
  for (const from of Object.keys(merges)) {
    const into = mergeTarget(merges, from);
    if (into === from || !struct.pages[from] || !struct.pages[into]) continue;
    remap.set(from, into);
  }
  if (!remap.size) return;
  for (const [from, into] of remap) {
    const s = struct.pages[from];
    const t = struct.pages[into];
    t.visitCount = (t.visitCount ?? 0) + (s.visitCount ?? 0);
    t.hitCount = (t.hitCount ?? 0) + (s.hitCount ?? 0);
    const aliases = { ...(t.aliases ?? {}) };
    const srcAliases = s.aliases && Object.keys(s.aliases).length ? s.aliases : { [s.name]: s.visitCount ?? 1 };
    for (const [n, c] of Object.entries(srcAliases)) if (n) aliases[n] = (aliases[n] ?? 0) + (Number(c) || 1);
    t.aliases = aliases;
    const hashes = [...(t.pHashes ?? (t.pHash ? [t.pHash] : []))];
    for (const h of [s.pHash, ...(s.pHashes ?? [])]) if (h && !hashes.includes(h)) hashes.push(h);
    t.pHashes = hashes.slice(0, MAX_MERGED_HASHES);
    if (!t.pHash && t.pHashes[0]) t.pHash = t.pHashes[0];
    t.knownControlLabels = [...new Set([...(t.knownControlLabels ?? []), ...(s.knownControlLabels ?? [])])].slice(-30);
    if (s.firstSeenAt && (!t.firstSeenAt || s.firstSeenAt < t.firstSeenAt)) t.firstSeenAt = s.firstSeenAt;
    if (s.lastSeenAt && (!t.lastSeenAt || s.lastSeenAt > t.lastSeenAt)) t.lastSeenAt = s.lastSeenAt;
    delete struct.pages[from];
  }
  if (struct.rootPageId && remap.has(struct.rootPageId)) struct.rootPageId = remap.get(struct.rootPageId);
  const byKey = new Map();
  const out = [];
  for (const e of struct.edges ?? []) {
    const from = remap.get(e.fromPageId) ?? e.fromPageId;
    const to = remap.get(e.toPageId) ?? e.toPageId;
    if (from === to) continue;
    const ne = { ...e, fromPageId: from, toPageId: to };
    const key = edgeKey(ne);
    const prev = byKey.get(key);
    if (prev) {
      prev.hitCount = (prev.hitCount ?? 0) + (ne.hitCount ?? 0);
      prev.missCount = (prev.missCount ?? 0) + (ne.missCount ?? 0);
      continue;
    }
    byKey.set(key, ne);
    out.push(ne);
  }
  struct.edges = out;
}

/**
 * 把記憶地圖手動編修套到 structure(就地修改並回傳):合併畫面 → 刪畫面(連帶其路徑)、刪路徑 →
 * 手動路徑(addedEdges,標 manual)→ 改名。runner 傳 { addedEdges: false },人工路徑只留在 edits.json。
 * 改名只套在讀取端(API 顯示/摘要);runner 載入時傳 { renames: false } 只套刪除,
 * 避免把自訂名寫回 structure.json(之後取消改名才不會殘留)。
 */
export function applyEdits(struct, edits, opts = {}) {
  const withRenames = opts.renames !== false;
  const withAdded = opts.addedEdges !== false;
  if (!struct || !edits) return struct;
  applyMerges(struct, edits.merges);
  const delPages = new Set(edits.deletedPages ?? []);
  const delEdges = new Set(edits.deletedEdges ?? []);
  for (const id of delPages) delete struct.pages?.[id];
  if (struct.rootPageId && delPages.has(struct.rootPageId)) {
    struct.rootPageId = Object.values(struct.pages ?? {}).find((p) => !p.transient)?.id ?? null;
  }
  struct.edges = (struct.edges ?? []).filter((e) => !delPages.has(e.fromPageId) && !delPages.has(e.toPageId) && !delEdges.has(edgeKey(e)));
  if (withAdded) {
    // 手動路徑:已存在同一條(AI 走過)就標 manual;否則新增一條 0/0 的人工路徑。
    // manual 旗標只存在讀取結果,compactStructure 重建邊時不保留 → edits.json 才是唯一來源。
    for (const a of edits.addedEdges ?? []) {
      if (!a || !struct.pages?.[a.fromPageId] || !struct.pages?.[a.toPageId] || a.fromPageId === a.toPageId) continue;
      const key = edgeKey(a);
      if (delEdges.has(key)) continue;
      const hit = struct.edges.find((e) => edgeKey(e) === key);
      if (hit) { hit.manual = true; continue; }
      const kind = a.trigger?.kind ?? 'auto';
      const target = String(a.trigger?.target ?? '').trim();
      struct.edges.push({
        fromPageId: a.fromPageId,
        toPageId: a.toPageId,
        trigger: { kind, label: a.trigger?.label ?? (kind === 'auto' ? 'auto' : target ? `${kind} ${target}` : kind), ...(target ? { target } : {}) },
        hitCount: 0,
        missCount: 0,
        manual: true,
      });
    }
  }
  if (withRenames) {
    for (const [id, name] of Object.entries(edits.renames ?? {})) {
      const p = struct.pages?.[id];
      if (p && typeof name === 'string' && name.trim()) { p.autoName = p.name; p.name = name.trim(); p.renamed = true; }
    }
  }
  return struct;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s「」『』"'()()\[\]【】:,。.、_-]+/g, '');

/** 兩個畫面名是否指同一畫面(寬鬆:去標點空白後互相包含)。 */
export function sameScreen(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)));
}

/** 啟用中的記憶 → system prompt 段落(全部列出,依畫面分組;上限 maxChars)。 */
const hintTime = (h) => Date.parse(h?.updatedAt ?? h?.createdAt ?? '') || 0;

export function hintsPromptSection(hints, pageName = (id) => id, maxChars = 3500) {
  const list = (hints ?? [])
    .filter((h) => h && h.enabled !== false && typeof h.text === 'string' && h.text.trim())
    .sort((a, b) => hintTime(a) - hintTime(b)); // 舊 → 新
  if (!list.length) return '';
  const general = list.filter((h) => !h.pageId && !h.screen);
  const scoped = list.filter((h) => h.pageId || h.screen);
  const lines = [
    '【使用者教過你的經驗|高優先|重要】以下是測試人員在先前測試中親自糾正/教你的操作方式,代表這款遊戲的正確玩法,' +
    '比你自己的推測更可靠。遇到對應畫面時【優先照做】,不要再重複過去撞牆的做法(畫面仍以截圖為準,若畫面明顯不同才自行判斷)。' +
    '清單依時間排序、越後面越新;同一情境的教學若互相矛盾(例如先說選 A、後來又說改選 B),【只照最新那條】:',
  ];
  for (const h of general) lines.push(`- ${h.text}`);
  for (const h of scoped) lines.push(`- 在「${h.screen || pageName(h.pageId)}」畫面:${h.text}`);
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…`;
  return `\n\n${text}`;
}

// ───────────── 測試人員畫的順序路線(edits.routes,整個應用共用) ─────────────

const activeRoutes = (routes) => (Array.isArray(routes) ? routes : [])
  .filter((r) => r && r.enabled !== false && Array.isArray(r.steps) && r.steps.length);

/**
 * 路線 → system prompt 段落。pageName(id) 回空字串 = 畫面已不存在(被刪),該步/支線照樣列出但標示。
 * 支線 = 某步可能出現的岔路(例如當天限定活動彈窗):先處理再回到指定步驟。
 */
export function routesPromptSection(routes, pageName = (id) => id, maxChars = 3000) {
  const list = activeRoutes(routes);
  if (!list.length) return '';
  const nm = (id) => pageName(id) || '(畫面已刪除)';
  const lines = [
    '【測試人員畫的操作路線|高優先】以下是測試人員在記憶地圖上親手畫的正確流程(依序)。' +
    '本次測試任務沒有指定別的流程時,就照路線從第 1 步依序走完;任務另有指定時以任務為準,路線當作「怎麼到達各畫面」的正確走法。' +
    'thinking 開頭寫目前在哪條路線第幾步(例:「路線 主線 第 2 步」)。' +
    '某一步沒成功(例如沒通關、畫面不對)時:先看是不是出現了下面列的支線畫面,是就照支線處理再回到指定步驟;' +
    '都不是就重試這一步,真的無法前進再自行判斷並說明原因。',
  ];
  for (const r of list) {
    const idx = new Map(r.steps.map((s, i) => [s.id, i + 1]));
    lines.push(`路線「${r.name}」:`);
    r.steps.forEach((s, i) => lines.push(`  ${i + 1}. 在「${nm(s.pageId)}」${s.action ? `:${s.action}` : ''}`));
    for (const b of r.branches ?? []) {
      const from = idx.get(b.fromStepId);
      const back = idx.get(b.returnStepId) ?? from;
      if (!from) continue;
      lines.push(`  支線(第 ${from} 步時若出現「${nm(b.pageId)}」):${b.action || '處理掉這個畫面'} → 回到第 ${back} 步`);
    }
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…`;
  return `\n\n${text}`;
}

/**
 * 目前畫面(pageId)在路線上的位置 → 本回合提醒(第幾步、接下來做什麼;或是支線畫面要怎麼處理)。
 * 同一畫面在路線出現多次(例如回大廳)時全部列出,由 AI 依進度判斷。
 */
export function routeTurnNote(routes, pageId, pageName = (id) => id) {
  if (!pageId) return '';
  const nm = (id) => pageName(id) || '(畫面已刪除)';
  const out = [];
  for (const r of activeRoutes(routes)) {
    const idx = new Map(r.steps.map((s, i) => [s.id, i]));
    r.steps.forEach((s, i) => {
      if (s.pageId !== pageId) return;
      const next = r.steps[i + 1];
      out.push(`路線「${r.name}」第 ${i + 1}/${r.steps.length} 步${s.action ? `:${s.action}` : ''}` +
        (next ? `;完成後前往第 ${i + 2} 步「${nm(next.pageId)}」${next.action ? `(${next.action})` : ''}` : ';這是路線最後一步'));
    });
    for (const b of r.branches ?? []) {
      if (b.pageId !== pageId || !idx.has(b.fromStepId)) continue;
      const back = idx.get(b.returnStepId) ?? idx.get(b.fromStepId);
      out.push(`路線「${r.name}」支線:這是第 ${idx.get(b.fromStepId) + 1} 步可能出現的畫面,${b.action || '先處理掉它'},` +
        `然後回到第 ${back + 1} 步「${nm(r.steps[back].pageId)}」繼續`);
    }
  }
  if (!out.length) return '';
  return `\n【路線提醒】目前畫面在測試人員畫的路線上:${out.slice(0, 4).join(';')}。`;
}

/** 目前畫面(上一步的畫面名/pageId)對應的記憶 → 本回合提醒(避免 AI 忘了 system 裡的長清單)。 */
export function screenHintsFor(hints, { screen, pageId } = {}) {
  return (hints ?? [])
    .filter((h) => h && h.enabled !== false && ((h.pageId && pageId && h.pageId === pageId) || (h.screen && screen && sameScreen(h.screen, screen))))
    .sort((a, b) => hintTime(b) - hintTime(a)); // 新 → 舊:最新的教學排第一個
}

/**
 * 操作員指令 → 本回合指示文字。
 * - 新指令:最高優先,且明講「與先前指令衝突時以這則為準」。
 * - 先前指令:由新到舊列出並標出「最新」,告訴模型互相矛盾時只照最新那則
 *   (2026-10-05:測試人員先說 step by step、後改 auto、再改 free spins,舊版把三則並列成
 *   「仍有效」,模型無從判斷該照哪個)。
 */
/** 指令顯示文字:畫面點選的指令附上大約位置,讓之後的步驟知道那個東西在哪。 */
const pct = (v) => Math.round(v * 100);
function cmdLabel(c) {
  if (!c.point) return c.text;
  if (c.to) {
    const path = `從畫面左起 ${pct(c.point.x)}%、上起 ${pct(c.point.y)}% 按住,拖到左起 ${pct(c.to.x)}%、上起 ${pct(c.to.y)}% 放開`;
    return gestureOnly(c) ? path : `${c.text}(做法:${path})`;
  }
  const pos = `畫面位置約左起 ${pct(c.point.x)}%、上起 ${pct(c.point.y)}%`;
  return gestureOnly(c) ? `點${pos}` : `${c.text}(${pos})`;
}
/** 只有畫面手勢(點一下 / 拖一下)、沒有打字說明 —— runner 已直接執行,不當持續指令提醒。 */
function gestureOnly(c) {
  return !!c.point && (c.text === POINT_ONLY_TEXT || c.text === DRAG_ONLY_TEXT);
}

export function operatorTurnNote(newCmds, activeCmds) {
  let out = '';
  const ids = new Set(newCmds.map((c) => c.id));
  // 只是「點一下這裡」的畫面點選已由 runner 直接執行,不再當成持續有效的指令提醒。
  const older = activeCmds
    .filter((c) => !ids.has(c.id) && !gestureOnly(c))
    .slice(-4).reverse() // 新 → 舊
    .map((c) => ({ ...c, text: cmdLabel(c) }));
  newCmds = newCmds.map((c) => ({ ...c, text: cmdLabel(c) }));
  if (newCmds.length) {
    out += `\n【測試人員即時指令|最高優先|必須遵守】測試人員正在看即時畫面,剛剛對你下了指令:` +
      newCmds.map((c) => `「${c.text}」`).join(';') +
      `。這一步【就照指令做】(找到指令描述的按鈕/位置並執行),thinking 開頭寫「依測試人員指令:」再說明你怎麼做。` +
      `指令若描述位置(如右下方的 SPIN),請在截圖中找到該位置上符合描述的元件並對準其正中心。` +
      (older.length ? `這則指令【取代】先前與它衝突的指令,之後都以它為準。` : '') +
      `若當下畫面上沒有指令提到的東西,先做必要的準備動作,等它出現時再照做,不要忘記。`;
  }
  if (older.length && newCmds.length) {
    out += `\n(較早的指令:${older.map((c) => `「${c.text}」`).join(';')} —— 與剛剛新指令矛盾的部分作廢,其餘仍有效。)`;
  } else if (older.length) {
    const [latest, ...rest] = older;
    out += `\n(提醒:測試人員本次測試的指令,由新到舊:最新「${latest.text}」` +
      (rest.length ? `;較早 ${rest.map((c) => `「${c.text}」`).join(';')}` : '') +
      `。互相矛盾時只照最新的;不矛盾的仍然有效。)`;
  }
  return out;
}

/** 測試人員只點了畫面、沒打字時的預設指令文字(runner 直接點擊,不另加說明)。 */
export const POINT_ONLY_TEXT = '點這個位置';
/** 測試人員只拖了畫面、沒打字時的預設指令文字(與 infra/lambda/api/operatorCommands.ts 一致)。 */
export const DRAG_ONLY_TEXT = '照這條路徑拖曳';
/** 拖曳耗時範圍(毫秒),與 API 端一致。 */
export const DRAG_MS_MIN = 100;
export const DRAG_MS_MAX = 5000;
export const DRAG_MS_DEFAULT = 600;
/** 測試人員拖曳:按下後與放開前各停留的毫秒數。 */
export const DRAG_PRESS_MS = 100;

/** 畫面點選位置(相對比例 0–1);格式不對回 null。 */
export function validPoint(p) {
  if (!p || typeof p !== 'object') return null;
  const x = Number(p.x), y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
}

/** 拖曳耗時(毫秒):非數字 → 預設值;超出範圍 → 夾到範圍內。 */
export function validDragMs(v) {
  const n = Number(v);
  if (v === undefined || v === null || !Number.isFinite(n)) return DRAG_MS_DEFAULT;
  return Math.max(DRAG_MS_MIN, Math.min(DRAG_MS_MAX, Math.round(n)));
}

/**
 * 測試人員在畫面上做的手勢 → runner 要執行的動作(座標換到本步截圖 cw×ch 空間)。
 * 有終點 to → swipe(按住起點拖到終點,依實際拖的時間);只有 point → tap。沒有手勢回 null。
 */
export function operatorGestureCmd(c, cw, ch) {
  if (!c?.point) return null;
  const x = Math.round(c.point.x * cw), y = Math.round(c.point.y * ch);
  if (c.to) {
    // pressMs/endHoldMs:按下先停一下(把物件「抓起來」)、到終點停一下再放(讓落點偵測到),拖放類遊戲才認得。
    return {
      action: 'swipe', x, y, x2: Math.round(c.to.x * cw), y2: Math.round(c.to.y * ch),
      durationMs: validDragMs(c.dragMs), pressMs: DRAG_PRESS_MS, endHoldMs: DRAG_PRESS_MS, operatorTap: true, operatorDrag: true,
    };
  }
  return { action: 'tap', x, y, operatorTap: true };
}

/**
 * 測試人員「直接操作裝置」後,告訴控制遊戲 Agent 剛剛發生什麼(下一回合注入)。
 * 同時給「Agent 自己的座標」(像素模型 = 截圖像素;千分制模型 = 0~1000)與「裝置像素」,
 * 讓 Agent 知道人點在哪、下一張圖就是操作後的結果,不要重做同一個動作。
 * op = { kind:'tap'|'drag', shot:{x,y,x2?,y2?}, device:{x,y,x2?,y2?}, space:{shot:[cw,ch]}, said? }
 */
export function operatorDirectNote(op, normCoord) {
  const [cw, ch] = op.space?.shot ?? [0, 0];
  const ai = (v, span) => (normCoord && span > 0 ? Math.round((v / span) * 1000) : Math.round(v));
  const unit = normCoord ? '0~1000 相對座標' : '截圖像素';
  const p = (x, y) => `(${ai(x, cw)}, ${ai(y, ch)})`;
  const what = op.kind === 'drag'
    ? `從你的座標 ${p(op.shot.x, op.shot.y)} 按住拖到 ${p(op.shot.x2, op.shot.y2)}(${unit});裝置像素 (${op.device.x}, ${op.device.y}) → (${op.device.x2}, ${op.device.y2})`
    : `點擊你的座標 ${p(op.shot.x, op.shot.y)}(${unit});裝置像素 (${op.device.x}, ${op.device.y})`;
  return `\n【測試人員已直接操作裝置|已執行完畢,不經 AI】${what}。` +
    (op.said ? `測試人員說明:「${op.said}」。` : '') +
    `下一張截圖就是操作後的畫面:從那個狀態接著做,不要重複這個操作;同一個按鈕之後要再點時,就用這個位置。`;
}

/** 從 S3 key 清單過濾出指令 id(按時間排序)。 */
export function commandIdsFromKeys(keys, prefix) {
  return keys
    .map((k) => k.slice(prefix.length).replace(/\.json$/, ''))
    .filter((id) => /^cmd-[a-z0-9]{6,32}$/.test(id))
    .sort();
}

/**
 * runner 端的指令通道。s3 為 S3Client;cmds = { ListObjectsV2Command, GetObjectCommand, PutObjectCommand }。
 * poll() 回「尚未處理」的新指令;ack(cmd, info) 寫回執(前端聊天室顯示狀態與 AI 回應)。
 */
export function createOperatorChannel({ s3, bucket, jobPrefix, cmds }) {
  const seen = new Set();
  const active = [];
  const cmdPrefix = `${jobPrefix}/commands/`;
  return {
    active,
    async poll() {
      let keys = [];
      try {
        const res = await s3.send(new cmds.ListObjectsV2Command({ Bucket: bucket, Prefix: cmdPrefix, MaxKeys: 200 }));
        keys = (res.Contents ?? []).map((o) => o.Key ?? '');
      } catch { return []; }
      const fresh = [];
      for (const id of commandIdsFromKeys(keys, cmdPrefix)) {
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          const r = await s3.send(new cmds.GetObjectCommand({ Bucket: bucket, Key: `${cmdPrefix}${id}.json` }));
          const c = JSON.parse(await r.Body.transformToString());
          if (c && typeof c.text === 'string' && c.text.trim()) {
            const point = validPoint(c.point);
            const to = point ? validPoint(c.to) : null;
            const drag = to && (to.x !== point.x || to.y !== point.y) ? { to, dragMs: validDragMs(c.dragMs) } : {};
            const cmd = { id, text: c.text.trim().slice(0, 500), ...(c.hintId ? { hintId: c.hintId } : {}), ...(point ? { point } : {}), ...drag };
            fresh.push(cmd);
            active.push(cmd);
          }
        } catch { /* 讀不到就略過(不重試,避免卡迴圈) */ }
      }
      return fresh;
    },
    async ack(cmd, info) {
      const body = { id: cmd.id, ...info, at: new Date().toISOString() };
      await s3.send(new cmds.PutObjectCommand({
        Bucket: bucket, Key: `${jobPrefix}/commands-ack/${cmd.id}.json`, Body: JSON.stringify(body), ContentType: 'application/json',
      })).catch(() => {});
    },
  };
}

/** 讀應用記憶(hints.json + edits.json);失敗回空。 */
export async function loadAppMemory({ s3, bucket, memPrefix, cmds }) {
  const read = async (key) => {
    try {
      const r = await s3.send(new cmds.GetObjectCommand({ Bucket: bucket, Key: key }));
      return JSON.parse(await r.Body.transformToString());
    } catch { return null; }
  };
  const [hintsDoc, edits] = await Promise.all([read(`${memPrefix}/hints.json`), read(`${memPrefix}/edits.json`)]);
  return {
    hints: Array.isArray(hintsDoc?.hints) ? hintsDoc.hints.filter((h) => h && h.enabled !== false) : [],
    edits: edits && typeof edits === 'object' ? edits : null,
  };
}
