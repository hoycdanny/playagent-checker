/**
 * 記憶腳本「反射層」:認得的畫面直接照記憶操作,不問 AI(省下每步 10–30 秒的思考與模型費用)。
 *
 * 每一步:截圖 → 畫面指紋比對記憶地圖(identifyPage)→ 這個畫面若有「已驗證、通往目標」的操作 →
 * 直接執行 → 下一步確認到了預期畫面才繼續;認不出 / 到了意外畫面 / 沒反應 → 交回 AI。
 *
 * 啟用規則(使用者 2026-10-16 確認):
 *   1. 操作成功 ≥ 2 次且沒有失敗紀錄自動啟用;測試人員在記憶地圖「確認」過的直接啟用且優先。
 *   2. 只用在「導航」(進大廳、進遊戲、關彈窗);SPIN / 下注這類要測的動作不用反射(SPIN 迴圈另有規則)。
 *   3. 遊戲改版:操作記著錄製時的 App 版本,跨版本的操作只要失敗一次,本次測試就不再用跨版本操作。
 *
 * 純函式 + 一個小狀態物件(runner 每次測試建一個);不碰 S3 / 裝置,方便測試。
 */
import { canonicalName, normTarget, sanitizeOp } from './memoryGraph.mjs';
import { edgeKey } from './operatorMemory.mjs';

/** 自動啟用需要的最少成功次數。 */
export const REFLEX_MIN_HITS = 2;
/**
 * 彈窗類畫面的放寬門檻:成功 1 次且沒失敗就可以照記憶關掉。
 *
 * 背景(2026-10-17 實測 job-mvbrqar9):12 個互動步驟裡有 7 步的操作,記憶中已經有
 * 「成功 1 次 / 失敗 0 次」的紀錄,卻因為門檻是 2 次而全部回去問 AI(每步多花約 15 秒)。
 * 任務頁顯示的「照已驗證路徑」用的是較寬的標準(成功 > 失敗),所以畫面說命中、
 * 系統卻還在問 AI,兩套標準不一致。
 * 只對彈窗放寬:關彈窗做錯的代價最低(頂多關錯一個彈窗,下一步 AI 就會看到並修正),
 * 而彈窗又是最常重複、最浪費時間的畫面。其餘畫面維持 2 次。
 */
export const REFLEX_MIN_HITS_POPUP = 1;
/** 主要出口門檻:這條路佔該畫面所有出路使用次數的比例。 */
const DOMINANT_SHARE = 0.6;
/** 連續反射步數上限(之後讓 AI 看一次畫面,避免一路走偏)。 */
export const REFLEX_MAX_CHAIN = 12;

/** 彈窗類畫面(可以直接照記憶關掉)。 */
const POPUP_RE = /彈窗|弹窗|公告|popup|pop-up|獎勵|奖励|簽到|签到|daily|活動|活动|news|promo|促銷|促销|reward|notice|dialog|提示|教學|教学|tutorial|升級|升级|level\s*up/i;
/** 付費 / 購買類元件:絕不自動點(記憶裡曾有 AI 點了「USD 0.99」的紀錄)。 */
const PURCHASE_RE = /\$|usd|twd|ntd|nt\$|hkd|jpy|¥|€|£|購買|购买|儲值|储值|付款|付费|付費|buy|purchase|pay\b|checkout|訂閱|订阅|subscribe/i;
/** 遊戲內「要測的動作」:不當成導航(SPIN、下注、自動轉)。 */
const GAMEPLAY_RE = /spin|旋轉|旋转|轉動|转动|\bbet\b|下注|押注|auto\s*spin|自動|自动|max\s*bet|加注|減注|减注/i;
/** SPIN 按鈕。 */
const SPIN_RE = /spin|旋轉|旋转|轉動|转动|開始轉|开始转/i;

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s「」『』"'()()\[\]【】:,。.、_\-]+/g, '');

/**
 * 執行過的指令(cw×ch 截圖像素空間)→ 可重播的操作(0~1 相對座標)。不可重播的回 null。
 */
export function opFromCmd(cmd, cw, ch, { version, at } = {}) {
  if (!cmd || !cw || !ch) return null;
  const rel = (v, span) => (Number.isFinite(Number(v)) ? Number(v) / span : undefined);
  const raw = {
    a: cmd.action,
    x: rel(cmd.x, cw),
    y: rel(cmd.y, ch),
    x2: rel(cmd.x2, cw),
    y2: rel(cmd.y2, ch),
    ms: cmd.action === 'swipe' ? cmd.durationMs : cmd.action === 'hold' || cmd.action === 'move' || cmd.action === 'key' ? cmd.holdMs : undefined,
    dir: cmd.dir ?? cmd.direction,
    key: cmd.key,
    n: cmd.repeat,
    text: cmd.text,
    ar: cw / ch,
    ...(version ? { v: version } : {}),
    at: at ?? new Date().toISOString(),
  };
  return sanitizeOp(raw);
}

/** 可重播的操作 → 這一步要執行的指令(cw×ch 截圖像素空間)。 */
export function cmdFromOp(op, cw, ch) {
  const o = sanitizeOp(op);
  if (!o) return null;
  const px = (v, span) => Math.max(0, Math.min(span, Math.round(v * span)));
  const cmd = { action: o.a };
  if (o.x !== undefined) { cmd.x = px(o.x, cw); cmd.y = px(o.y, ch); }
  if (o.a === 'swipe') { cmd.x2 = px(o.x2, cw); cmd.y2 = px(o.y2, ch); if (o.ms) cmd.durationMs = o.ms; }
  if (o.a === 'hold' || o.a === 'move') cmd.holdMs = o.ms ?? (o.a === 'hold' ? 1000 : 1500);
  if (o.a === 'move') cmd.dir = o.dir;
  if (o.a === 'key') { cmd.key = o.key; if (o.n) cmd.repeat = o.n; if (o.ms) cmd.holdMs = o.ms; }
  if (o.a === 'type') cmd.text = o.text;
  return cmd;
}

/** 同畫面操作的識別鍵(與路徑 edgeKey 同格式:起訖都是自己)。 */
export function selfOpKey(pageId, s) {
  return `${pageId}>${pageId}>${s?.kind ?? ''}>${String(s?.target ?? '').trim()}`;
}

/**
 * 這個操作的可信度:disabled(測試人員停用)/ verified(測試人員確認)/ auto(成功 ≥ 2 次且無失敗)/ learning(還在學)。
 * 前端記憶地圖用同一套規則顯示狀態(web/src/components/memory/opTrust.ts)。
 */
export function opTrust({ hitCount = 0, missCount = 0, manual = false } = {}, edit) {
  if (edit?.disabled) return 'disabled';
  if (edit?.verified) return 'verified';
  if (manual && edit?.op) return 'verified';
  if (hitCount >= REFLEX_MIN_HITS && missCount === 0) return 'auto';
  return 'learning';
}

/** 實際要用的操作:測試人員修正過的優先,否則用最近一次錄到的。 */
export function effectiveOp(recorded, edit) {
  return sanitizeOp(edit?.op) ?? sanitizeOp(recorded);
}

export function createReflexState() {
  return { demoted: new Set(), recent: [], chain: 0, crossVersionFailed: false };
}

/** 從 task 文字抓 SPIN 局數(「1-100 局」「100 局」「100 spins」);沒有回 0。 */
export function parseSpinCount(task) {
  const t = String(task ?? '');
  const range = /(\d{1,5})\s*[-~～到至]\s*(\d{1,5})\s*(?:局|次|轉|转|spins?|rounds?)/i.exec(t);
  if (range) {
    const n = Number(range[2]) - Number(range[1]) + 1;
    return n > 0 ? Math.min(n, 5000) : 0;
  }
  const one = /(\d{1,5})\s*(?:局|次|轉|转|spins?|rounds?)/i.exec(t);
  return one ? Math.min(Number(one[1]), 5000) : 0;
}

/** 文字是否提到某個名稱(去標點空白後包含)。畫面名用 3 字起跳,避免「遊戲」「大廳」這類泛稱誤判。 */
function mentions(text, name, min = 2) {
  const n = norm(name);
  return n.length >= min && norm(text).includes(n);
}

/**
 * 決定這個畫面要不要直接照記憶操作。回 null(交給 AI)或
 * { key, op, toPageId, target, trust, reason, cross }。
 *
 * @param {object} c
 * @param {object} c.struct 記憶地圖(runner 載入、已套刪除)
 * @param {object|null} c.edits edits.json(opEdits / addedEdges / routes)
 * @param {string} c.pageId 目前畫面(identifyPage 認出來的,非載入畫面)
 * @param {string} c.task 測試目標全文
 * @param {string} [c.focus] 目前要做的測項(測項為主時)
 * @param {string} [c.version] 這次測試的 App 版本
 * @param {object} c.state createReflexState()
 */
export function chooseReflex({ struct, edits, pageId, task = '', focus = '', version, state }) {
  const page = struct?.pages?.[pageId];
  if (!page || page.transient) return null;
  const opEdits = edits?.opEdits ?? {};
  const goalText = `${focus} ${task}`;
  const popup = POPUP_RE.test(page.name) || Object.keys(page.aliases ?? {}).some((n) => POPUP_RE.test(n));
  // 到了測試要做事的畫面(目標文字提到這個畫面)→ 停下來交給 AI(彈窗除外)。
  if (!popup) {
    const names = [page.name, ...Object.keys(page.aliases ?? {})].map((n) => canonicalName(n)).filter((n) => n.length >= 2);
    if (names.some((n) => mentions(goalText, n, 3))) return null;
  }

  const manualKeys = new Set((edits?.addedEdges ?? []).map((e) => edgeKey(e)));
  const fromStruct = (struct.edges ?? []).filter((e) => e.fromPageId === pageId);
  const extra = (edits?.addedEdges ?? [])
    .filter((e) => e.fromPageId === pageId && !fromStruct.some((x) => edgeKey(x) === edgeKey(e)))
    .map((e) => ({ ...e, hitCount: 0, missCount: 0 }));
  const all = [...fromStruct, ...extra].filter((e) => e.toPageId !== pageId && e.trigger?.kind && e.trigger.kind !== 'auto');
  const totalHits = all.reduce((s, e) => s + (e.hitCount ?? 0), 0);

  const candidates = [];
  for (const e of all) {
    const key = edgeKey(e);
    const edit = opEdits[key];
    const trust = opTrust({ hitCount: e.hitCount, missCount: e.missCount, manual: manualKeys.has(key) }, edit);
    if (trust === 'disabled') continue;
    // 彈窗畫面放寬到「成功 ≥1 次且 0 失敗」(見 REFLEX_MIN_HITS_POPUP);放寬進來的標記成
    // relaxed,只允許用在「關彈窗」這個分支,不參與路線 / 目標點名 / 主要出口的判斷。
    const relaxed = trust === 'learning';
    if (relaxed && !(popup && (e.hitCount ?? 0) >= REFLEX_MIN_HITS_POPUP && (e.missCount ?? 0) === 0)) continue;
    if (state?.demoted?.has(key)) continue;
    const op = effectiveOp(e.op, edit);
    if (!op || op.a !== e.trigger.kind) continue;
    const target = String(e.trigger?.target ?? '');
    if (PURCHASE_RE.test(target)) continue;
    if (GAMEPLAY_RE.test(target)) continue;
    const toPage = struct.pages?.[e.toPageId];
    if (!toPage && !manualKeys.has(key)) continue;
    // 不在一串反射裡繞回剛走過的畫面(A → B → A)。
    if (state?.recent?.includes(e.toPageId)) continue;
    const cross = Boolean(op.v && version && op.v !== version && !edit?.op);
    if (cross && state?.crossVersionFailed) continue;
    candidates.push({ e, key, op, trust, target, toPage, cross, relaxed });
  }
  if (!candidates.length) return null;

  const rank = (x) => (x.trust === 'verified' ? 1e6 : 0) + (x.e.hitCount ?? 0);
  const pick = (list, reason) => {
    const best = [...list].sort((a, b) => rank(b) - rank(a))[0];
    return best
      ? { key: best.key, op: best.op, toPageId: best.e.toPageId, target: best.target, trust: best.trust, reason, cross: best.cross, hits: best.e.hitCount ?? 0, misses: best.e.missCount ?? 0 }
      : null;
  };

  // 路線 / 目標點名 / 主要出口只用「完整信心」的操作(成功 ≥2 或人工確認);放寬的只用在關彈窗。
  const strict = candidates.filter((x) => !x.relaxed);

  // 1) 測試人員畫的路線:目前畫面在路線上 → 走路線的下一個畫面。
  for (const r of edits?.routes ?? []) {
    if (!r || r.enabled === false || !Array.isArray(r.steps)) continue;
    const idx = r.steps.findIndex((s) => s.pageId === pageId);
    const next = idx >= 0 ? r.steps[idx + 1] : null;
    if (!next) continue;
    const onRoute = strict.filter((x) => x.e.toPageId === next.pageId);
    if (onRoute.length) return pick(onRoute, 'route');
  }
  // 2) 目標文字有點名的出路(例如「進入 Desert Legend」)。
  const named = strict.filter((x) => mentions(goalText, x.target) || (x.toPage && mentions(goalText, x.toPage.name, 3)));
  if (named.length) return pick(named, 'named');
  // 目標點名了「別的」出路(這裡記憶沒有可用的版本)→ 交給 AI,不要照習慣走。
  const otherNamed = all.some((e) => mentions(goalText, e.trigger?.target) || mentions(goalText, struct.pages?.[e.toPageId]?.name, 3));
  if (otherNamed) return null;
  // 3) 彈窗:照記憶關掉(這裡才允許用放寬門檻的操作)。
  if (popup) return pick(candidates, 'popup');
  // 4) 這個畫面的主要出口(佔使用次數 ≥ 60%)或測試人員確認過的唯一一條。
  const verified = strict.filter((x) => x.trust === 'verified');
  if (verified.length === 1 && !strict.some((x) => x.trust !== 'verified' && (x.e.hitCount ?? 0) > (verified[0].e.hitCount ?? 0))) {
    return pick(verified, 'verified');
  }
  const dominant = strict.filter((x) => totalHits > 0 && (x.e.hitCount ?? 0) / totalHits >= DOMINANT_SHARE);
  if (dominant.length) return pick(dominant, 'dominant');
  return null;
}

/**
 * 同一畫面的操作:AI 錄到的(page.selfOps)+ 測試人員在記憶地圖手動加的(只存在 opEdits,
 * 識別鍵 pid>pid>kind>target 且有操作內容)。手動加的視為 manual(有操作內容即為已確認)。
 */
export function pageSelfOps(page, pageId, opEdits = {}) {
  const list = [...(page?.selfOps ?? [])];
  const have = new Set(list.map((s) => selfOpKey(pageId, s)));
  for (const [key, edit] of Object.entries(opEdits ?? {})) {
    if (have.has(key) || !edit?.op) continue;
    const [from, to, kind, ...rest] = key.split('>');
    if (from !== pageId || to !== pageId || !kind) continue;
    list.push({ kind, target: rest.join('>'), hitCount: 0, missCount: 0, manual: true });
  }
  return list;
}

/**
 * SPIN 迴圈的最少成功次數。導航用 2 次是為了安全(走錯路要花好幾步才回得來),
 * 但「按 SPIN」是這個任務本身要做的動作,而且 runner 每一局都會用轉輪有沒有真的轉動來驗證
 * (沒轉動 2 次就把這個操作降級並交回 AI)—— 那個驗證比次數門檻可靠,所以這裡只要 1 次。
 */
export const REFLEX_MIN_HITS_SPIN = 1;

/**
 * SPIN 迴圈:這個畫面有沒有可信的 SPIN 操作。回 { key, op, target, trust } 或 null。
 *
 * 候選同時看兩種記憶:
 *  - selfOps:按了畫面有變、但還停在同一頁。
 *  - 出邊(edges):按了之後換頁。
 * 2026-10-17(job-mvcei8tq)實測:只看 selfOps 會幾乎抓不到 —— 這款遊戲按 SPIN 會在
 * 「拉霸結果畫面」與「拉霸轉軸畫面」之間來回,記憶把兩者當成不同頁面,所以 SPIN 是一條
 * 「出邊」而不是 selfOp。結果 55 次點 SPIN 只有 3 次走到迴圈,其餘 52 次每局多問一次 AI
 * (每次約 7.6 秒);日誌裡那條 tap SPIN(成功 9 / 失敗 0)就擺在旁邊卻用不到。
 */
export function chooseSpinOp({ struct, edits, pageId, version, state }) {
  const page = struct?.pages?.[pageId];
  if (!page || page.transient) return null;
  const opEdits = edits?.opEdits ?? {};
  // AutoSpin / 免費遊戲的按鈕不是「付費一局」,不放進迴圈。
  const isSpinTarget = (kind, target) => (kind === 'tap' || kind === 'hold')
    && SPIN_RE.test(String(target ?? '')) && !/auto|free|免費|免费/i.test(String(target ?? ''));

  const cands = [];
  for (const s of pageSelfOps(page, pageId, opEdits)) {
    if (!s || !isSpinTarget(s.kind, s.target)) continue;
    cands.push({ key: selfOpKey(pageId, s), kind: s.kind, target: s.target, recorded: s.op, counts: s, self: true });
  }
  const manualKeys = new Set((edits?.addedEdges ?? []).map((e) => edgeKey(e)));
  const fromStruct = (struct.edges ?? []).filter((e) => e.fromPageId === pageId);
  const extraEdges = (edits?.addedEdges ?? [])
    .filter((e) => e.fromPageId === pageId && !fromStruct.some((x) => edgeKey(x) === edgeKey(e)))
    .map((e) => ({ ...e, hitCount: 0, missCount: 0 }));
  for (const e of [...fromStruct, ...extraEdges]) {
    if (!isSpinTarget(e.trigger?.kind, e.trigger?.target)) continue;
    const key = edgeKey(e);
    if (cands.some((c) => c.key === key)) continue;
    cands.push({
      key,
      kind: e.trigger.kind,
      target: e.trigger.target,
      recorded: e.op,
      counts: { hitCount: e.hitCount, missCount: e.missCount, manual: manualKeys.has(key) },
      self: false,
    });
  }

  const list = cands
    .map((c) => {
      const edit = opEdits[c.key];
      return { ...c, edit, trust: opTrust(c.counts, edit), op: effectiveOp(c.recorded, edit) };
    })
    // learning 但已成功 ≥ REFLEX_MIN_HITS_SPIN 次且沒失敗過也放行(見上面的註解)。
    .filter((x) => x.op && x.op.a === x.kind && !state?.demoted?.has(x.key)
      && (x.trust === 'verified' || x.trust === 'auto'
        || (x.trust === 'learning' && (x.counts.hitCount ?? 0) >= REFLEX_MIN_HITS_SPIN && (x.counts.missCount ?? 0) === 0)))
    .filter((x) => !(x.op.v && version && x.op.v !== version && !x.edit?.op && state?.crossVersionFailed))
    .sort((a, b) => (b.trust === 'verified') - (a.trust === 'verified')
      || (b.counts.hitCount ?? 0) - (a.counts.hitCount ?? 0)
      || (b.self === true) - (a.self === true));
  const best = list[0];
  return best ? { key: best.key, op: best.op, target: best.target, trust: best.trust } : null;
}

/**
 * RTP 統計:逐局(下注 / 贏分)+ 餘額交叉驗算 + 95% 信賴區間。
 * rounds = [{ bet, win }](付費局;Free Spin 的贏分算在觸發的那一局,或由餘額差補上)。
 */
export function rtpSummary(rounds, { startBalance, endBalance } = {}) {
  const valid = (rounds ?? []).filter((r) => Number.isFinite(r?.bet) && r.bet > 0 && Number.isFinite(r?.win) && r.win >= 0);
  if (!valid.length) return null;
  const totalBet = valid.reduce((s, r) => s + r.bet, 0);
  const totalWin = valid.reduce((s, r) => s + r.win, 0);
  const ratios = valid.map((r) => r.win / r.bet);
  const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
  const sd = ratios.length > 1 ? Math.sqrt(ratios.reduce((s, x) => s + (x - mean) ** 2, 0) / (ratios.length - 1)) : 0;
  const half = ratios.length > 1 ? (1.96 * sd) / Math.sqrt(ratios.length) : 0;
  const pct = (v) => Math.round(v * 10000) / 100;
  const out = {
    rounds: valid.length,
    totalBet,
    totalWin,
    rtpPercent: pct(totalWin / totalBet),
    hitRatePercent: pct(valid.filter((r) => r.win > 0).length / valid.length),
    ci95: [pct(Math.max(0, mean - half)), pct(mean + half)],
  };
  if (Number.isFinite(startBalance) && Number.isFinite(endBalance)) {
    // 餘額差法:總贏分 = 結束餘額 − 開始餘額 + 總下注(含 Free Spin 贏分,但每日獎勵等加幣也會混進來)。
    out.balanceCheck = { startBalance, endBalance, rtpPercent: pct((endBalance - startBalance + totalBet) / totalBet) };
  }
  return out;
}
