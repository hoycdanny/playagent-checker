/**
 * RTP 帳務(可溯源):每一個進入計算的數字都對應到「哪一步、哪個畫面讀到的值」。
 *
 * 量測方法 = 餘額差法(AutoSpin):AI 只讀畫面數字(AutoSpin 剩餘局數、餘額、投注額),由程式計算。
 *  - 量測區間(window):同一連線段、同一投注額、AutoSpin 計數連續遞減的一段。計數回升(重開 AutoSpin)、
 *    換投注額、換連線都會切開新區間;區間與區間之間的餘額變化(例如在大廳領登入獎勵)一律不計。
 *  - 區間內:付費局數 = 計數遞減總和;投注 = 局數 × 投注額;餘額變化 = 末筆餘額 − 首筆餘額。
 *  - 非拉霸收入(升級 / 任務 / 登入 / 活動贈送):落在區間內的必須逐筆扣除;金額讀不到或是估計值 → 淨 RTP 不可算。
 *  - 淨 RTP = (Σ餘額變化 − Σ區間內非拉霸收入 + Σ投注) ÷ Σ投注。
 *
 * 統計:單局報酬標準差 σ(以投注額倍數計)由知識庫規格 rtpStdDev 提供;沒提供時用 6(中波動參考值,標示為假設)。
 *  95% 信賴區間半寬 = 1.96 × σ ÷ √n;要把誤差壓到 ±1 個百分點所需局數 = (1.96σ ÷ 0.01)²。
 */
import type { EvidenceStep, L10n } from './types.js';

const L = (zh: string, en: string): L10n => ({ zh, en });
const round2 = (v: number) => Math.round(v * 100) / 100;

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface LedgerPoint { step: number; value: number }

export interface RtpWindow {
  id: string;
  segment: number;
  bet: number;
  firstStep: number;
  lastStep: number;
  counterStart: LedgerPoint;
  counterEnd: LedgerPoint;
  spins: number;
  wagered: number;
  balanceStart: LedgerPoint;
  balanceEnd: LedgerPoint;
  balanceDelta: number;
  /** 參與計算的觀測步(AutoSpin 計數 + 餘額同時讀到的步驟)。 */
  steps: number[];
}

/** obs = 結構化讀值;balance_diff = 確定性餘額差;ai_read = AI 文字;none_seen = 沒有入帳描述(視為 0);unresolved = 不可採用。 */
export type CreditBasis = 'obs' | 'balance_diff' | 'ai_read' | 'none_seen' | 'unresolved';

export interface NonSlotCredit {
  id: string;
  steps: number[];
  screen: string;
  amount: number | null;
  basis: CreditBasis;
  /** 落在某個量測區間內(必須扣除才能算淨 RTP)。 */
  windowId?: string;
  /** AI 原文(判斷依據,可回溯)。 */
  quote?: string;
  note: L10n;
}

export interface RtpStats {
  sigma: number;
  sigmaSource: 'spec' | 'assumed';
  /** 95% 信賴區間半寬(百分點)。 */
  ci95Pp: number | null;
  /** 誤差 ±1 個百分點所需局數。 */
  spinsFor1Pp: number;
  expectedRtp?: number;
  /** (觀測 − 理論) ÷ 標準誤。 */
  z?: number;
}

export interface RtpLedger {
  method: 'autospin_balance';
  windows: RtpWindow[];
  spins: number;
  wagered: number;
  balanceDelta: number;
  credits: NonSlotCredit[];
  /** 區間內已確認金額的非拉霸收入合計。 */
  creditsInWindow: number;
  /** 區間內金額讀不到 / 是估計值的筆數(> 0 時淨 RTP 不可算)。 */
  unresolvedInWindow: number;
  /** 未扣非拉霸收入(上限參考)。 */
  rtpGross: number;
  /** 已扣非拉霸收入;有未確認金額時為 null。 */
  rtpNet: number | null;
  /** 推算總派彩 = 投注 + 餘額變化 − 區間內非拉霸收入(淨 RTP 不可算時為 null)。 */
  derivedWin: number | null;
  stats: RtpStats;
  formula: L10n;
}

/** 非拉霸收入畫面(升級 / 任務 / 登入 / 活動 / 寶箱)。Free Spins、BIG WIN、Jackpot 屬拉霸收入,不算。 */
const REWARD_SCREEN = /level\s*up|升級|升级|每日登入|登入獎勵|登入寶箱|7\s*日|七日|寶箱|宝箱|任務|任务|mission|活動獎勵|活動彈窗|reward|獎勵|奖励|daily\s*bonus|gift|禮物|礼物/i;
const SLOT_INCOME_SCREEN = /free\s*spin|免費|免费|big\s*win|mega\s*win|super\s*win|epic|total\s*win|jackpot|結算|结算|載入|载入|loading/i;
/** AI 把非拉霸收入寫成估計值的字樣。 */
export const ESTIMATE_RE = /約\s*\d|约\s*\d|大約|大约|估算|估計|估计|推斷|推断|推算|待核對|待核对|遮擋|遮挡|看不清|approx|estimat|about\s+\d/i;
/** AI 明確說沒有贈送。 */
const NO_CREDIT_RE = /(?:沒有|没有|無|无|不含|未)\s*.{0,4}(?:金幣|金币|贈送|赠送|獎勵|奖励|入帳|入账)|no\s+(?:coins?|rewards?|credit)/i;
/** 有入帳 / 領取的描述(代表可能有金幣進帳)。 */
const CREDIT_VERB_RE = /入帳|入账|到帳|到账|領取|领取|collect|贈送|赠送|獲得|获得|加了|增加.{0,6}金幣/i;
/** thinking 裡「入帳 / 贈送」金額的寫法:「= 11,500 入帳」「+130,000」「REWARD 10K」。 */
const AMOUNT_RE = /(?:=|＝|合計|共|入帳|入账|獲得|获得|贈送|赠送|\+)\s*([\d,]+(?:\.\d+)?)\s*([KkMm萬万])?\s*(?:入帳|入账)?/g;

function parseAmount(numText: string, unit?: string): number | null {
  const n = Number(numText.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const mul = !unit ? 1 : /[Kk]/.test(unit) ? 1e3 : /[Mm]/.test(unit) ? 1e6 : 1e4;
  return Math.round(n * mul);
}

/** 從 AI 文字讀「入帳金額」:取最後一個金額(通常是加總後的數字)。估計字樣 → 不採用。 */
function amountFromText(text: string): { amount: number | null; estimated: boolean; quote?: string } {
  const estimated = ESTIMATE_RE.test(text);
  let last: { amount: number; quote: string } | null = null;
  for (const m of text.matchAll(AMOUNT_RE)) {
    const a = parseAmount(m[1]!, m[2]);
    if (a !== null && a >= 100) last = { amount: a, quote: m[0].trim() };
  }
  if (!last) return { amount: null, estimated };
  return { amount: estimated ? null : last.amount, estimated, quote: last.quote };
}

/** 把 AutoSpin 觀測切成量測區間。 */
export function autospinWindows(steps: EvidenceStep[]): RtpWindow[] {
  type P = { step: number; left: number; balance: number; bet?: number; seg: number };
  const pts: P[] = [];
  for (const s of steps) {
    const o = s.obs;
    if (!o) continue;
    const left = toNum(o['autospin_left']);
    const balance = toNum(o['balance']);
    if (left === null || balance === null || left < 0) continue;
    const bet = toNum(o['bet']);
    pts.push({ step: s.index, left, balance, seg: s.segment ?? 1, ...(bet !== null && bet > 0 ? { bet } : {}) });
  }
  if (pts.length < 2) return [];
  const bets = pts.map((p) => p.bet).filter((b): b is number => typeof b === 'number').sort((a, b) => a - b);
  const median = bets.length ? bets[Math.floor(bets.length / 2)]! : null;
  if (!median) return [];
  const groups: Array<{ pts: P[]; bet: number }> = [];
  let curBet = pts[0]!.bet ?? median;
  let group: P[] = [];
  for (const p of pts) {
    const b = p.bet ?? curBet;
    const last = group[group.length - 1];
    // 換連線、換投注額、計數回升(重開 AutoSpin)→ 新區間。
    if (last && (last.seg !== p.seg || b !== curBet || p.left > last.left)) { groups.push({ pts: group, bet: curBet }); group = []; }
    curBet = b;
    group.push(p);
  }
  if (group.length) groups.push({ pts: group, bet: curBet });
  const out: RtpWindow[] = [];
  for (const g of groups) {
    if (g.pts.length < 2) continue;
    const first = g.pts[0]!;
    const last = g.pts[g.pts.length - 1]!;
    const spins = first.left - last.left;
    if (spins <= 0) continue;
    out.push({
      id: `W${out.length + 1}`,
      segment: first.seg,
      bet: g.bet,
      firstStep: first.step,
      lastStep: last.step,
      counterStart: { step: first.step, value: first.left },
      counterEnd: { step: last.step, value: last.left },
      spins,
      wagered: spins * g.bet,
      balanceStart: { step: first.step, value: first.balance },
      balanceEnd: { step: last.step, value: last.balance },
      balanceDelta: last.balance - first.balance,
      steps: g.pts.map((p) => p.step),
    });
  }
  return out;
}

/** 偵測非拉霸收入事件並判定金額依據(確定性餘額差 > 結構化觀測 > AI 文字 > 無法確認)。 */
export function nonSlotCredits(steps: EvidenceStep[], windows: RtpWindow[]): NonSlotCredit[] {
  const byIndex = new Map(steps.map((s) => [s.index, s] as const));
  const ordered = [...steps].sort((a, b) => a.index - b.index);
  const isReward = (s: EvidenceStep) => REWARD_SCREEN.test(s.screen) && !SLOT_INCOME_SCREEN.test(s.screen);
  // 連續(間隔 ≤ 2 步)且同一類的獎勵畫面視為同一事件(升級與任務說明不合併)。
  // 登入類(每日登入 / 7 日寶箱 / 骰子)通常連著跳,合成一筆。
  const kindOf = (s: EvidenceStep) => {
    const t = s.screen;
    if (/level\s*up|升級|升级/i.test(t)) return 'level';
    if (/登入|登录|7\s*日|七日|寶箱|宝箱|daily/i.test(t)) return 'login';
    if (/任務|任务|mission/i.test(t)) return 'mission';
    return 'other';
  };
  const events: EvidenceStep[][] = [];
  for (const s of ordered) {
    const hasObs = toNum(s.obs?.['non_slot_credit']) !== null;
    if (!isReward(s) && !hasObs) continue;
    const cur = events[events.length - 1];
    const prev = cur?.[cur.length - 1];
    if (cur && prev && s.index - prev.index <= 2 && kindOf(prev) === kindOf(s)) cur.push(s);
    else events.push([s]);
  }
  const windowOf = (idx: number) => windows.find((w) => idx >= w.firstStep && idx <= w.lastStep);
  const balanceAt = (s: EvidenceStep | undefined) => (s ? toNum(s.obs?.['balance']) : null);
  const out: NonSlotCredit[] = [];
  for (const ev of events) {
    const first = ev[0]!;
    const last = ev[ev.length - 1]!;
    const win = ev.map((s) => windowOf(s.index)).find(Boolean);
    const quoteText = ev.map((s) => s.thinking ?? '').join(' ');
    const base = { id: `C${out.length + 1}`, steps: ev.map((s) => s.index), screen: first.screen, ...(win ? { windowId: win.id } : {}) };
    // (1) 結構化觀測(runner 新版:obs.non_slot_credit,只在金額清楚可讀時填)。
    const obsSum = ev.reduce((a, s) => a + (toNum(s.obs?.['non_slot_credit']) ?? 0), 0);
    if (obsSum > 0) {
      out.push({ ...base, amount: obsSum, basis: 'obs', note: L('AI 依畫面讀到的贈送金額(結構化觀測 non_slot_credit)', 'Amount read from screen by the AI (structured obs non_slot_credit)') });
      continue;
    }
    // (2) 事件前後的餘額差,且中間沒有轉軸在轉(AutoSpin 計數沒變、沒有轉軸畫面)→ 確定性金額。
    const before = [...ordered].reverse().find((s) => s.index < first.index && balanceAt(s) !== null);
    const after = ordered.find((s) => s.index > last.index && balanceAt(s) !== null);
    if (before && after) {
      const between = ordered.filter((s) => s.index > before.index && s.index < after.index);
      const leftB = toNum(byIndex.get(before.index)?.obs?.['autospin_left']);
      const leftA = toNum(byIndex.get(after.index)?.obs?.['autospin_left']);
      const counterMoved = leftB !== null && leftA !== null && leftB !== leftA;
      const spinning = between.some((s) => s.obs?.['spun'] === true || toNum(s.obs?.['autospin_left']) !== null) || counterMoved || (leftB !== null && leftA === null) || (leftB === null && leftA !== null);
      const delta = (balanceAt(after) ?? 0) - (balanceAt(before) ?? 0);
      if (!spinning && delta > 0) {
        out.push({
          ...base,
          amount: delta,
          basis: 'balance_diff',
          note: L(`餘額 #${before.index} ${balanceAt(before)!.toLocaleString('en-US')} → #${after.index} ${balanceAt(after)!.toLocaleString('en-US')},期間沒有旋轉`, `Balance #${before.index} ${balanceAt(before)!.toLocaleString('en-US')} → #${after.index} ${balanceAt(after)!.toLocaleString('en-US')} with no spins in between`),
        });
        continue;
      }
    }
    // (3) AI 在 thinking 寫出的入帳金額(不可含估計字樣)。
    const t = amountFromText(quoteText);
    if (t.amount !== null) {
      out.push({ ...base, amount: t.amount, basis: 'ai_read', ...(t.quote ? { quote: t.quote } : {}), note: L('AI 在該步說明中寫出的入帳金額', 'Credited amount stated by the AI at that step') });
      continue;
    }
    // (4) AI 明確寫「沒有贈送」→ 0。
    const noCredit = NO_CREDIT_RE.exec(quoteText);
    if (noCredit && !t.estimated) {
      out.push({ ...base, amount: 0, basis: 'ai_read', quote: noCredit[0], note: L('AI 明確描述此彈窗沒有贈送金幣', 'The AI stated this popup gives no coins') });
      continue;
    }
    // (5) 不是升級類、AI 也沒有任何「入帳 / 領取」描述 → 視為沒有看到贈送(0),但標示出來供人工確認。
    if (kindOf(first) !== 'level' && !t.estimated && !CREDIT_VERB_RE.test(quoteText)) {
      out.push({ ...base, amount: 0, basis: 'none_seen', note: L('畫面說明沒有任何入帳 / 領取描述,視為沒有贈送;若實際有入帳,RTP 會偏高', 'No credit / collect wording in the AI notes; treated as no credit. If coins were actually credited, RTP is overstated') });
      continue;
    }
    out.push({
      ...base,
      amount: null,
      basis: 'unresolved',
      ...(t.quote ? { quote: t.quote } : {}),
      note: t.estimated
        ? L('AI 標示為估計 / 被遮擋 / 待核對,金額不可採用', 'The AI marked the amount as estimated / occluded / unverified; not usable')
        : L('畫面沒有讀到明確金額(可能沒有贈送,或彈窗已自動關閉)', 'No explicit amount was read (possibly no credit, or the popup closed by itself)'),
    });
  }
  return out;
}

export function buildRtpLedger(steps: EvidenceStep[], values: Record<string, number>): RtpLedger | null {
  const windows = autospinWindows(steps);
  if (!windows.length) return null;
  const credits = nonSlotCredits(steps, windows);
  const spins = windows.reduce((a, w) => a + w.spins, 0);
  const wagered = windows.reduce((a, w) => a + w.wagered, 0);
  const balanceDelta = windows.reduce((a, w) => a + w.balanceDelta, 0);
  const inWin = credits.filter((c) => c.windowId);
  // 「沒有讀到金額」且 AI 也沒寫估計字樣的事件(例如 Newbie Mission 說明頁)不一定有入帳;
  // 但它在量測區間內,就無法證明沒有入帳 → 一律算未確認。
  const unresolvedInWindow = inWin.filter((c) => c.amount === null).length;
  const creditsInWindow = inWin.reduce((a, c) => a + (c.amount ?? 0), 0);
  const rtpGross = round2(((wagered + balanceDelta) / wagered) * 100);
  const rtpNet = unresolvedInWindow ? null : round2(((wagered + balanceDelta - creditsInWindow) / wagered) * 100);
  const specSigma = values['rtpStdDev'];
  const sigma = typeof specSigma === 'number' && specSigma > 0 ? specSigma : 6;
  const se = sigma / Math.sqrt(spins);
  const expectedRtp = typeof values['expectedRtp'] === 'number' ? values['expectedRtp'] : undefined;
  const observed = rtpNet ?? null;
  return {
    method: 'autospin_balance',
    windows,
    spins,
    wagered,
    balanceDelta,
    credits,
    creditsInWindow,
    unresolvedInWindow,
    rtpGross,
    rtpNet,
    derivedWin: rtpNet === null ? null : wagered + balanceDelta - creditsInWindow,
    stats: {
      sigma,
      sigmaSource: typeof specSigma === 'number' && specSigma > 0 ? 'spec' : 'assumed',
      ci95Pp: round2(1.96 * se * 100),
      spinsFor1Pp: Math.ceil(((1.96 * sigma) / 0.01) ** 2),
      ...(expectedRtp !== undefined ? { expectedRtp } : {}),
      ...(expectedRtp !== undefined && observed !== null ? { z: round2((observed - expectedRtp) / 100 / se) } : {}),
    },
    formula: L(
      '淨 RTP =(Σ區間餘額變化 − Σ區間內非拉霸收入 + Σ投注)÷ Σ投注;投注 = 區間付費局數 × 投注額',
      'Net RTP = (Σ window balance change − Σ in-window non-slot credits + Σ wagered) ÷ Σ wagered; wagered = paid spins × bet',
    ),
  };
}
