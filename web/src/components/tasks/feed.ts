/**
 * 「這一刻」事件流:把步驟 / AI 呼叫 / 記憶 / 腳本 / 裝置 log / 音效 / 測試人員指令
 * 合成一條依時間排序的清單,讓使用者用類別 + 類型 + 關鍵字一層一層過濾下去。
 * 時間一律是 runner 時鐘 epoch ms(與任務時間軸相同)。
 */
import type { RLang } from '../report/reportText.ts';
import { memoryChips, type StepMemory } from './memoryUsage.ts';
import type { SoundEvent } from './soundEvents.ts';
import type { Timeline } from './timeline.ts';

export type FeedKind = 'step' | 'ai' | 'memory' | 'script' | 'log' | 'sound' | 'operator';
export const FEED_KINDS: FeedKind[] = ['step', 'ai', 'memory', 'script', 'log', 'sound', 'operator'];

export interface FeedEvent {
  /** 穩定 id(同一份資料重算不變)。 */
  id: string;
  t: number;
  kind: FeedKind;
  /** 類型(第二層過濾):step = 誰決定的、ai = 哪個 Agent、memory = 命中種類、log = 等級、sound = 音效種類。 */
  sub: string;
  title: string;
  detail?: string;
  /** log 的 tag / AI 的模型(第三層過濾)。 */
  tag?: string;
  step?: number;
  /** 嚴重度:錯誤 / 警告(紅、黃)。 */
  tone?: 'bad' | 'warn' | 'good';
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** 誰決定的(步驟)。runner:decidedBy = agent / vision / reflex;測試人員直接操作 = operator。 */
export function deciderOf(s: Record<string, unknown>): string {
  if (s.operatorGesture || s.operatorTap) return 'operator';
  const by = str(s.decidedBy);
  if (by === 'reflex' || by === 'vision' || by === 'agent') return by;
  return 'agent';
}

export function buildFeed({ tl, steps, sounds = [], lang }: {
  tl: Timeline;
  steps: Array<Record<string, unknown> & { index: number }>;
  sounds?: SoundEvent[];
  lang: RLang;
}): FeedEvent[] {
  const out: FeedEvent[] = [];
  const byIndex = new Map(steps.map((s) => [s.index, s]));
  let lastScript = '';
  for (const ts of tl.steps) {
    const s: Record<string, unknown> = byIndex.get(ts.index) ?? {};
    const sub = deciderOf(s);
    const reflex = s.reflex as { kind?: string; reason?: string } | undefined;
    out.push({
      id: `step-${ts.index}`,
      t: ts.t,
      kind: 'step',
      sub,
      title: `#${ts.index} ${ts.screen ?? ''} · ${ts.action ?? ''}${ts.target ? `「${ts.target}」` : ''}`.trim(),
      ...(ts.thinking ? { detail: ts.thinking } : {}),
      step: ts.index,
      ...(s.parseFailed ? { tone: 'warn' as const } : {}),
    });
    // 記憶:照記憶直接做的步驟 + runner 寫的記憶命中標籤。
    if (sub === 'reflex') {
      out.push({ id: `mem-reflex-${ts.index}`, t: ts.t, kind: 'memory', sub: 'reflex', title: lang === 'zh' ? `⚡ 照記憶直接操作${reflex?.reason ? `(${reflex.reason})` : ''}` : `⚡ Replayed from memory${reflex?.reason ? ` (${reflex.reason})` : ''}`, step: ts.index, tone: 'good' });
    }
    const m = s.memory as StepMemory | undefined;
    // memoryChips 的順序:畫面 → 預測結果 → 照已驗證路徑 → 教學 → 路線;類型照同樣順序對上。
    const memSubs: string[] = [];
    if (m?.screen === 'known' || m?.screen === 'learned' || m?.screen === 'new') memSubs.push(m.screen);
    if (m?.arrival) memSubs.push(m.arrival.result === 'followed' ? 'followed' : m.arrival.result === 'no_effect' ? 'no_effect' : 'diverged');
    if (m?.plan) memSubs.push('plan');
    if (m?.hints?.length) memSubs.push('hint');
    if (m?.route?.length) memSubs.push('route');
    memoryChips(m, lang).forEach((c, k) => {
      out.push({ id: `mem-${ts.index}-${k}`, t: ts.t, kind: 'memory', sub: memSubs[k] ?? 'other', title: c.text, detail: c.tip, step: ts.index, ...(c.tone === 'hit' ? { tone: 'good' as const } : c.tone === 'warn' ? { tone: 'warn' as const } : {}) });
    });
    // 腳本:這一步在做腳本第幾項(換項時記一筆)。
    const plan = s.plan as { scriptStep?: unknown; scriptTotal?: unknown; goal?: unknown } | undefined;
    if (typeof plan?.scriptStep === 'number' && typeof plan.scriptTotal === 'number') {
      const key = `${plan.scriptStep}/${plan.scriptTotal}`;
      if (key !== lastScript) {
        lastScript = key;
        out.push({ id: `script-${ts.index}`, t: ts.t, kind: 'script', sub: 'progress', title: `📜 ${lang === 'zh' ? '腳本' : 'Script'} ${key}${str(plan.goal) ? ` · ${str(plan.goal)}` : ''}`, step: ts.index });
      }
    } else if (str(plan?.goal)) {
      out.push({ id: `goal-${ts.index}`, t: ts.t, kind: 'script', sub: 'goal', title: `🎯 ${str(plan!.goal)}`, step: ts.index });
    }
    // 測試人員的指令 / 直接操作。
    const cmds = Array.isArray(s.operatorCommands) ? (s.operatorCommands as Array<{ text?: unknown }>) : [];
    cmds.forEach((c, j) => {
      const text = str(c?.text);
      if (text) out.push({ id: `op-${ts.index}-${j}`, t: ts.t, kind: 'operator', sub: 'command', title: `💬 ${text}`, step: ts.index });
    });
    const direct = Array.isArray(s.operatorDirect) ? (s.operatorDirect as Array<{ kind?: unknown; at?: unknown; said?: unknown }>) : [];
    direct.forEach((d, j) => {
      const t = typeof d.at === 'string' ? Date.parse(d.at) : ts.t;
      out.push({ id: `opd-${ts.index}-${j}`, t: Number.isFinite(t) ? t : ts.t, kind: 'operator', sub: 'gesture', title: `👆 ${String(d.kind ?? 'tap')}${str(d.said) ? ` · ${str(d.said)}` : ''}`, step: ts.index });
    });
  }
  for (const tr of tl.traces) {
    out.push({
      id: `ai-${tr.seat}-${tr.index}-${tr.end}`,
      t: tr.start,
      kind: 'ai',
      sub: tr.seat,
      title: `${tr.ok ? '' : '✕ '}${tr.modelId ?? tr.seat} · #${tr.index}${tr.end - tr.start > 1 ? ` · ${((tr.end - tr.start) / 1000).toFixed(1)}s` : ''}`,
      ...(tr.modelId ? { tag: tr.modelId } : {}),
      step: tr.index,
      ...(tr.ok ? {} : { tone: 'bad' as const }),
    });
  }
  tl.logs.forEach((l, i) => {
    const lv = l.level === 'F' || l.level === 'A' ? 'E' : l.level;
    out.push({
      id: `log-${i}-${l.t}`,
      t: l.t,
      kind: 'log',
      sub: lv,
      title: l.msg,
      tag: l.tag,
      ...(lv === 'E' ? { tone: 'bad' as const } : lv === 'W' ? { tone: 'warn' as const } : {}),
    });
  });
  sounds.forEach((e, i) => {
    out.push({
      id: `snd-${i}-${e.t}`,
      t: e.t,
      kind: 'sound',
      sub: e.kind,
      title: e.kind === 'onset' ? `〰 ${e.peakDb ?? ''} dB · ${((e.durMs ?? 0) / 1000).toFixed(1)}s` : e.title,
      ...(e.detail ? { detail: e.detail } : {}),
      ...(e.step !== undefined ? { step: e.step } : {}),
      ...(e.kind === 'fail' || e.heard === false ? { tone: 'bad' as const } : {}),
    });
  });
  return out.sort((a, b) => a.t - b.t || FEED_KINDS.indexOf(a.kind) - FEED_KINDS.indexOf(b.kind));
}

/** 過濾條件(可層層疊加)。 */
export interface FeedFilter {
  /** 要看的類別。 */
  kinds: FeedKind[];
  /** 各類別要看的類型(沒列 = 全部)。 */
  subs: Partial<Record<FeedKind, string[]>>;
  /** 只看這些 log tag / AI 模型(第三層;空 = 全部)。 */
  tags: string[];
  /** 排除這些 tag(雜訊多的系統 tag)。 */
  excludeTags: string[];
  /** 關鍵字(標題 / 內容 / tag,空白分隔 = 全部都要有)。 */
  query: string;
  /** 時間窗:播放頭前後幾毫秒(0 = 不限)。 */
  windowMs: number;
  /** 只看某一步(null = 不限)。 */
  step: number | null;
}

export const DEFAULT_FILTER: FeedFilter = {
  kinds: ['step', 'ai', 'memory', 'script', 'log', 'sound', 'operator'],
  subs: { log: ['W', 'E', 'I'] },
  tags: [],
  excludeTags: [],
  query: '',
  windowMs: 30_000,
  step: null,
};

export function applyFilter(events: FeedEvent[], f: FeedFilter, cursor: number | null): FeedEvent[] {
  const kinds = new Set(f.kinds);
  const words = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tags = new Set(f.tags);
  const ex = new Set(f.excludeTags);
  const from = cursor !== null && f.windowMs > 0 ? cursor - f.windowMs : -Infinity;
  const to = cursor !== null && f.windowMs > 0 ? cursor + f.windowMs : Infinity;
  return events.filter((e) => {
    if (!kinds.has(e.kind)) return false;
    if (e.t < from || e.t > to) return false;
    const subs = f.subs[e.kind];
    if (subs && subs.length && !subs.includes(e.sub)) return false;
    if (tags.size && e.tag !== undefined && (e.kind === 'log' || e.kind === 'ai') && !tags.has(e.tag)) return false;
    if (e.tag !== undefined && ex.has(e.tag)) return false;
    if (f.step !== null && e.step !== undefined && e.step !== f.step) return false;
    if (f.step !== null && e.step === undefined && e.kind !== 'log') return false;
    if (words.length) {
      const hay = `${e.title} ${e.detail ?? ''} ${e.tag ?? ''}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** 每個類別 / 類型 / tag 有幾筆(過濾面板顯示數量)。只算時間窗內,不受類型過濾影響。 */
export function feedCounts(events: FeedEvent[], cursor: number | null, windowMs: number) {
  const from = cursor !== null && windowMs > 0 ? cursor - windowMs : -Infinity;
  const to = cursor !== null && windowMs > 0 ? cursor + windowMs : Infinity;
  const kinds: Partial<Record<FeedKind, number>> = {};
  const subs: Record<string, number> = {};
  const tags = new Map<string, number>();
  for (const e of events) {
    if (e.t < from || e.t > to) continue;
    kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    subs[`${e.kind}:${e.sub}`] = (subs[`${e.kind}:${e.sub}`] ?? 0) + 1;
    if (e.tag !== undefined && e.kind === 'log') tags.set(e.tag, (tags.get(e.tag) ?? 0) + 1);
  }
  return { kinds, subs, tags: [...tags.entries()].sort((a, b) => b[1] - a[1]) };
}
