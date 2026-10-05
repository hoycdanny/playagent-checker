import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../../api/client.ts';

/**
 * 即時畫面播放器:依序播放 runner 上傳的短影片段落(雙 <video> 輪替,下一段先預載,
 * 播完無縫換上),沒有段落時回退顯示截圖幀。
 *
 * source='live'  → screenrecord 2 秒段(無聲,延遲約 3–5 秒,30+ fps)
 * source='audio' → MediaProjection 段(含遊戲音效,延遲較長)
 */
interface Segment { name: string; t: number; url: string }

export interface LivePlayerState {
  /** 正在播放影片段落(false = 顯示截圖幀)。 */
  playing: boolean;
  /** 目前畫面落後實際裝置的估計秒數。 */
  delaySec?: number;
}

export function LivePlayer({
  jobId,
  isLive,
  source = 'live',
  muted = true,
  volume = 1,
  fallbackUrl,
  alt,
  className,
  onState,
}: {
  jobId: string;
  isLive: boolean;
  source?: 'live' | 'audio';
  muted?: boolean;
  volume?: number;
  fallbackUrl?: string | null;
  alt: string;
  className?: string;
  onState?: (s: LivePlayerState) => void;
}) {
  const vids = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const [front, setFront] = useState(0); // 目前顯示中的 <video>
  const [playing, setPlaying] = useState(false);
  const queue = useRef<Segment[]>([]);
  const cursor = useRef<string | undefined>(undefined);
  const backReady = useRef(false); // 背面 video 是否已預載好下一段
  const frontRef = useRef(0);
  const lastSegT = useRef<number | undefined>(undefined);
  const lastArrival = useRef(0);
  const stateCb = useRef(onState);
  stateCb.current = onState;

  // 換來源時重置。
  useEffect(() => {
    queue.current = [];
    cursor.current = undefined;
    backReady.current = false;
    lastArrival.current = 0;
    setPlaying(false);
    for (const r of vids) {
      const v = r.current;
      if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, source]);

  // 音量 / 靜音套到兩個 video。
  useEffect(() => {
    for (const r of vids) {
      const v = r.current;
      if (!v) continue;
      v.muted = muted || source === 'live';
      v.volume = Math.min(1, Math.max(0, volume));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted, volume, source, front]);

  // 輪詢新段落。
  useEffect(() => {
    if (!isLive) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const q = cursor.current ? `?after=${encodeURIComponent(cursor.current)}` : '';
        const r = await apiGet<{ items: Segment[]; cursor?: string }>(`/tasks/${jobId}/live-${source === 'audio' ? 'audio' : 'video'}${q}`);
        if (stop) return;
        if (r.cursor) cursor.current = r.cursor;
        if (r.items.length) {
          lastArrival.current = Date.now();
          queue.current.push(...r.items);
          // 積壓太多 → 只留最新兩段(即時優先,不補播)。
          if (source === 'live' && queue.current.length > 3) queue.current = queue.current.slice(-2);
          pump();
        }
      } catch { /* 暫時失敗:下次再試 */ }
      if (!stop) timer = setTimeout(() => void poll(), source === 'audio' ? 3000 : 1500);
    };
    void poll();
    return () => { stop = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, isLive, source]);

  // 段落太久沒來(runner 停了 / 回退截圖)→ 改顯示截圖幀。
  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => {
      const stale = Date.now() - lastArrival.current > (source === 'audio' ? 90_000 : 12_000);
      if (stale && playing && queue.current.length === 0) {
        const v = vids[frontRef.current]!.current;
        if (!v || v.ended || v.paused) setPlaying(false);
      }
    }, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, playing, source]);

  /** 把下一段塞進背面 video 預載;前面沒在播就直接換上。 */
  function pump() {
    const backIdx = 1 - frontRef.current;
    const back = vids[backIdx]!.current;
    const cur = vids[frontRef.current]!.current;
    if (!back || !cur) return;
    const frontIdle = !cur.src || cur.ended || (cur.paused && cur.readyState < 2);
    if (!backReady.current && queue.current.length) {
      const seg = queue.current.shift()!;
      backReady.current = true;
      back.src = seg.url;
      back.dataset['t'] = String(seg.t);
      back.load();
    }
    if (frontIdle && backReady.current) swap();
  }

  function swap() {
    const backIdx = 1 - frontRef.current;
    const back = vids[backIdx]!.current;
    if (!back) return;
    backReady.current = false;
    frontRef.current = backIdx;
    setFront(backIdx);
    setPlaying(true);
    // 有積壓時稍微加速追上。
    back.playbackRate = queue.current.length >= 2 ? 1.25 : 1;
    const t = Number(back.dataset['t']);
    if (Number.isFinite(t)) lastSegT.current = t;
    back.play().catch(() => { /* 自動播放被擋(含聲音時):保持靜音重試 */ back.muted = true; void back.play().catch(() => {}); });
    stateCb.current?.({ playing: true, delaySec: Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 1000) : undefined });
    pump();
  }

  function onEnded(idx: number) {
    if (idx !== frontRef.current) return;
    if (backReady.current) swap();
    else pump();
  }

  useEffect(() => { if (!playing) stateCb.current?.({ playing: false }); }, [playing]);

  return (
    <div className={`liveplayer ${className ?? ''}`}>
      {vids.map((r, i) => (
        <video
          key={i}
          ref={r}
          className={`liveplayer__video ${playing && front === i ? 'is-front' : ''}`}
          playsInline
          muted
          preload="auto"
          onEnded={() => onEnded(i)}
          onCanPlay={() => { if (i !== frontRef.current) pump(); }}
          onError={() => { if (i !== frontRef.current) { backReady.current = false; pump(); } }}
          aria-hidden={!(playing && front === i)}
        />
      ))}
      {!playing && fallbackUrl && <img className="liveplayer__img" src={fallbackUrl} alt={alt} />}
      {playing && <span className="visually-hidden">{alt}</span>}
    </div>
  );
}
