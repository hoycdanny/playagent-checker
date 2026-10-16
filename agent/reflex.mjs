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
    if (trust === 'disabled' || trust === 'learning') continue;
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
    candidates.push({ e, key, op, trust, target, toPage, cross });
  }
  if (!candidates.length) return null;

  const rank = (x) => (x.trust === 'verified' ? 1e6 : 0) + (x.e.hitCount ?? 0);
  const pick = (list, reason) => {
    const best = [...list].sort((a, b) => rank(b) - rank(a))[0];
    return best
      ? { key: best.key, op: best.op, toPageId: best.e.toPageId, target: best.target, trust: best.trust, reason, cross: best.cross, hits: best.e.hitCount ?? 0, misses: best.e.missCount ?? 0 }
      : null;
  };

  // 1) 測試人員畫的路線:目前畫面在路線上 → 走路線的下一個畫面。
  for (const r of edits?.routes ?? []) {
    if (!r || r.enabled === false || !Array.isArray(r.steps)) continue;
    const idx = r.steps.findIndex((s) => s.pageId === pageId);
    const next = idx >= 0 ? r.steps[idx + 1] : null;
    if (!next) continue;
    const onRoute = candidates.filter((x) => x.e.toPageId === next.pageId);
    if (onRoute.length) return pick(onRoute, 'route');
  }
  // 2) 目標文字有點名的出路(例如「進入 Desert Legend」)。
  const named = candidates.filter((x) => mentions(goalText, x.target) || (x.toPage && mentions(goalText, x.toPage.name, 3)));
  if (named.length) return pick(named, 'named');
  // 目標點名了「別的」出路(這裡記憶沒有可用的版本)→ 交給 AI,不要照習慣走。
  const otherNamed = all.some((e) => mentions(goalText, e.trigger?.target) || mentions(goalText, struct.pages?.[e.toPageId]?.name, 3));
  if (otherNamed) return null;
  // 3) 彈窗:照記憶關掉。
  if (popup) return pick(candidates, 'popup');
  // 4) 這個畫面的主要出口(佔使用次數 ≥ 60%)或測試人員確認過的唯一一條。
  const verified = candidates.filter((x) => x.trust === 'verified');
  if (verified.length === 1 && !candidates.some((x) => x.trust !== 'verified' && (x.e.hitCount ?? 0) > (verified[0].e.hitCount ?? 0))) {
    return pick(verified, 'verified');
  }
  const dominant = candidates.filter((x) => totalHits > 0 && (x.e.hitCount ?? 0) / totalHits >= DOMINANT_SHARE);
  if (dominant.length) return pick(dominant, 'dominant');
  return null;
}

/**
 * SPIN 迴圈:這個畫面有沒有可信的 SPIN 操作。回 { key, op, target, trust } 或 null。
 */
export function chooseSpinOp({ struct, edits, pageId, version, state }) {
  const page = struct?.pages?.[pageId];
  if (!page || page.transient) return null;
  const opEdits = edits?.opEdits ?? {};
  const list = (page.selfOps ?? [])
    // AutoSpin / 免費遊戲的按鈕不是「付費一局」,不放進迴圈。
    .filter((s) => s && (s.kind === 'tap' || s.kind === 'hold') && SPIN_RE.test(String(s.target ?? '')) && !/auto|free|免費|免费/i.test(String(s.target ?? '')))
    .map((s) => {
      const key = selfOpKey(pageId, s);
      const edit = opEdits[key];
      return { s, key, edit, trust: opTrust(s, edit), op: effectiveOp(s.op, edit) };
    })
    .filter((x) => x.op && x.op.a === x.s.kind && (x.trust === 'verified' || x.trust === 'auto') && !state?.demoted?.has(x.key))
    .filter((x) => !(x.op.v && version && x.op.v !== version && !x.edit?.op && state?.crossVersionFailed))
    .sort((a, b) => (b.trust === 'verified') - (a.trust === 'verified') || (b.s.hitCount ?? 0) - (a.s.hitCount ?? 0));
  const best = list[0];
  return best ? { key: best.key, op: best.op, target: best.s.target, trust: best.trust } : null;
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
