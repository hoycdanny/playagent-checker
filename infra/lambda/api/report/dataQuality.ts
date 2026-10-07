/**
 * 數據品質:找出 AI 讀錯的數值(不計入 RTP 與經濟指標)與投注額變更,每一筆都記下來源步驟、原值與原因,可回溯。
 *
 * 只處理「狀態型」數值(餘額、貨幣、投注額…),不處理「事件型」數值(派彩、獎勵本來就忽大忽小)。
 * 判斷全部是確定性規則,不靠 AI:
 *  - 尖峰:某一筆和前後兩筆都差 10 倍以上,但前後兩筆彼此接近 → 讀錯(例:3,400 萬 → 31 億 → 3,400 萬)。
 *  - 頭尾:第一筆或最後一筆沒有另一側可比,和相鄰那筆差 50 倍以上 → 讀錯(無法再確認,保守排除)。
 *  - 投注額單筆跳動:前後兩筆一樣、只有中間這筆不同 → 讀錯。
 *  - 投注額變更:改變後下一筆仍是新值(或已是最後一筆)→ 記為「投注額變更」,不排除。
 * 跨連線段(長時模式換新連線,遊戲重新安裝)不互相比較。
 */
import type { EvidenceStep, L10n } from './types.js';

const L = (zh: string, en: string): L10n => ({ zh, en });

/** 狀態型數值(排除事件型:win/payout/reward/prize…)。 */
const LEVEL_KEY = /balance|currency|gold|coin|credit|cash|money|chip|gem|diamond|bet|_left$|remaining/;
const EVENT_KEY = /win|payout|reward|prize|bonus|jackpot/;
const BET_KEY = /^(total_)?bet$/;
const SPIKE_RATIO = 10;
const EDGE_RATIO = 50;
const NEAR_RATIO = 3;
const MIN_MAGNITUDE = 20;

export interface ExcludedValue {
  step: number;
  key: string;
  value: number;
  reason: L10n;
  prev?: { step: number; value: number };
  next?: { step: number; value: number };
}

export interface BetChange {
  step: number;
  prevStep: number;
  key: string;
  from: number;
  to: number;
}

export interface DataQuality {
  excluded: ExcludedValue[];
  betChanges: BetChange[];
}

export function isLevelKey(key: string): boolean {
  const k = key.toLowerCase();
  return LEVEL_KEY.test(k) && !EVENT_KEY.test(k);
}

/** 兩數相差倍數(同值 = 1;一邊為 0 另一邊不為 0 = ∞)。 */
function ratio(a: number, b: number): number {
  const x = Math.abs(a);
  const y = Math.abs(b);
  if (x === y) return 1;
  if (x === 0 || y === 0) return Infinity;
  return Math.max(x, y) / Math.min(x, y);
}

const fmt = (n: number) => n.toLocaleString('en-US');

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^[-+]?[\d,]+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 回傳「清理後」的步驟(讀錯的值從 obs 移除,改記在 excludedObs)與數據品質清單。不改動輸入。
 */
export function sanitizeObs(steps: EvidenceStep[]): { steps: EvidenceStep[]; quality: DataQuality } {
  const excluded: ExcludedValue[] = [];
  const betChanges: BetChange[] = [];
  const keys = new Set<string>();
  for (const s of steps) for (const k of Object.keys(s.obs ?? {})) if (isLevelKey(k)) keys.add(k);

  const drop = new Map<number, Map<string, ExcludedValue>>(); // steps 陣列位置 → key → 排除紀錄
  const mark = (pos: number, e: ExcludedValue) => {
    const m = drop.get(pos) ?? new Map<string, ExcludedValue>();
    m.set(e.key, e);
    drop.set(pos, m);
    excluded.push(e);
  };

  for (const key of keys) {
    // 依連線段分組的時間序列。
    const bySeg = new Map<number, Array<{ pos: number; step: number; v: number }>>();
    steps.forEach((s, pos) => {
      const v = asNum(s.obs?.[key]);
      if (v === null) return;
      const seg = s.segment ?? 1;
      const list = bySeg.get(seg) ?? [];
      list.push({ pos, step: s.index, v });
      bySeg.set(seg, list);
    });
    for (const series of bySeg.values()) {
      const isBet = BET_KEY.test(key.toLowerCase());
      const bad = new Set<number>();
      for (let j = 0; j < series.length; j++) {
        const cur = series[j]!;
        const prev = series[j - 1];
        const next = series[j + 1];
        const ref = { ...(prev ? { prev: { step: prev.step, value: prev.v } } : {}), ...(next ? { next: { step: next.step, value: next.v } } : {}) };
        if (prev && next) {
          // 小數字(剩餘 3 次 → 0 次)不做倍數判斷,避免把正常歸零當成讀錯。
          if (Math.max(Math.abs(prev.v), Math.abs(next.v)) >= MIN_MAGNITUDE
            && ratio(cur.v, prev.v) >= SPIKE_RATIO && ratio(cur.v, next.v) >= SPIKE_RATIO && ratio(prev.v, next.v) < NEAR_RATIO) {
            bad.add(j);
            mark(cur.pos, {
              step: cur.step, key, value: cur.v, ...ref,
              reason: L(
                `和前後兩筆差距過大(前 #${prev.step} = ${fmt(prev.v)},後 #${next.step} = ${fmt(next.v)}),判定為讀錯`,
                `Far from both neighbours (#${prev.step} = ${fmt(prev.v)}, #${next.step} = ${fmt(next.v)}); treated as a misread`,
              ),
            });
            continue;
          }
          if (isBet && prev.v === next.v && cur.v !== prev.v) {
            bad.add(j);
            mark(cur.pos, {
              step: cur.step, key, value: cur.v, ...ref,
              reason: L(
                `前後兩筆投注額都是 ${fmt(prev.v)},只有這一筆不同,判定為讀錯`,
                `Bet is ${fmt(prev.v)} before and after; only this reading differs, treated as a misread`,
              ),
            });
          }
          continue;
        }
        // 頭尾:只有一側可比。
        const only = prev ?? next;
        if (!only || series.length < 3) continue;
        const beyond = prev ? series[j - 2] : series[j + 2];
        const confirmed = beyond !== undefined && ratio(only.v, beyond.v) < NEAR_RATIO;
        if (confirmed && Math.abs(only.v) >= MIN_MAGNITUDE && ratio(cur.v, only.v) >= EDGE_RATIO) {
          bad.add(j);
          mark(cur.pos, {
            step: cur.step, key, value: cur.v, ...ref,
            reason: prev
              ? L(`最後一筆和前一筆(#${only.step} = ${fmt(only.v)})差 ${Math.round(ratio(cur.v, only.v))} 倍,無法再確認,判定為讀錯`, `Last reading is ${Math.round(ratio(cur.v, only.v))}× the previous one (#${only.step} = ${fmt(only.v)}); cannot be confirmed, treated as a misread`)
              : L(`第一筆和下一筆(#${only.step} = ${fmt(only.v)})差 ${Math.round(ratio(cur.v, only.v))} 倍,判定為讀錯`, `First reading is ${Math.round(ratio(cur.v, only.v))}× the next one (#${only.step} = ${fmt(only.v)}); treated as a misread`),
          });
        }
      }
      // 投注額變更(排除讀錯後):改變後下一筆仍是新值,或已是最後一筆。
      if (isBet) {
        const ok = series.filter((_, j) => !bad.has(j));
        for (let j = 1; j < ok.length; j++) {
          const a = ok[j - 1]!;
          const b = ok[j]!;
          if (a.v === b.v) continue;
          const after = ok[j + 1];
          if (after === undefined || after.v === b.v) betChanges.push({ step: b.step, prevStep: a.step, key, from: a.v, to: b.v });
        }
      }
    }
  }

  if (drop.size === 0) return { steps, quality: { excluded, betChanges } };
  const out = steps.map((s, pos) => {
    const d = drop.get(pos);
    if (!d || !s.obs) return s;
    const obs = { ...s.obs };
    const excludedObs: NonNullable<EvidenceStep['excludedObs']> = { ...(s.excludedObs ?? {}) };
    for (const [k, e] of d) {
      delete obs[k];
      excludedObs[k] = { value: e.value, reason: e.reason };
    }
    const next: EvidenceStep = { ...s, excludedObs };
    if (Object.keys(obs).length) next.obs = obs;
    else delete next.obs;
    return next;
  });
  excluded.sort((a, b) => a.step - b.step || a.key.localeCompare(b.key));
  betChanges.sort((a, b) => a.step - b.step);
  return { steps: out, quality: { excluded, betChanges } };
}
