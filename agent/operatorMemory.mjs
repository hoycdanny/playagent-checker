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
function cmdLabel(c) {
  if (!c.point) return c.text;
  const pos = `畫面位置約左起 ${Math.round(c.point.x * 100)}%、上起 ${Math.round(c.point.y * 100)}%`;
  return c.text === POINT_ONLY_TEXT ? `點${pos}` : `${c.text}(${pos})`;
}

export function operatorTurnNote(newCmds, activeCmds) {
  let out = '';
  const ids = new Set(newCmds.map((c) => c.id));
  // 只是「點一下這裡」的畫面點選已由 runner 直接執行,不再當成持續有效的指令提醒。
  const older = activeCmds
    .filter((c) => !ids.has(c.id) && !(c.point && c.text === POINT_ONLY_TEXT))
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

/** 畫面點選位置(相對比例 0–1);格式不對回 null。 */
export function validPoint(p) {
  if (!p || typeof p !== 'object') return null;
  const x = Number(p.x), y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
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
            const cmd = { id, text: c.text.trim().slice(0, 500), ...(c.hintId ? { hintId: c.hintId } : {}), ...(point ? { point } : {}) };
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
