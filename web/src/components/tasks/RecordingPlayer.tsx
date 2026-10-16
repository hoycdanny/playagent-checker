import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { RLang } from '../report/reportText.ts';
import { downsampleBars, type AudioLevels } from './audioLevels.ts';
import { InfoIcon } from './InfoIcon.tsx';
import { contentCrop } from './orientation.ts';
import './RecordingPlayer.css';

const T = {
  title: ['測試錄影(含聲音)', 'Test recording (with sound)'],
  mute: ['靜音', 'Mute'],
  unmute: ['開啟聲音', 'Unmute'],
  full: ['全螢幕', 'Full screen'],
  exitFull: ['離開全螢幕', 'Exit full screen'],
  playHint: ['點畫面播放 / 暫停', 'Click to play / pause'],
  part: ['第 {n} 段', 'Part {n}'],
  wave: ['聲音波形:點一下跳到該時間', 'Sound waveform: click to jump to that time'],
  step: ['第 {n} 步', 'Step {n}'],
  noSound: ['這段錄影沒有偵測到聲音', 'No sound detected in this recording'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];

type Chunk = AudioLevels['chunks'][number] & { url: string };
export interface StepMark { index: number; t: number }
/**
 * 外層要求跳到某個時間點(epoch ms);n 遞增讓同一時間也能重複觸發。
 * play = false:只移到那一格不播放(拖時間軸時用);預設跳過去就播放。
 */
export interface SeekRequest { t: number; n: number; play?: boolean }
/** 外層控制播放 / 暫停(時間軸上的播放鍵);n 遞增觸發。 */
export interface PlayControl { action: 'toggle' | 'play' | 'pause'; n: number }

const BARS = 240;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtMs = (s: number) => `${fmt(s)}.${String(Math.floor((s % 1) * 1000)).padStart(3, '0')}`;

/**
 * 整場測試錄影回放:影片(含聲音)+ 下方聲音波形。
 * 波形上標出每一步的位置;點波形或外層「回放這一步」都會跳到對應時間。
 */
export function RecordingPlayer({
  levels,
  steps,
  lang,
  seek,
  onStep,
  starts,
  onTime,
  onDuration,
  control,
  onPlayingChange,
  bare = false,
  aspect = null,
}: {
  levels: AudioLevels;
  steps: StepMark[];
  lang: RLang;
  seek?: SeekRequest | null;
  /** 播放到的步驟(高亮執行軌跡用)。 */
  onStep?: (index: number | null) => void;
  /** 各段錄影校正後的開始時間(epoch ms,依檔名);沒給用 levels 的推估值。 */
  starts?: Record<string, number>;
  /** 播放 / 跳轉到的時間點(epoch ms,約每 0.1 秒一次)—— 時間軸游標跟著走。 */
  onTime?: (t: number) => void;
  /** 影片真正長度(秒)載入後回報(用來校正錄影開始時間)。 */
  onDuration?: (name: string, sec: number) => void;
  control?: PlayControl | null;
  onPlayingChange?: (playing: boolean) => void;
  /** 只顯示影片(標題、波形、時間交給下方的任務時間軸)。 */
  bare?: boolean;
  /**
   * bare 模式:目前 App 畫面的寬 / 高比。錄影是固定大小,App 轉向後畫面會縮在中間加黑邊;
   * 給了這個比例就把 App 畫面放大填滿、裁掉黑邊。
   */
  aspect?: number | null;
}) {
  const chunks = useMemo(() => levels.chunks.filter((c): c is Chunk => typeof c.url === 'string' && c.dur > 0), [levels.chunks]);
  const [part, setPart] = useState(0);
  const [time, setTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [muted, setMuted] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [paused, setPaused] = useState(true);
  const pendingSeek = useRef<number | null>(null);
  const pendingPlay = useRef(false);
  const chunk = chunks[Math.min(part, chunks.length - 1)];
  const startOf = (c: Chunk) => starts?.[c.name] ?? c.t;
  const t0 = chunk ? startOf(chunk) : 0;

  const bars = useMemo(() => (chunk ? downsampleBars(chunk.rms, BARS) : []), [chunk]);
  const silent = bars.length > 0 && bars.every((b) => b === 0);
  const dur = chunk?.dur ?? 0;
  const marks = useMemo(
    () => (chunk ? steps.filter((s) => s.t >= t0 && s.t <= t0 + dur * 1000).map((s) => ({ ...s, x: (s.t - t0) / 1000 / dur })) : []),
    [steps, chunk, dur, t0],
  );

  // 播放位置 → 目前步驟。
  const [curStep, setCurStep] = useState<number | null>(null);
  const prevStep = useRef<number | null>(null);
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;
  useEffect(() => {
    if (!chunk) return;
    const at = t0 + time * 1000;
    let cur: number | null = null;
    for (const s of steps) if (s.t <= at) cur = s.index;
    if (cur !== prevStep.current) {
      prevStep.current = cur;
      setCurStep(cur);
      onStepRef.current?.(cur);
    }
  }, [time, chunk, steps, t0]);

  // 播放位置回報給時間軸(每 0.1 秒最多一次,避免整頁每格重畫)。外層跳轉造成的 seeked 也回報。
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;
  const t0Ref = useRef(t0);
  t0Ref.current = t0;
  const lastReport = useRef(0);
  const report = (sec: number, force = false) => {
    const now = performance.now();
    if (!force && now - lastReport.current < 100) return;
    lastReport.current = now;
    onTimeRef.current?.(t0Ref.current + sec * 1000);
  };

  // 播放中用 requestAnimationFrame 更新播放頭(timeupdate 每 250ms 一次,太跳)。
  const playingRef = useRef(onPlayingChange);
  playingRef.current = onPlayingChange;
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const loop = () => { setTime(v.currentTime); report(v.currentTime); raf = requestAnimationFrame(loop); };
    const onPlay = () => { raf = requestAnimationFrame(loop); setPaused(false); playingRef.current?.(true); };
    const onPause = () => { cancelAnimationFrame(raf); setTime(v.currentTime); setPaused(true); playingRef.current?.(false); };
    const onSeeked = () => { setTime(v.currentTime); report(v.currentTime, true); };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onPause);
    v.addEventListener('seeked', onSeeked);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onPause);
      v.removeEventListener('seeked', onSeeked);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunk?.url]);

  function seekToSec(sec: number) {
    const v = videoRef.current;
    if (!v) return;
    const s = Math.max(0, Math.min(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : dur, sec));
    if (v.readyState >= 1) v.currentTime = s;
    else pendingSeek.current = s;
    setTime(s);
  }

  // 外層要求跳到某時間:找對應的段,切段後再跳(落在兩段之間的空檔 → 跳到下一段開頭)。
  useEffect(() => {
    if (!seek || chunks.length === 0) return;
    let idx = chunks.findIndex((c) => seek.t >= startOf(c) && seek.t <= startOf(c) + c.dur * 1000);
    if (idx < 0) idx = chunks.findIndex((c) => startOf(c) > seek.t);
    if (idx < 0) idx = chunks.length - 1;
    const sec = Math.max(0, (seek.t - startOf(chunks[idx]!)) / 1000);
    const play = seek.play !== false;
    if (idx !== part) {
      pendingSeek.current = sec;
      pendingPlay.current = play;
      setPart(idx);
      return;
    }
    seekToSec(sec);
    if (play) void videoRef.current?.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seek?.n]);

  // 外層的播放 / 暫停鍵。
  useEffect(() => {
    const v = videoRef.current;
    if (!control || !v) return;
    const play = control.action === 'play' || (control.action === 'toggle' && v.paused);
    if (play) void v.play().catch(() => {});
    else v.pause();
  }, [control?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = () => setIsFull(document.fullscreenElement === stageRef.current && !!stageRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFull = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  };
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  // bare:框 = App 畫面比例(CSS container 單位算出最大尺寸),影片按比例放大、置中,黑邊裁掉。
  const fit = bare ? contentCrop(natural, aspect ?? null) : null;

  function onWaveClick(e: MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    seekToSec(((e.clientX - r.left) / r.width) * dur);
  }
  function onWaveKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowRight') { e.preventDefault(); seekToSec(time + 5); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekToSec(time - 5); }
    else if (e.key === 'Home') { e.preventDefault(); seekToSec(0); }
    else if (e.key === 'End') { e.preventDefault(); seekToSec(dur); }
  }

  if (!chunk) return null;
  const pos = dur > 0 ? Math.min(1, time / dur) : 0;
  const w = 1000;
  const bw = w / BARS;
  return (
    <div className={`recplayer${bare ? ' recplayer--bare' : ''}`}>
      {(!bare || chunks.length > 1) && <div className="recplayer__head">
        {!bare && <strong>{tx('title', lang)}</strong>}
        {chunks.length > 1 && (
          <span className="recplayer__parts" role="group" aria-label={tx('title', lang)}>
            {chunks.map((c, i) => (
              <button key={c.name} type="button" className={i === part ? 'is-on' : ''} aria-pressed={i === part} onClick={() => { setPart(i); setTime(0); }}>
                {tx('part', lang).replace('{n}', String(i + 1))}
              </button>
            ))}
          </span>
        )}
      </div>}
      {(() => {
        const video = (
      <video
        key={chunk.url}
        ref={videoRef}
        className="recplayer__video"
        src={chunk.url}
        controls={!bare}
        muted={bare ? muted : undefined}
        playsInline
        preload="metadata"
        {...(fit ? { style: { width: `${fit.wPct}%`, height: `${fit.hPct}%` } } : {})}
        {...(bare ? { onClick: togglePlay, title: tx('playHint', lang) } : {})}
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (!v) return;
          if (v.videoWidth > 0 && v.videoHeight > 0) setNatural({ w: v.videoWidth, h: v.videoHeight });
          if (Number.isFinite(v.duration) && v.duration > 0) onDuration?.(chunk.name, v.duration);
          if (pendingSeek.current !== null) {
            v.currentTime = pendingSeek.current;
            pendingSeek.current = null;
          }
          if (pendingPlay.current) {
            pendingPlay.current = false;
            void v.play().catch(() => {});
          }
        }}
      />
        );
        if (!bare) return video;
        // bare:影片放在裁切框裡(App 畫面填滿、黑邊裁掉),右上角聲音 / 全螢幕,點畫面播放 / 暫停。
        return (
          <div ref={stageRef} className={`recplayer__stage${fit ? ' is-fit' : ''}`}>
            <div
              className="recplayer__frame"
              {...(fit ? { style: { aspectRatio: String(fit.aspect), width: `min(100cqw, calc(100cqh * ${fit.aspect.toFixed(5)}))`, height: 'auto' } } : {})}
            >
              {video}
            </div>
            {paused && (
              <button type="button" className="recplayer__bigplay" onClick={togglePlay} aria-label={tx('playHint', lang)}>
                <InfoIcon name="playFill" size={26} />
              </button>
            )}
            <div className="recplayer__tools">
              <button type="button" onClick={() => setMuted((m) => !m)} title={muted ? tx('unmute', lang) : tx('mute', lang)} aria-label={muted ? tx('unmute', lang) : tx('mute', lang)} aria-pressed={muted}>
                <InfoIcon name={muted ? 'mute' : 'volume'} size={15} />
              </button>
              <button type="button" onClick={toggleFull} title={isFull ? tx('exitFull', lang) : tx('full', lang)} aria-label={isFull ? tx('exitFull', lang) : tx('full', lang)}>
                <InfoIcon name={isFull ? 'min' : 'max'} size={15} />
              </button>
            </div>
          </div>
        );
      })()}
      {!bare && <div
        className="recplayer__wave"
        role="slider"
        tabIndex={0}
        aria-label={tx('wave', lang)}
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={`${fmt(time)} / ${fmt(dur)}`}
        title={tx('wave', lang)}
        onClick={onWaveClick}
        onKeyDown={onWaveKey}
      >
        <svg viewBox={`0 0 ${w} 40`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {bars.map((b, i) => {
            const h = Math.max(1.5, b * 38);
            return <rect key={i} className={i / BARS < pos ? 'is-played' : ''} x={i * bw + 0.5} y={20 - h / 2} width={Math.max(1, bw - 1.5)} height={h} rx={1} />;
          })}
          {marks.map((m) => (
            <line key={m.index} className="recplayer__mark" x1={m.x * w} x2={m.x * w} y1={0} y2={40} />
          ))}
          <line className="recplayer__head-line" x1={pos * w} x2={pos * w} y1={0} y2={40} />
        </svg>
      </div>}
      {!bare && <div className="recplayer__foot">
        <span className="recplayer__time">{fmtMs(time)} / {fmt(dur)}</span>
        {curStep !== null && <span className="recplayer__step">{tx('step', lang).replace('{n}', String(curStep))}</span>}
        {silent && <span className="recplayer__muted">{tx('noSound', lang)}</span>}
      </div>}
    </div>
  );
}
