import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { RLang } from '../report/reportText.ts';
import { SILENT_DB } from './audioLevels.ts';
import {
  adjacentStep,
  chunkAt,
  fmtClock,
  levelAt,
  logBins,
  logsBetween,
  parseClock,
  stepAt,
  tickStep,
  tracesAt,
  wallClock,
  waveBins,
  type Timeline,
} from './timeline.ts';
import './TaskTimeline.css';

/**
 * 任務時間軸(像影音剪輯軟體):一條共用的播放頭,拖到哪裡,錄影、步驟、AI 呼叫、聲音、裝置 log 都跳到那一刻。
 * - 點 / 拖軌道任一處 = 移動播放頭(不播放);播放鍵 = 播放錄影,播放頭跟著走。
 * - 鍵盤:← → 0.1 秒、Shift 1 秒、Alt 0.01 秒;PageUp / PageDown 上一步 / 下一步;空白鍵播放 / 暫停。
 * - 輸入「1:22.001」按 Enter 直接跳到那個時間(時間 0 = 錄影開始;沒有錄影 = 第一步開始)。
 * - Ctrl + 滾輪 / 「＋ −」縮放,縮放後可用下方捲軸或水平滾動平移。
 */

const T = {
  title: ['時間軸', 'Timeline'],
  laneVideo: ['錄影', 'Video'],
  laneSound: ['聲音', 'Sound'],
  laneSteps: ['步驟', 'Steps'],
  laneAi: ['AI 呼叫', 'AI calls'],
  laneLog: ['裝置 Log', 'Device log'],
  noVideo: ['這次測試沒有錄影(只有每一步的截圖)', 'No recording for this run (step screenshots only)'],
  gap: ['錄影空檔', 'Recording gap'],
  jump: ['跳到', 'Go to'],
  jumpPh: ['1:22.001', '1:22.001'],
  jumpBad: ['格式:分:秒.毫秒,例如 1:22.001', 'Format: m:ss.mmm, e.g. 1:22.001'],
  play: ['播放', 'Play'],
  pause: ['暫停', 'Pause'],
  prevStep: ['上一步', 'Previous step'],
  nextStep: ['下一步', 'Next step'],
  back: ['往回 0.1 秒', 'Back 0.1 s'],
  fwd: ['往前 0.1 秒', 'Forward 0.1 s'],
  zoomIn: ['放大', 'Zoom in'],
  zoomOut: ['縮小', 'Zoom out'],
  fit: ['整段', 'Fit'],
  pan: ['平移時間軸', 'Pan timeline'],
  slider: ['時間軸播放頭', 'Timeline playhead'],
  keys: ['← → 0.1 秒 · Shift 1 秒 · Alt 0.01 秒 · PgUp/PgDn 換步 · 空白鍵播放 · Ctrl+滾輪縮放', '← → 0.1 s · Shift 1 s · Alt 0.01 s · PgUp/PgDn step · Space play · Ctrl+wheel zoom'],
  wall: ['當地時間', 'Local time'],
  nowStep: ['步驟', 'Step'],
  nowAi: ['AI', 'AI'],
  nowSound: ['聲音', 'Sound'],
  nowLog: ['Log ±1 秒', 'Log ±1 s'],
  beforeFirst: ['第一步之前', 'Before the first step'],
  noAi: ['沒有進行中的 AI 呼叫', 'No AI call in progress'],
  silent: ['靜音', 'Silent'],
  noRec: ['沒有錄音', 'No recording'],
  logNone: ['沒有 log', 'No log lines'],
  logCount: ['{n} 行 · 錯誤 {e} · 警告 {w}', '{n} lines · {e} errors · {w} warnings'],
  byAgent: ['AI 決策', 'AI decision'],
  byReflex: ['照記憶', 'From memory'],
  byVision: ['視覺 Agent', 'Vision agent'],
  seat_vlm: ['視覺', 'Vision'],
  seat_agent: ['決策', 'Decision'],
  seat_subagent: ['輔助', 'Helper'],
  failed: ['失敗', 'failed'],
  precision: ['裝置 log 已換算成同一個時鐘,誤差約 0.1~0.3 秒;錄影開始時間以影片長度校正。', 'Device log is converted to the same clock (±0.1–0.3 s); recording start is corrected by the video length.'],
} as const;
const tx = (k: keyof typeof T, lang: RLang, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce<string>((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), T[k][lang === 'zh' ? 0 : 1]);

const BINS = 360;
const MIN_SPAN = 200;
const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const byText = (by: string | undefined, lang: RLang) =>
  by === 'reflex' ? tx('byReflex', lang) : by === 'vision' ? tx('byVision', lang) : by === 'agent' ? tx('byAgent', lang) : '';
const seatText = (seat: string, lang: RLang) =>
  seat === 'agent' ? tx('seat_agent', lang) : seat === 'subagent' ? tx('seat_subagent', lang) : tx('seat_vlm', lang);

export function TaskTimeline({
  tl,
  cursor,
  onSeek,
  lang,
  hasVideo,
  playing,
  onTogglePlay,
  follow,
  onLive,
  liveLabel,
}: {
  tl: Timeline;
  /** 播放頭(epoch ms);null = 還沒選。 */
  cursor: number | null;
  /** 使用者移動播放頭(play = 從那裡開始播)。 */
  onSeek: (t: number, play?: boolean) => void;
  lang: RLang;
  hasVideo: boolean;
  playing: boolean;
  onTogglePlay: () => void;
  /** 執行中:可見範圍跟著最新時間。 */
  follow?: boolean;
  /** 執行中選了時間後:「回到即時」。 */
  onLive?: () => void;
  liveLabel?: string;
}) {
  const total = Math.max(1000, tl.end - tl.origin);
  const [view, setView] = useState<{ from: number; to: number } | null>(null);
  const v = view ?? { from: tl.origin, to: tl.end };
  const span = Math.max(MIN_SPAN, v.to - v.from);
  const at = cursor ?? tl.origin;
  const lanesRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [jump, setJump] = useState('');
  const [jumpErr, setJumpErr] = useState(false);

  // 整段模式下,資料變長(執行中)就跟著變;縮放中只在播放頭跑出畫面時平移。
  useEffect(() => {
    if (!view) return;
    if (follow && cursor === null) return;
    if (at < view.from || at > view.to) {
      const w = view.to - view.from;
      const from = clampN(at - w * 0.1, tl.origin, Math.max(tl.origin, tl.end - w));
      setView({ from, to: from + w });
    }
  }, [at, view, tl.origin, tl.end, follow, cursor]);

  const x = (t: number) => ((t - v.from) / span) * 100;
  const tAtClient = (clientX: number) => {
    const r = lanesRef.current!.getBoundingClientRect();
    return clampN(v.from + ((clientX - r.left) / r.width) * span, tl.origin, tl.end);
  };

  const zoomAround = (center: number, factor: number) => {
    const w = clampN(span * factor, MIN_SPAN, total);
    if (w >= total - 1) { setView(null); return; }
    const ratio = (center - v.from) / span;
    const from = clampN(center - w * ratio, tl.origin, tl.end - w);
    setView({ from, to: from + w });
  };

  // Ctrl / ⌘ + 滾輪縮放(需要 non-passive 才能擋掉瀏覽器縮放);水平滾動 = 平移。
  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAround(tAtClient(e.clientX), e.deltaY > 0 ? 1.25 : 0.8);
      } else if (view && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const w = view.to - view.from;
        const from = clampN(view.from + (e.deltaX / el.clientWidth) * w, tl.origin, tl.end - w);
        setView({ from, to: from + w });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  function down(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    onSeek(tAtClient(e.clientX), false);
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    if (dragging.current) onSeek(tAtClient(e.clientX), false);
  }
  function up() { dragging.current = false; }

  function key(e: KeyboardEvent<HTMLDivElement>) {
    const stepMs = e.altKey ? 10 : e.shiftKey ? 1000 : 100;
    const go = (t: number) => { e.preventDefault(); onSeek(clampN(t, tl.origin, tl.end), false); };
    if (e.key === 'ArrowRight') go(at + stepMs);
    else if (e.key === 'ArrowLeft') go(at - stepMs);
    else if (e.key === 'Home') go(tl.origin);
    else if (e.key === 'End') go(tl.end);
    else if (e.key === 'PageDown') { const s = adjacentStep(tl, at, 1); if (s) go(s.t); }
    else if (e.key === 'PageUp') { const s = adjacentStep(tl, at, -1); if (s) go(s.t); }
    else if (e.key === ' ' && hasVideo) { e.preventDefault(); onTogglePlay(); }
  }

  function submitJump(e: FormEvent) {
    e.preventDefault();
    const ms = parseClock(jump);
    if (ms === null) { setJumpErr(true); return; }
    setJumpErr(false);
    onSeek(clampN(tl.origin + ms, tl.origin, tl.end), false);
  }

  // 可見範圍內的資料(只畫看得到的,長測試也不卡)。
  const visSteps = useMemo(() => tl.steps.filter((s) => s.end >= v.from && s.t <= v.to), [tl.steps, v.from, v.to]);
  const visTraces = useMemo(() => tl.traces.filter((s) => s.end >= v.from && s.start <= v.to), [tl.traces, v.from, v.to]);
  const wave = useMemo(() => waveBins(tl, v.from, v.to, BINS), [tl, v.from, v.to]);
  const logs = useMemo(() => logBins(tl.logs, v.from, v.to, BINS), [tl.logs, v.from, v.to]);
  const maxLog = Math.max(1, ...logs.map((b) => b.count));
  const gaps = useMemo(() => {
    const out: Array<{ from: number; to: number }> = [];
    for (let i = 0; i + 1 < tl.chunks.length; i++) {
      const a = tl.chunks[i]!;
      const b = tl.chunks[i + 1]!;
      if (b.t - a.end > 200) out.push({ from: a.end, to: b.t });
    }
    return out;
  }, [tl.chunks]);
  const ticks = useMemo(() => {
    const st = tickStep(span);
    const first = Math.ceil((v.from - tl.origin) / st) * st;
    const out: number[] = [];
    for (let rel = first; tl.origin + rel <= v.to && out.length < 40; rel += st) out.push(rel);
    return { st, list: out };
  }, [span, v.from, v.to, tl.origin]);
  const tickLabel = (rel: number) => {
    const s = fmtClock(rel);
    // 秒以上的刻度不顯示毫秒;「.000」去掉讓刻度清爽。
    return ticks.st >= 1000 ? s.replace(/\.\d{3}$/, '') : s;
  };

  // 這個時間點(播放頭)的摘要。
  const step = stepAt(tl, at);
  const calls = tracesAt(tl, at);
  const db = levelAt(tl, at);
  const near = logsBetween(tl, at - 1000, at + 1000);
  const errs = near.filter((l) => l.level === 'E' || l.level === 'F' || l.level === 'A');
  const warns = near.filter((l) => l.level === 'W');
  const pick = [...errs, ...warns, ...near].filter((l, i, a) => a.indexOf(l) === i).slice(0, 4);
  const inVideo = chunkAt(tl, at);

  return (
    <section className="ttl" aria-labelledby="ttl-title">
      <div className="ttl__bar">
        <h2 id="ttl-title" className="ttl__title">{tx('title', lang)}</h2>
        <div className="ttl__transport" role="group" aria-label={tx('title', lang)}>
          <button type="button" className="ttl__btn" title={tx('prevStep', lang)} aria-label={tx('prevStep', lang)} onClick={() => { const s = adjacentStep(tl, at, -1); if (s) onSeek(s.t, false); }}>⏮</button>
          <button type="button" className="ttl__btn" title={tx('back', lang)} aria-label={tx('back', lang)} onClick={() => onSeek(clampN(at - 100, tl.origin, tl.end), false)}>‹</button>
          <button type="button" className="ttl__btn ttl__btn--play" disabled={!hasVideo} title={playing ? tx('pause', lang) : tx('play', lang)} aria-label={playing ? tx('pause', lang) : tx('play', lang)} onClick={onTogglePlay}>
            {playing ? '❚❚' : '▶'}
          </button>
          <button type="button" className="ttl__btn" title={tx('fwd', lang)} aria-label={tx('fwd', lang)} onClick={() => onSeek(clampN(at + 100, tl.origin, tl.end), false)}>›</button>
          <button type="button" className="ttl__btn" title={tx('nextStep', lang)} aria-label={tx('nextStep', lang)} onClick={() => { const s = adjacentStep(tl, at, 1); if (s) onSeek(s.t, false); }}>⏭</button>
        </div>
        <output className="ttl__clock" aria-live="off">
          {fmtClock(at - tl.origin)}
          <small> / {fmtClock(total).replace(/\.\d{3}$/, '')}</small>
        </output>
        <span className="ttl__wall" title={tx('wall', lang)}>{wallClock(at)}</span>
        <form className="ttl__jump" onSubmit={submitJump}>
          <label>
            <span>{tx('jump', lang)}</span>
            <input
              value={jump}
              onChange={(e) => { setJump(e.target.value); setJumpErr(false); }}
              placeholder={tx('jumpPh', lang)}
              inputMode="decimal"
              aria-invalid={jumpErr}
              aria-describedby={jumpErr ? 'ttl-jump-err' : undefined}
              size={10}
            />
          </label>
          {jumpErr && <span id="ttl-jump-err" className="ttl__err" role="alert">{tx('jumpBad', lang)}</span>}
        </form>
        <span className="ttl__spacer" />
        {onLive && <button type="button" className="ttl__live" onClick={onLive}>⦿ {liveLabel}</button>}
        <div className="ttl__zoom" role="group" aria-label={tx('zoomIn', lang)}>
          <button type="button" className="ttl__btn" title={tx('zoomOut', lang)} aria-label={tx('zoomOut', lang)} onClick={() => zoomAround(at, 2)} disabled={!view}>−</button>
          <button type="button" className="ttl__btn" title={tx('zoomIn', lang)} aria-label={tx('zoomIn', lang)} onClick={() => zoomAround(at, 0.5)} disabled={span <= MIN_SPAN}>＋</button>
          <button type="button" className="ttl__btn ttl__btn--text" onClick={() => setView(null)} disabled={!view}>{tx('fit', lang)}</button>
        </div>
      </div>

      <div className="ttl__body">
        <div className="ttl__labels" aria-hidden="true">
          <span className="ttl__label ttl__label--ruler" />
          <span className="ttl__label">{tx('laneVideo', lang)}</span>
          <span className="ttl__label">{tx('laneSound', lang)}</span>
          <span className="ttl__label ttl__label--steps">{tx('laneSteps', lang)}</span>
          <span className="ttl__label">{tx('laneAi', lang)}</span>
          <span className="ttl__label">{tx('laneLog', lang)}</span>
        </div>
        <div
          ref={lanesRef}
          className="ttl__lanes"
          role="slider"
          tabIndex={0}
          aria-label={tx('slider', lang)}
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(at - tl.origin)}
          aria-valuetext={`${fmtClock(at - tl.origin)}${step ? ` · #${step.index} ${step.screen ?? ''}` : ''}`}
          title={tx('keys', lang)}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onKeyDown={key}
        >
          <div className="ttl__ruler">
            {ticks.list.map((rel) => (
              <span key={rel} className="ttl__tick" style={{ left: `${x(tl.origin + rel)}%` }}>{tickLabel(rel)}</span>
            ))}
          </div>

          <div className="ttl__lane ttl__lane--video">
            {tl.chunks.length === 0 && <span className="ttl__empty">{tx('noVideo', lang)}</span>}
            {tl.chunks.map((c) => (
              <span key={c.name} className="ttl__clip" style={{ left: `${x(c.t)}%`, width: `${Math.max(0.2, ((c.end - c.t) / span) * 100)}%` }} title={c.name} />
            ))}
            {gaps.map((g) => (
              <span key={g.from} className="ttl__gap" style={{ left: `${x(g.from)}%`, width: `${((g.to - g.from) / span) * 100}%` }} title={tx('gap', lang)} />
            ))}
          </div>

          <div className="ttl__lane ttl__lane--sound">
            <svg viewBox={`0 0 ${BINS} 20`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
              {wave.map((d, i) => {
                if (d === null) return null;
                const h = Math.max(0.6, clampN((d - SILENT_DB) / -SILENT_DB, 0, 1) * 19);
                return <rect key={i} x={i + 0.1} y={10 - h / 2} width={0.8} height={h} />;
              })}
            </svg>
          </div>

          <div className="ttl__lane ttl__lane--steps">
            {visSteps.map((s) => {
              const left = Math.max(0, x(s.t));
              const right = Math.min(100, x(s.end));
              const on = step?.index === s.index;
              return (
                <span
                  key={s.index}
                  className={`ttl__step ttl__step--${s.decidedBy ?? 'agent'}${on ? ' is-on' : ''}`}
                  style={{ left: `${left}%`, width: `${Math.max(0.15, right - left)}%` }}
                  title={`#${s.index} ${s.screen ?? ''} · ${s.action ?? ''}${s.target ? ` ${s.target}` : ''} · ${fmtClock(s.t - tl.origin)}${s.decidedBy ? ` · ${byText(s.decidedBy, lang)}` : ''}`}
                >
                  <span className="ttl__step-text">#{s.index} {s.screen ?? ''}</span>
                </span>
              );
            })}
          </div>

          <div className="ttl__lane ttl__lane--ai">
            {visTraces.map((tr) => (
              <span
                key={`${tr.seat}-${tr.index}-${tr.start}`}
                className={`ttl__call ttl__call--${tr.seat}${tr.ok ? '' : ' is-fail'}`}
                style={{ left: `${Math.max(0, x(tr.start))}%`, width: `${Math.max(0.25, ((tr.end - tr.start) / span) * 100)}%` }}
                title={`${seatText(tr.seat, lang)} · #${tr.index}${tr.modelId ? ` · ${tr.modelId}` : ''} · ${((tr.end - tr.start) / 1000).toFixed(1)}s${tr.ok ? '' : ` · ${tx('failed', lang)}`}`}
              />
            ))}
          </div>

          <div className="ttl__lane ttl__lane--log">
            <svg viewBox={`0 0 ${BINS} 20`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
              {logs.map((b, i) => (b.count ? (
                <rect key={i} className={`is-${b.level}`} x={i + 0.1} y={20 - Math.max(2, (b.count / maxLog) * 19)} width={0.8} height={Math.max(2, (b.count / maxLog) * 19)} />
              ) : null))}
            </svg>
          </div>

          {cursor !== null && at >= v.from && at <= v.to && (
            <div className="ttl__head" style={{ left: `${x(at)}%` }} aria-hidden="true">
              <span className="ttl__head-knob" />
            </div>
          )}
        </div>
      </div>

      {view && (
        <input
          type="range"
          className="ttl__pan"
          aria-label={tx('pan', lang)}
          min={tl.origin}
          max={Math.max(tl.origin, tl.end - (view.to - view.from))}
          step={Math.max(1, Math.round((view.to - view.from) / 100))}
          value={view.from}
          onChange={(e) => {
            const w = view.to - view.from;
            const from = Number(e.target.value);
            setView({ from, to: from + w });
          }}
        />
      )}

      {/* 播放頭這一刻:步驟 / AI / 聲音 / log(完整內容看上面三欄,已跟著跳到這一刻) */}
      <div className="ttl__now" aria-live="polite">
        <div className="ttl__now-cell">
          <span className="ttl__now-k">{tx('nowStep', lang)}</span>
          {step ? (
            <span className="ttl__now-v" title={step.thinking}>
              <b>#{step.index}</b> {step.screen ?? ''} · {step.action ?? ''}{step.target ? `「${step.target}」` : ''}
              {step.decidedBy && <span className={`ttl__by ttl__by--${step.decidedBy}`}>{byText(step.decidedBy, lang)}</span>}
              <span className="ttl__muted"> +{((at - step.t) / 1000).toFixed(2)}s</span>
            </span>
          ) : <span className="ttl__muted">{tx('beforeFirst', lang)}</span>}
        </div>
        <div className="ttl__now-cell">
          <span className="ttl__now-k">{tx('nowAi', lang)}</span>
          {calls.length ? (
            <span className="ttl__now-v">
              {calls.map((c) => (
                <span key={`${c.seat}-${c.index}-${c.start}`} className={`ttl__chip ttl__chip--${c.seat}${c.ok ? '' : ' is-fail'}`} title={c.modelId}>
                  {seatText(c.seat, lang)} #{c.index}{c.ok ? '' : ` · ${tx('failed', lang)}`}
                </span>
              ))}
            </span>
          ) : <span className="ttl__muted">{tx('noAi', lang)}</span>}
        </div>
        <div className="ttl__now-cell">
          <span className="ttl__now-k">{tx('nowSound', lang)}</span>
          <span className="ttl__now-v">
            {db === null ? <span className="ttl__muted">{tx('noRec', lang)}</span> : db <= SILENT_DB ? <span className="ttl__muted">{tx('silent', lang)}</span> : `${Math.round(db)} dB`}
            {inVideo && tl.chunks.length > 1 && <span className="ttl__muted"> · {inVideo.chunk.name}</span>}
          </span>
        </div>
        <div className="ttl__now-cell ttl__now-cell--log">
          <span className="ttl__now-k">{tx('nowLog', lang)}</span>
          {near.length ? (
            <span className="ttl__now-v">
              <span className="ttl__muted">{tx('logCount', lang, { n: near.length, e: errs.length, w: warns.length })}</span>
              {pick.map((l, i) => (
                <button
                  key={i}
                  type="button"
                  className={`ttl__logline is-${l.level}`}
                  title={l.raw}
                  onClick={() => onSeek(l.t, false)}
                >
                  {((l.t - at) / 1000 >= 0 ? '+' : '') + ((l.t - at) / 1000).toFixed(2)}s {l.tag}: {l.msg}
                </button>
              ))}
            </span>
          ) : <span className="ttl__muted">{tx('logNone', lang)}</span>}
        </div>
      </div>
      <p className="ttl__note">{tx('precision', lang)}</p>
    </section>
  );
}
