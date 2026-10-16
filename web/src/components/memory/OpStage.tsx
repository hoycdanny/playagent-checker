import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { RLang } from '../report/reportText.ts';
import type { MemOp, Trust } from './memoryScript.ts';

/**
 * 操作舞台:大張截圖 + 每個操作的位置標記。
 * - 拖曳標記 = 改位置(放開就儲存);滑動有起點 / 終點兩個把手。
 * - 方向鍵微調(Shift 一次 5%),Enter 儲存。
 * - pickLabel 有值時進入「點位置」模式:點截圖任一處 → onPick。
 */
export interface StageMarker {
  key: string;
  n: number;
  op: MemOp;
  trust: Trust | 'draft';
  label: string;
  active: boolean;
}

const T = {
  noShot: ['這個畫面還沒有截圖', 'No screenshot for this screen yet'],
  dragHint: ['拖曳圓點調整位置,放開就儲存 · 方向鍵微調、Enter 儲存', 'Drag a dot to move it (saves on release) · arrow keys nudge, Enter saves'],
  markerAria: ['第 {n} 個操作:{label},位置 {x}%、{y}%。可拖曳或用方向鍵調整', 'Action {n}: {label}, at {x}%, {y}%. Drag or use arrow keys to adjust'],
  endAria: ['第 {n} 個操作的滑動終點', 'Swipe end of action {n}'],
} as const;
const tx = (k: keyof typeof T, lang: RLang, vars: Record<string, string | number> = {}) =>
  Object.entries(vars).reduce<string>((s, [n, v]) => s.replace(`{${n}}`, String(v)), T[k][lang === 'zh' ? 0 : 1]);

const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 10000) / 10000;
const pct = (v: number | undefined) => Math.round((v ?? 0) * 1000) / 10;

export function OpStage({
  lang,
  shotUrl,
  alt,
  markers,
  pickLabel,
  onPick,
  onMove,
  onCommit,
  onSelect,
}: {
  lang: RLang;
  shotUrl?: string;
  alt: string;
  markers: StageMarker[];
  /** 有值 = 點位置模式(顯示這段提示)。 */
  pickLabel?: string | null;
  onPick?: (x: number, y: number) => void;
  /** 拖曳 / 微調中(只更新畫面,不儲存)。 */
  onMove: (key: string, op: MemOp) => void;
  /** 放開 / Enter:儲存。 */
  onCommit: (key: string, op: MemOp) => void;
  onSelect: (key: string) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ key: string; which: 'start' | 'end'; op: MemOp; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const relFrom = (clientX: number, clientY: number) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: clamp((clientX - r.left) / r.width), y: clamp((clientY - r.top) / r.height) };
  };
  const moved = (op: MemOp, which: 'start' | 'end', x: number, y: number): MemOp =>
    which === 'end' ? { ...op, x2: x, y2: y } : { ...op, x, y };

  const down = (e: PointerEvent<HTMLButtonElement>, m: StageMarker, which: 'start' | 'end') => {
    if (pickLabel) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { key: m.key, which, op: m.op, moved: false };
    setDragging(m.key);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const { x, y } = relFrom(e.clientX, e.clientY);
    d.op = moved(d.op, d.which, x, y);
    d.moved = true;
    onMove(d.key, d.op);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (!d) return;
    if (d.moved) onCommit(d.key, d.op);
    else onSelect(d.key);
  };
  const nudge = (e: KeyboardEvent<HTMLButtonElement>, m: StageMarker, which: 'start' | 'end') => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (e.key === 'Enter') { e.preventDefault(); onCommit(m.key, m.op); return; }
    if (!dx && !dy) return;
    e.preventDefault();
    const cx = which === 'end' ? m.op.x2 ?? 0 : m.op.x ?? 0;
    const cy = which === 'end' ? m.op.y2 ?? 0 : m.op.y ?? 0;
    onMove(m.key, moved(m.op, which, clamp(cx + dx), clamp(cy + dy)));
  };
  const pick = (e: MouseEvent<HTMLDivElement>) => {
    if (!pickLabel || !onPick) return;
    const { x, y } = relFrom(e.clientX, e.clientY);
    onPick(x, y);
  };

  const withPoint = markers.filter((m) => Number.isFinite(m.op.x) && Number.isFinite(m.op.y));
  const swipes = withPoint.filter((m) => m.op.a === 'swipe' && Number.isFinite(m.op.x2) && Number.isFinite(m.op.y2));

  return (
    <div className="stage">
      <div
        ref={frame}
        className={`stage__frame${pickLabel ? ' is-picking' : ''}${dragging ? ' is-dragging' : ''}${shotUrl ? '' : ' is-empty'}`}
        onClick={pick}
      >
        {shotUrl ? <img src={shotUrl} alt={alt} draggable={false} /> : <div className="stage__noshot">{tx('noShot', lang)}</div>}
        <svg className="stage__lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {swipes.map((m) => (
            <line
              key={m.key}
              x1={pct(m.op.x)} y1={pct(m.op.y)} x2={pct(m.op.x2)} y2={pct(m.op.y2)}
              className={`stage__line stage__line--${m.trust}${m.active ? ' is-active' : ''}`}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {withPoint.map((m) => (
          <button
            key={m.key}
            type="button"
            className={`stage__dot stage__dot--${m.trust}${m.active ? ' is-active' : ''}`}
            style={{ left: `${pct(m.op.x)}%`, top: `${pct(m.op.y)}%` }}
            aria-label={tx('markerAria', lang, { n: m.n, label: m.label, x: pct(m.op.x), y: pct(m.op.y) })}
            title={m.label}
            onPointerDown={(e) => down(e, m, 'start')}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onKeyDown={(e) => nudge(e, m, 'start')}
            onClick={(e) => e.stopPropagation()}
          >
            {m.n}
          </button>
        ))}
        {swipes.map((m) => (
          <button
            key={`${m.key}-end`}
            type="button"
            className={`stage__dot stage__dot--end stage__dot--${m.trust}${m.active ? ' is-active' : ''}`}
            style={{ left: `${pct(m.op.x2)}%`, top: `${pct(m.op.y2)}%` }}
            aria-label={tx('endAria', lang, { n: m.n })}
            onPointerDown={(e) => down(e, m, 'end')}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onKeyDown={(e) => nudge(e, m, 'end')}
            onClick={(e) => e.stopPropagation()}
          >
            ➜
          </button>
        ))}
        {pickLabel && <div className="stage__pickbar" role="status">{pickLabel}</div>}
      </div>
      {withPoint.length > 0 && !pickLabel && <p className="stage__hint">{tx('dragHint', lang)}</p>}
    </div>
  );
}
