/**
 * 任務時間軸(像影音剪輯軟體):把錄影、聲音、步驟、AI 呼叫、裝置 log 放到同一條時間軸。
 *
 * 時間一律用 runner 時鐘的 epoch ms:
 * - 步驟 step.at、AI 呼叫 trace.at、錄影 levels.chunks[].t 本來就是 runner 時鐘。
 * - 裝置 logcat 是裝置時鐘;每個 log 片段標頭有 `dev=<裝置秒> sent=<runner ms>`,用來換算(誤差約 0.1~0.3 秒)。
 * 時間軸的 0 = 錄影開始(沒有錄影 = 第一步開始),所以「影片 1:22.001」≈「時間軸 1:22.001」。
 */
import type { AudioLevels } from './audioLevels.ts';
import { alignLogcat, type LogLine } from './logcat.ts';

export { alignLogcat };

export interface TlStep {
  index: number;
  /** 開始(epoch ms)。 */
  t: number;
  /** 結束 = 下一步開始(最後一步 = 開始 + 耗時)。 */
  end: number;
  screen?: string;
  action?: string;
  target?: string;
  /** 誰決定的:agent(決策 Agent)/ vision(視覺 Agent)/ reflex(照記憶直接做)。 */
  decidedBy?: string;
  thinking?: string;
  thumb?: string;
}
export interface TlChunk { name: string; t: number; end: number; url?: string; rms: number[] }
export interface TlTrace { seat: string; index: number; start: number; end: number; ok: boolean; modelId?: string }
export interface Timeline {
  origin: number;
  end: number;
  steps: TlStep[];
  chunks: TlChunk[];
  traces: TlTrace[];
  /** 已對到 runner 時鐘的裝置 log(依時間排序;dev = 原本的裝置時間)。 */
  logs: Array<LogLine & { dev: number }>;
  /** 錄音 RMS 取樣間隔(秒)。 */
  dt: number;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

/** 時間軸上的時間(相對 origin 的 ms)→ 「1:22.001」(超過 1 小時 → 「1:02:03.004」)。 */
export function fmtClock(ms: number): string {
  const neg = ms < 0;
  let v = Math.round(Math.abs(ms));
  const msPart = v % 1000;
  v = Math.floor(v / 1000);
  const s = v % 60;
  const m = Math.floor(v / 60) % 60;
  const h = Math.floor(v / 3600);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const body = h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
  return `${neg ? '-' : ''}${body}.${String(msPart).padStart(3, '0')}`;
}

/** 「1:22.001」「82.5」「0:01:22」「1:22」→ ms;格式不對回 null。 */
export function parseClock(text: string): number | null {
  const s = text.trim().replace(/[,，]/g, '.').replace(/[：]/g, ':');
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(s)) return null;
  const [main, frac = ''] = s.split('.');
  const parts = main!.split(':').map(Number);
  if (parts.slice(1).some((n) => n >= 60)) return null;
  const sec = parts.reduce((acc, n) => acc * 60 + n, 0);
  return sec * 1000 + Number(frac.padEnd(3, '0') || 0);
}

/** 牆上時間(瀏覽器時區)「19:48:17.254」。 */
export function wallClock(epochMs: number): string {
  const d = new Date(epochMs);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * 錄影實際開始時間:runner 用「停止時間 − 音量長度」推估,音量長度以 0.1 秒為單位、
 * 也可能和影片真正長度差約 1 秒。知道影片真正長度後,正常停止的段改用「停止時間 − 影片長度」。
 * 因長度上限自己結束的段(下一段在 35 秒內接上)用的是開始時間,不必修正。
 */
export function alignedChunkStart(c: { t: number; dur: number }, next: { t: number } | undefined, videoSec: number | undefined): number {
  if (!videoSec || !(videoSec > 0)) return c.t;
  const stopAt = c.t + c.dur * 1000;
  const autoEnded = next !== undefined && next.t - stopAt < 35_000;
  return autoEnded ? c.t : Math.round(stopAt - videoSec * 1000);
}

export function buildTimeline({
  steps,
  levels,
  logChunks = [],
  traces = [],
  videoDur = {},
  now,
}: {
  steps: Array<Record<string, unknown> & { index: number }>;
  levels?: AudioLevels | null;
  logChunks?: Array<{ text?: string }>;
  traces?: Array<{ index: number; seat?: string; at?: string; ms?: number; ok?: boolean; modelId?: string }>;
  /** 影片真正長度(秒),依錄影檔名。 */
  videoDur?: Record<string, number>;
  /** 執行中:最後一步延伸到現在。 */
  now?: number;
}): Timeline {
  const raw = (levels?.chunks ?? []).filter((c) => c.dur > 0);
  const chunks: TlChunk[] = raw.map((c, i) => {
    const t = alignedChunkStart(c, raw[i + 1], videoDur[c.name]);
    const dur = videoDur[c.name] ?? c.dur;
    return { name: c.name, t, end: t + dur * 1000, ...(c.url ? { url: c.url } : {}), rms: c.rms };
  });

  const timed = steps
    .map((s) => ({ s, t: typeof s.at === 'string' ? Date.parse(s.at) : NaN }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  const tlSteps: TlStep[] = timed.map(({ s, t }, i) => {
    const next = timed[i + 1];
    const dur = typeof s.durationMs === 'number' && s.durationMs > 0 ? (s.durationMs as number) : 3000;
    const end = next ? next.t : now !== undefined ? Math.max(t + dur, now) : t + dur;
    const thumb = str(s.annotatedUrl) ?? str(s.screenshotUrl);
    return {
      index: s.index,
      t,
      end: Math.max(end, t + 1),
      ...(str(s.screen) && !s.parseFailed ? { screen: str(s.screen)! } : {}),
      ...(str(s.action) ? { action: str(s.action)! } : {}),
      ...(str(s.target) ? { target: str(s.target)! } : {}),
      ...(str(s.decidedBy) ? { decidedBy: str(s.decidedBy)! } : {}),
      ...(str(s.thinking) ? { thinking: str(s.thinking)! } : {}),
      ...(thumb ? { thumb } : {}),
    };
  });

  const tlTraces: TlTrace[] = traces
    .map((tr) => {
      const end = tr.at ? Date.parse(tr.at) : NaN;
      if (!Number.isFinite(end)) return null;
      const ms = typeof tr.ms === 'number' && tr.ms > 0 ? tr.ms : 0;
      return { seat: tr.seat ?? 'vlm', index: tr.index, start: end - ms, end: Math.max(end, end - ms + 1), ok: tr.ok !== false, ...(tr.modelId ? { modelId: tr.modelId } : {}) };
    })
    .filter((x): x is TlTrace => x !== null)
    .sort((a, b) => a.start - b.start);

  const logs = alignLogcat(logChunks);

  const starts = [chunks[0]?.t, tlSteps[0]?.t].filter((v): v is number => typeof v === 'number');
  const origin = starts.length ? Math.min(...starts) : now ?? 0;
  const ends = [chunks[chunks.length - 1]?.end, tlSteps[tlSteps.length - 1]?.end, now].filter((v): v is number => typeof v === 'number');
  const end = Math.max(origin + 1000, ...ends);
  return { origin, end, steps: tlSteps, chunks, traces: tlTraces, logs, dt: levels?.dt ?? 0.1 };
}

/** 最後一個 t <= at 的索引(list 依 t 排序);都在 at 之後回 -1。 */
export function lastAtOrBefore<T>(list: T[], at: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = list.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]!) <= at) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** 這個時間點正在進行的步驟(第一步之前回 null)。 */
export function stepAt(tl: Timeline, at: number): TlStep | null {
  const i = lastAtOrBefore(tl.steps, at, (s) => s.t);
  return i >= 0 ? tl.steps[i]! : null;
}

/** 這個時間點在哪段錄影、影片裡第幾秒;落在錄影空檔回 null。 */
export function chunkAt(tl: Timeline, at: number): { index: number; chunk: TlChunk; sec: number } | null {
  const index = tl.chunks.findIndex((c) => at >= c.t && at <= c.end);
  if (index < 0) return null;
  const chunk = tl.chunks[index]!;
  return { index, chunk, sec: (at - chunk.t) / 1000 };
}

/** 這個時間點的音量(dB;沒有錄音覆蓋回 null)。 */
export function levelAt(tl: Timeline, at: number): number | null {
  const c = chunkAt(tl, at);
  if (!c) return null;
  const i = Math.floor(c.sec / tl.dt);
  const v = c.chunk.rms[i];
  return typeof v === 'number' ? v : null;
}

/** 時間窗 [from, to] 內的裝置 log。 */
export function logsBetween(tl: Timeline, from: number, to: number): LogLine[] {
  const startIdx = lastAtOrBefore(tl.logs, from - 1, (l) => l.t) + 1;
  const out: LogLine[] = [];
  for (let i = startIdx; i < tl.logs.length && tl.logs[i]!.t <= to; i++) out.push(tl.logs[i]!);
  return out;
}

/** 這個時間點正在進行的 AI 呼叫(沒有耗時資料的,用結束前後 0.5 秒)。 */
export function tracesAt(tl: Timeline, at: number): TlTrace[] {
  return tl.traces.filter((tr) => (tr.end - tr.start > 1 ? at >= tr.start && at <= tr.end : Math.abs(at - tr.end) <= 500));
}

/** 時間軸刻度:依可見範圍挑間隔(約 6~12 個主刻度)。 */
export function tickStep(spanMs: number): number {
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];
  return steps.find((s) => spanMs / s <= 12) ?? 3_600_000;
}

/** 一段時間內的 log 密度(每格行數 + 最嚴重等級),畫 log 軌道用。 */
export function logBins(logs: LogLine[], from: number, to: number, n: number): Array<{ count: number; level: 'E' | 'W' | 'I' }> {
  const out = Array.from({ length: n }, () => ({ count: 0, level: 'I' as 'E' | 'W' | 'I' }));
  if (!(to > from) || n <= 0) return out;
  const w = (to - from) / n;
  const startIdx = lastAtOrBefore(logs, from - 1, (l) => l.t) + 1;
  for (let i = startIdx; i < logs.length; i++) {
    const l = logs[i]!;
    if (l.t > to) break;
    const b = out[Math.min(n - 1, Math.floor((l.t - from) / w))]!;
    b.count++;
    if (l.level === 'E' || l.level === 'F' || l.level === 'A') b.level = 'E';
    else if (l.level === 'W' && b.level !== 'E') b.level = 'W';
  }
  return out;
}

/** 可見範圍內的聲音波形(每格取最大 dB;沒有錄音覆蓋的格 = null)。 */
export function waveBins(tl: Timeline, from: number, to: number, n: number): Array<number | null> {
  const out: Array<number | null> = Array.from({ length: n }, () => null);
  if (!(to > from) || n <= 0) return out;
  const w = (to - from) / n;
  const dtMs = tl.dt * 1000;
  for (const c of tl.chunks) {
    if (c.end < from || c.t > to || !c.rms.length) continue;
    const b0 = Math.max(0, Math.floor((c.t - from) / w));
    const b1 = Math.min(n - 1, Math.floor((c.end - from) / w));
    for (let b = b0; b <= b1; b++) {
      const s = Math.max(c.t, from + b * w);
      const e = Math.min(c.end, from + (b + 1) * w);
      const i0 = Math.max(0, Math.floor((s - c.t) / dtMs));
      const i1 = Math.min(c.rms.length - 1, Math.max(i0, Math.ceil((e - c.t) / dtMs) - 1));
      let max = -Infinity;
      for (let i = i0; i <= i1; i++) max = Math.max(max, c.rms[i]!);
      if (Number.isFinite(max)) out[b] = Math.max(out[b] ?? -Infinity, max);
    }
  }
  return out;
}

/** 前一步 / 下一步的開始時間(跳步用)。 */
export function adjacentStep(tl: Timeline, at: number, dir: -1 | 1): TlStep | null {
  if (dir > 0) return tl.steps.find((s) => s.t > at + 1) ?? null;
  const i = lastAtOrBefore(tl.steps, at - 1, (s) => s.t);
  const cur = i >= 0 ? tl.steps[i]! : null;
  // 在這一步中間按「上一步」= 回到這一步開頭;剛好在開頭 = 再往前一步。
  if (cur && at - cur.t > 300) return cur;
  return i - 1 >= 0 ? tl.steps[i - 1]! : cur;
}
