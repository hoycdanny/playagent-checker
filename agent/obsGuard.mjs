/**
 * 即時數值把關(runner 每步呼叫):視覺 Agent 讀到的狀態型數值(餘額、貨幣、投注額、剩餘次數…)
 * 如果和上一筆差 10 倍以上,先標成「疑似讀錯」,不交給輔助 Agent 當成事實(避免它拿錯的數字去比對)。
 * 投注額改變且下一步仍是新值 → 「投注額變更」警告。
 *
 * 這裡只做即時提示;報告裡的最終判定(哪些值不計入 RTP)由報告引擎 dataQuality.ts 用前後兩筆一起判斷。
 * 每筆警告都帶步驟與前後值,可回溯。
 */

const LEVEL_KEY = /balance|currency|gold|coin|credit|cash|money|chip|gem|diamond|bet|_left$|remaining/;
const EVENT_KEY = /win|payout|reward|prize|bonus|jackpot/;
const BET_KEY = /^(total_)?bet$/;
const SPIKE_RATIO = 10;
const NEAR_RATIO = 3;
const MIN_MAGNITUDE = 20;

export const isLevelKey = (k) => LEVEL_KEY.test(String(k).toLowerCase()) && !EVENT_KEY.test(String(k).toLowerCase());

function ratio(a, b) {
  const x = Math.abs(a);
  const y = Math.abs(b);
  if (x === y) return 1;
  if (x === 0 || y === 0) return Infinity;
  return Math.max(x, y) / Math.min(x, y);
}

const toNum = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^[-+]?[\d,]+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export function createObsGuard() {
  /** key → 最近一筆採信的值 { v, step } */
  let accepted = new Map();
  /** key → 疑似讀錯 / 新水位候選 { v, step } */
  let candidate = new Map();
  /** 投注額:採信值與待確認的新值 */
  let bet = null; // { key, v, step }
  let betPending = null; // { v, step }

  return {
    /** 換新連線(遊戲重裝、數值重置)時呼叫:之後的數值不跟前一段比。 */
    reset() {
      accepted = new Map();
      candidate = new Map();
      bet = null;
      betPending = null;
    },

    /**
     * @param {number} step
     * @param {Record<string, unknown>|undefined} obs
     * @returns {{ clean: Record<string, unknown>|undefined, warnings: Array<object> }}
     */
    check(step, obs) {
      const warnings = [];
      if (!obs || typeof obs !== 'object') return { clean: obs, warnings };
      const clean = { ...obs };
      for (const [k, raw] of Object.entries(obs)) {
        if (!isLevelKey(k)) continue;
        const v = toNum(raw);
        if (v === null) continue;
        const prev = accepted.get(k);
        const cand = candidate.get(k);
        // 上一筆被標成疑似,這一筆又跟它接近 → 是真的跳動(例如大獎),改採信新水位。
        if (cand && ratio(v, cand.v) < NEAR_RATIO) {
          accepted.set(k, { v, step });
          candidate.delete(k);
          continue;
        }
        if (prev && Math.max(Math.abs(v), Math.abs(prev.v)) >= MIN_MAGNITUDE && ratio(v, prev.v) >= SPIKE_RATIO) {
          candidate.set(k, { v, step });
          delete clean[k];
          warnings.push({ kind: 'suspect_value', key: k, value: v, prev: { step: prev.step, value: prev.v } });
          continue;
        }
        candidate.delete(k);
        accepted.set(k, { v, step });
      }
      // 投注額變更(讀錯的已在上面排除)。
      const betKey = Object.keys(clean).find((k) => BET_KEY.test(k.toLowerCase()));
      const bv = betKey ? toNum(clean[betKey]) : null;
      if (betKey && bv !== null) {
        if (!bet) bet = { key: betKey, v: bv, step };
        else if (bv === bet.v) { bet.step = step; betPending = null; }
        else if (betPending && betPending.v === bv) {
          warnings.push({ kind: 'bet_changed', key: betKey, from: bet.v, to: bv, sinceStep: betPending.step, prevStep: bet.step });
          bet = { key: betKey, v: bv, step };
          betPending = null;
        } else betPending = { v: bv, step };
      }
      return { clean, warnings };
    },
  };
}
