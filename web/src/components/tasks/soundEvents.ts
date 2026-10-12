/**
 * 音效事件時間軸:把三種來源合成「每個時間點發生了什麼聲音」。
 *
 *  1. game   — 遊戲自己的 log 提到播放音效(Unity AudioSource.Play / PlaySound / [SFX] xxx / 音檔名)。
 *  2. fail   — 遊戲 log 說音效沒播出來(例:Unity "Can not play a disabled audio source")。
 *  3. stream — 系統聲音串流開始 / 停止(AAudio / AudioTrack / MediaPlayer / SoundPool)。
 *  4. onset  — 測試錄影的聲音裡偵測到的突發音效(音量突然升高),任何遊戲引擎都適用。
 *
 * 2026-10-12 真機實測(Unity 老虎機,Galaxy S23 Ultra):遊戲所有音效混成同一條 AAudio 串流,
 * Android 系統層看不到個別音效;個別音效的「時間」要靠錄影聲音偵測,「名稱」要靠遊戲自己的 log。
 * 所以每筆遊戲音效呼叫會再對照錄影:呼叫後 1 秒內有沒有真的聽到聲音(heard)。
 */
import type { AudioLevels } from './audioLevels.ts';

export type SoundKind = 'game' | 'fail' | 'stream' | 'onset';

export interface SoundEvent {
  kind: SoundKind;
  /** epoch ms(已對到 runner 時鐘,與步驟 / 錄影同一時間軸)。 */
  t: number;
  title: string;
  /** 遊戲 log 的完整內容(Unity 會附呼叫堆疊)。 */
  detail?: string;
  /** 音量峰值 dB(onset)。 */
  peakDb?: number;
  durMs?: number;
  /** 遊戲音效呼叫之後錄影裡有沒有聽到聲音;undefined = 那段時間沒有錄影可對照。 */
  heard?: boolean;
  step?: number;
  screen?: string;
}

export interface StepRef { index: number; t: number; screen?: string }

const LINE_RE = /^\s*(\d{9,}\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s?(.*)$/;

const FAIL_RE = /can ?not play|cannot play|failed to (load|play|open)|could not (load|play)|audioclip.*(null|missing|not found)|audio.*(error|exception)|fmod.*(error|fail)|sound.*(missing|not found|error)/i;
const GAME_RE = /playsound|playoneshot|audiosource[.:]play|playclip|play(sfx|effect|music|bgm)\b|\[(sfx|sound|audio|bgm)\]|audioclip|\.(ogg|wav|mp3|m4a|aac)\b/i;
const STREAM_TAG_RE = /^(AAudio|AudioTrack|MediaPlayer|MediaPlayerNative|SoundPool|OpenSLES|libOpenSLES|AudioStreamLegacy)$/;
const STREAM_MSG_RE = /requestStart\(|requestStop\(|requestPause\(|\bstart\(|\bstop\(|\bpause\(|\bplay\(/;

/** 從遊戲 log 抓音效名稱(檔名 / [SFX] 名稱 / clip=xxx);抓不到回 undefined。 */
export function clipName(text: string): string | undefined {
  return /\[(?:sfx|sound|audio|bgm)\]\s*[:=]?\s*["']?([\w.\-/]+)/i.exec(text)?.[1]
    ?? /\bclip(?:name)?\s*[:=]\s*["']?([\w.\-/]+)/i.exec(text)?.[1]
    ?? /([\w\-]+\.(?:ogg|wav|mp3|m4a|aac))\b/i.exec(text)?.[1];
}

/** 呼叫堆疊裡最有意義的一行(例:AudioCtrlManager:PlaySound(...) ← DragonUIPlaySound:OnClick())。 */
function callSummary(lines: string[]): string | undefined {
  const play = lines.find((l) => /PlaySound|PlayOneShot|AudioSource:Play|PlayClip/i.test(l) && !/^UnityEngine\./.test(l.trim()));
  const userCode = (l: string) => !/^UnityEngine\./.test(l.trim()) && l !== play;
  const caller = lines.find((l) => /:On\w+\(/.test(l) && userCode(l)) ?? lines.find((l) => /:Play\(\)/.test(l) && userCode(l));
  const clean = (s: string) => s.trim().replace(/\(.*\)$/, '()');
  if (play && caller) return `${clean(play)} ← ${clean(caller)}`;
  return play ? clean(play) : undefined;
}

interface Group { t: number; pid: number; tid: number; level: string; tag: string; lines: string[] }

/**
 * logcat 片段(含 `# step= at= pid= dev= sent=` 標頭)→ 音效事件。
 * dev/sent 讓裝置時鐘對到 runner 時鐘(錄影、步驟都用 runner 時鐘)。
 */
export function eventsFromLogcat(chunks: Array<{ text?: string }>): SoundEvent[] {
  const out: SoundEvent[] = [];
  const appPids = new Set<number>();
  let offset = 0;
  const groups: Group[] = [];
  for (const c of chunks) {
    for (const raw of (c.text ?? '').split('\n')) {
      if (raw.startsWith('#')) {
        const pid = /pid=(\d+)/.exec(raw)?.[1];
        if (pid) appPids.add(Number(pid));
        const dev = Number(/dev=(\d{9,}\.\d+)/.exec(raw)?.[1]);
        const sent = Number(/sent=(\d+)/.exec(raw)?.[1]);
        if (Number.isFinite(dev) && Number.isFinite(sent) && dev > 0 && sent > 0) offset = sent - Math.round(dev * 1000);
        continue;
      }
      const m = LINE_RE.exec(raw);
      if (!m) continue;
      const t = Math.round(Number(m[1]) * 1000) + offset;
      const pid = Number(m[2]);
      const tid = Number(m[3]);
      const level = m[4]!;
      const tag = m[5]!;
      const msg = m[6]!;
      // Unity 一則訊息會拆成多行(同時間、同執行緒、同 tag):併成一組。
      const last = groups[groups.length - 1];
      if (last && last.pid === pid && last.tid === tid && last.tag === tag && last.level === level && Math.abs(last.t - t) <= 2) last.lines.push(msg);
      else groups.push({ t, pid, tid, level, tag, lines: [msg] });
    }
  }
  const isApp = (pid: number) => appPids.size === 0 || appPids.has(pid);
  for (const g of groups) {
    if (!isApp(g.pid)) continue;
    const text = g.lines.join('\n');
    if (STREAM_TAG_RE.test(g.tag)) {
      const first = g.lines[0] ?? '';
      if (!STREAM_MSG_RE.test(first) || /returned/.test(first)) continue;
      const action = /stop|pause/i.test(first) ? 'stop' : 'start';
      // AAudio 底層就是 AudioTrack:同一個開始/停止兩邊各記一次,50ms 內同動作只留一筆。
      if (out.some((e) => e.kind === 'stream' && e.title.endsWith(action) && Math.abs(e.t - g.t) <= 50)) continue;
      out.push({ kind: 'stream', t: g.t, title: `${g.tag} ${action}`, detail: first });
      continue;
    }
    if (FAIL_RE.test(text) && (GAME_RE.test(text) || /audio|sound|clip/i.test(text))) {
      const name = clipName(text);
      const call = callSummary(g.lines);
      out.push({ kind: 'fail', t: g.t, title: `${g.lines[0]!.trim()}${name ? ` · ${name}` : ''}`, detail: call ? `${call}\n\n${text}` : text });
      continue;
    }
    if (GAME_RE.test(text)) {
      const name = clipName(text);
      const call = callSummary(g.lines);
      out.push({ kind: 'game', t: g.t, title: name ?? call ?? g.lines[0]!.trim().slice(0, 140), detail: text });
    }
  }
  return out;
}

const median = (a: number[]) => {
  if (!a.length) return -120;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};

/** 錄影聲音 → 突發音效(比前 1 秒中位數高 ≥ 6 dB 的上升沿),含峰值與持續時間。 */
export function onsetsFromLevels(levels: AudioLevels | null | undefined): SoundEvent[] {
  if (!levels?.chunks.length) return [];
  const dtMs = levels.dt * 1000;
  const out: SoundEvent[] = [];
  for (const c of levels.chunks) {
    const r = c.rms;
    for (let i = 3; i < r.length; i++) {
      const v = r[i]!;
      if (v < -45) continue;
      const base = median(r.slice(Math.max(0, i - 10), i));
      if (v - base < 6) continue;
      const prevBase = median(r.slice(Math.max(0, i - 11), i - 1));
      if (r[i - 1]! - prevBase >= 6) continue; // 同一聲的延續
      let j = i;
      let peak = v;
      while (j + 1 < r.length && r[j + 1]! >= base + 3 && j - i < 80) { j++; peak = Math.max(peak, r[j]!); }
      out.push({ kind: 'onset', t: Math.round(c.t + i * dtMs), title: '', peakDb: Math.round(peak), durMs: Math.round((j - i + 1) * dtMs) });
      i = j;
    }
  }
  return out;
}

/** 這個時間點有沒有錄影覆蓋。 */
function covered(levels: AudioLevels | null | undefined, t: number): boolean {
  return !!levels?.chunks.some((c) => t >= c.t && t <= c.t + c.dur * 1000);
}

/** 合併、對照錄影、標上步驟;新 → 舊。 */
export function buildSoundEvents({ logChunks, levels, steps }: {
  logChunks: Array<{ text?: string }>;
  levels?: AudioLevels | null;
  steps?: StepRef[];
}): SoundEvent[] {
  const onsets = onsetsFromLevels(levels);
  const all = [...eventsFromLogcat(logChunks), ...onsets];
  // 只對「遊戲說有播」的事件對照錄影;「沒播出」附近若剛好有別的聲音,標成有聽到會誤導。
  for (const e of all) {
    if (e.kind === 'game' && covered(levels, e.t)) {
      e.heard = onsets.some((o) => o.t >= e.t - 300 && o.t <= e.t + 1000);
    }
  }
  const sortedSteps = [...(steps ?? [])].sort((a, b) => a.t - b.t);
  for (const e of all) {
    let s: StepRef | undefined;
    for (const x of sortedSteps) { if (x.t <= e.t) s = x; else break; }
    if (s) { e.step = s.index; if (s.screen) e.screen = s.screen; }
  }
  return all.sort((a, b) => b.t - a.t);
}
