import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { RLang } from '../report/reportText.ts';
import { SILENT_DB } from './audioLevels.ts';
import {
  adjacentStep,
  fmtClock,
  logBins,
  parseClock,
  stepAt,
  tickStep,
  wallClock,
  waveBins,
  type Timeline,
  type TlStep,
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
  laneRec: ['錄影 / 聲音', 'Video / sound'],
  laneMarks: ['觸發', 'Triggers'],
  laneSteps: ['步驟', 'Steps'],
  legend: ['🧭 決策 Agent · 👁 視覺 Agent · ⚡ 照記憶直接做 · 👆 測試人員 · 🧠 記憶打到 · 📜 腳本換項', '🧭 Decision agent · 👁 Vision agent · ⚡ Replayed from memory · 👆 Tester · 🧠 Memory hit · 📜 Script item'],
  memHit: ['記憶打到', 'memory hit'],
  scriptAt: ['腳本第 {s} 項', 'script item {s}'],
  byOperator: ['測試人員直接操作', 'Tester gesture'],
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
  byAgent: ['決策 Agent', 'Decision agent'],
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
  by === 'reflex' ? tx('byReflex', lang) : by === 'vision' ? tx('byVision', lang) : by === 'operator' ? tx('byOperator', lang) : tx('byAgent', lang);
/** 誰觸發這一步 / 哪個 Agent 的小圖示(時間軸與「這一刻」共用)。 */
const DECIDER: Record<string, string> = { agent: '🧭', vision: '👁', reflex: '⚡', operator: '👆' };
const SEAT: Record<string, string> = { vlm: '👁', agent: '🧭', subagent: '🛠' };
/** 標記之間至少隔多少(% 寬),太密就略過(滑過步驟仍看得到)。 */
const MARK_GAP = 1.6;
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

  const step = stepAt(tl, at);
  const stepTip = (s: TlStep) =>
    `#${s.index} ${s.screen ?? ''} · ${s.action ?? ''}${s.target ? ` ${s.target}` : ''} · ${fmtClock(s.t - tl.origin)} · ${byText(s.decidedBy, lang)}`
    + `${s.memHit ? ` · 🧠 ${tx('memHit', lang)}` : ''}${s.script ? ` · 📜 ${tx('scriptAt', lang, { s: s.script })}` : ''}`;
  // 觸發標記:誰觸發、記憶有沒有打到、腳本換項;太密的略過(腳本換項 / 記憶打到優先保留)。
  const marks = useMemo(() => {
    const out: Array<{ index: number; t: number; by: string; memHit: boolean; script?: string; tip: string }> = [];
    let lastX = -Infinity;
    let lastScript = '';
    for (const s of visSteps) {
      const sx = ((s.t - v.from) / span) * 100;
      const scriptChanged = Boolean(s.script && s.script !== lastScript);
      if (s.script) lastScript = s.script;
      if (sx < -1 || sx > 101) continue;
      if (sx - lastX < MARK_GAP && !scriptChanged) continue;
      lastX = sx;
      out.push({ index: s.index, t: s.t, by: s.decidedBy ?? 'agent', memHit: Boolean(s.memHit), ...(scriptChanged ? { script: s.script! } : {}), tip: stepTip(s) });
    }
    return out;
  }, [visSteps, v.from, span, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="ttl" aria-labelledby="ttl-title">
      <div className="ttl__bar">
        <h2 id="ttl-title" className="ttl__title" title={tx('legend', lang)}>{tx('title', lang)}</h2>
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
        <span className="ttl__legend">{tx('legend', lang)}</span>
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
          <span className="ttl__label">{tx('laneRec', lang)}</span>
          <span className="ttl__label ttl__label--marks">{tx('laneMarks', lang)}</span>
          <span className="ttl__label ttl__label--steps">{tx('laneSteps', lang)}</span>
          <span className="ttl__label ttl__label--ai">{tx('laneAi', lang)}</span>
          <span className="ttl__label ttl__label--log">{tx('laneLog', lang)}</span>
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
          title={`${tx('keys', lang)}\n${tx('precision', lang)}`}
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

          {/* 錄影 + 聲音同一條:底色 = 有錄影的時段,上面畫聲音波形,斜線 = 錄影空檔 */}
          <div className="ttl__lane ttl__lane--rec">
            {tl.chunks.length === 0 && <span className="ttl__empty">{tx('noVideo', lang)}</span>}
            {tl.chunks.map((c) => (
              <span key={c.name} className="ttl__clip" style={{ left: `${x(c.t)}%`, width: `${Math.max(0.2, ((c.end - c.t) / span) * 100)}%` }} title={c.name} />
            ))}
            {gaps.map((g) => (
              <span key={g.from} className="ttl__gap" style={{ left: `${x(g.from)}%`, width: `${((g.to - g.from) / span) * 100}%` }} title={tx('gap', lang)} />
            ))}
            <svg viewBox={`0 0 ${BINS} 20`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
              {wave.map((d, i) => {
                if (d === null) return null;
                const h = Math.max(0.6, clampN((d - SILENT_DB) / -SILENT_DB, 0, 1) * 19);
                return <rect key={i} x={i + 0.1} y={10 - h / 2} width={0.8} height={h} />;
              })}
            </svg>
          </div>

          {/* 標記:每一步是誰觸發(決策 / 視覺 / 照記憶 / 測試人員)、記憶有沒有打到、腳本換到第幾項 */}
          <div className="ttl__lane ttl__lane--marks">
            {marks.map((m) => (
              <span
                key={m.index}
                className={`ttl__mark${m.memHit ? ' is-mem' : ''}`}
                style={{ left: `${x(m.t)}%` }}
                title={m.tip}
              >
                <span className="ttl__mark-ico">{DECIDER[m.by] ?? DECIDER.agent}</span>
                {m.memHit && <span className="ttl__mark-mem">🧠</span>}
                {m.script && <span className="ttl__mark-script">📜{m.script}</span>}
              </span>
            ))}
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
                  title={stepTip(s)}
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
                title={`${SEAT[tr.seat] ?? ''} ${seatText(tr.seat, lang)} · #${tr.index}${tr.modelId ? ` · ${tr.modelId}` : ''} · ${((tr.end - tr.start) / 1000).toFixed(1)}s${tr.ok ? '' : ` · ${tx('failed', lang)}`}`}
              />
            ))}
          </div>

          <div className="ttl__lane ttl__lane--log">
            <svg viewBox={`0 0 ${BINS} 20`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
              {logs.map((b, i) => (b.count ? (
                <rect key={i} className={`is-${b.level}`} x={i + 0.1} y={20 - Math.max(3, (b.count / maxLog) * 19)} width={0.8} height={Math.max(3, (b.count / maxLog) * 19)} />
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
    </section>
  );
}
