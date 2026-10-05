import { useEffect, useState } from 'react';
import { apiGet } from '../../api/client.ts';

/** runner 的音量時間軸(GET /tasks/{id}/audio-levels)。 */
export interface AudioLevels {
  state: 'on' | 'unavailable' | 'stopped' | 'none';
  dt: number;
  chunks: Array<{ name: string; t: number; dur: number; rms: number[] }>;
}

export const SILENT_DB = -60;

export interface WindowSound {
  /** 這段時間是否有錄音覆蓋(錄音段之間有約 5 秒空檔)。 */
  covered: boolean;
  /** 有錄到的比例 0–1。 */
  coverage: number;
  peakDb?: number;
  /** 下採樣後的音量條(0–1),給小波形圖。 */
  bars: number[];
  /** 偵測到的「突發音效」次數(比前 1 秒中位數高 ≥ 8 dB 的上升沿,如金幣、按鈕音)。 */
  onsets: number;
}

const median = (a: number[]) => {
  if (!a.length) return -120;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};

/** 取 [from, to)(epoch ms)時間窗內的音量摘要。 */
export function soundInWindow(levels: AudioLevels | null | undefined, from: number, to: number, nBars = 20): WindowSound {
  const empty: WindowSound = { covered: false, coverage: 0, bars: [], onsets: 0 };
  if (!levels || !levels.chunks.length || !(to > from)) return empty;
  const dtMs = levels.dt * 1000;
  const samples: Array<{ t: number; v: number }> = [];
  let onsets = 0;
  for (const c of levels.chunks) {
    const end = c.t + c.rms.length * dtMs;
    if (end <= from || c.t >= to) continue;
    for (let i = 0; i < c.rms.length; i++) {
      const t = c.t + i * dtMs;
      if (t < from || t >= to) continue;
      const v = c.rms[i]!;
      samples.push({ t, v });
      // 上升沿:相對前 1 秒(10 筆)中位數高 8 dB 以上,且本身夠大聲;前一筆不算(避免同一聲連續計)。
      if (i >= 3 && v > SILENT_DB + 15) {
        const prev = c.rms.slice(Math.max(0, i - 10), i);
        const base = median(prev);
        const prevV = c.rms[i - 1]!;
        if (v - base >= 8 && !(prevV - median(c.rms.slice(Math.max(0, i - 11), i - 1)) >= 8)) onsets++;
      }
    }
  }
  if (!samples.length) return empty;
  const coverage = Math.min(1, (samples.length * dtMs) / (to - from));
  const peakDb = Math.max(...samples.map((s) => s.v));
  const bars: number[] = [];
  const span = (to - from) / nBars;
  for (let b = 0; b < nBars; b++) {
    const lo = from + b * span;
    const hi = lo + span;
    const vs = samples.filter((s) => s.t >= lo && s.t < hi).map((s) => s.v);
    const m = vs.length ? Math.max(...vs) : -120;
    bars.push(Math.max(0, Math.min(1, (m - SILENT_DB) / -SILENT_DB)));
  }
  return { covered: true, coverage, peakDb: Math.round(peakDb), bars, onsets };
}

/** 輪詢音量時間軸:執行中每 10 秒一次,結束後讀一次。 */
export function useAudioLevels(jobId: string | undefined, isLive: boolean, enabled: boolean) {
  const [levels, setLevels] = useState<AudioLevels | null>(null);
  useEffect(() => {
    if (!jobId || !enabled) return;
    let stop = false;
    const load = () => apiGet<AudioLevels>(`/tasks/${jobId}/audio-levels`).then((r) => { if (!stop) setLevels(r); }).catch(() => {});
    void load();
    if (!isLive) return () => { stop = true; };
    const t = setInterval(() => void load(), 10_000);
    return () => { stop = true; clearInterval(t); };
  }, [jobId, isLive, enabled]);
  return levels;
}
