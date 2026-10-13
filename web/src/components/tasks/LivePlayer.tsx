import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
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

/** 畫面寬高比(寬/高);> 1 = 橫向。 */
const DEFAULT_ASPECT = 9 / 20;

/**
 * 畫面上的點選位置:相對畫面內容的比例(0–1)。
 * 有 to = 拖曳手勢:從 (x,y) 按住拖到 to 放開,ms 是實際拖的時間(遊戲的拖放、瞄準、滑動等)。
 */
export interface PickPoint { x: number; y: number; to?: { x: number; y: number }; ms?: number }

/** 按下到放開移動不到這麼多 px 就算「點一下」(手會微微抖動)。 */
export const DRAG_MIN_PX = 10;
/** 拖曳耗時範圍(毫秒),與 API 的 dragMs 範圍一致。 */
export const DRAG_MS_MIN = 100;
export const DRAG_MS_MAX = 5000;

const round4 = (v: number) => Math.round(v * 10000) / 10000;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 指標手勢 → 點一下或拖曳。movedPx = 按下到放開的螢幕位移;ms = 拖的時間。 */
export function gestureFrom(start: { x: number; y: number }, end: { x: number; y: number }, movedPx: number, ms: number): PickPoint {
  if (movedPx < DRAG_MIN_PX || (start.x === end.x && start.y === end.y)) return { x: start.x, y: start.y };
  return {
    x: start.x, y: start.y,
    to: { x: end.x, y: end.y },
    ms: Math.max(DRAG_MS_MIN, Math.min(DRAG_MS_MAX, Math.round(ms))),
  };
}

/** 送給 POST /tasks/{id}/commands 的手勢欄位(point;拖曳再加 to + dragMs)。 */
export function gestureBody(p: PickPoint): { point: { x: number; y: number }; to?: { x: number; y: number }; dragMs?: number } {
  return { point: { x: p.x, y: p.y }, ...(p.to ? { to: { x: p.to.x, y: p.to.y }, ...(p.ms ? { dragMs: p.ms } : {}) } : {}) };
}

/** 顯示用:「12%, 34%」或「12%, 34% → 56%, 78%」。 */
export function formatPick(p: { x: number; y: number; to?: { x: number; y: number } | undefined }): string {
  const f = (q: { x: number; y: number }) => `${Math.round(q.x * 100)}%, ${Math.round(q.y * 100)}%`;
  return p.to ? `${f(p)} → ${f(p.to)}` : f(p);
}

/**
 * object-fit: contain 下,媒體內容在元素裡實際佔的矩形(扣掉上下或左右黑邊)。
 * 回傳相對元素左上角的 px。
 */
export function containRect(boxW: number, boxH: number, mediaW: number, mediaH: number) {
  if (!(boxW > 0 && boxH > 0 && mediaW > 0 && mediaH > 0)) return { left: 0, top: 0, width: boxW, height: boxH };
  const s = Math.min(boxW / mediaW, boxH / mediaH);
  const width = mediaW * s;
  const height = mediaH * s;
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

/** 點擊位置(相對元素 px)→ 畫面內容比例;點在黑邊上回 null。 */
export function toContentPoint(px: number, py: number, boxW: number, boxH: number, mediaW: number, mediaH: number): PickPoint | null {
  const r = containRect(boxW, boxH, mediaW, mediaH);
  const x = (px - r.left) / r.width;
  const y = (py - r.top) / r.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: round4(x), y: round4(y) };
}

/** 同 toContentPoint,但拖到黑邊或框外時夾回畫面邊緣(拖曳終點用)。 */
export function toContentPointClamped(px: number, py: number, boxW: number, boxH: number, mediaW: number, mediaH: number): PickPoint {
  const r = containRect(boxW, boxH, mediaW, mediaH);
  return { x: round4(clamp01((px - r.left) / r.width)), y: round4(clamp01((py - r.top) / r.height)) };
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
  onAspect,
  onPick,
  marker,
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
  /** 畫面方向/比例改變(橫豎切換)時通知(彈出視窗據此決定形狀)。 */
  onAspect?: (aspect: number) => void;
  /** 指點模式:點畫面回報相對位置;按住拖曳回報起點 + 終點(0–1,以實際畫面內容為準,不含黑邊)。 */
  onPick?: (p: PickPoint) => void;
  /** 已選位置(或拖曳路徑)的標記。 */
  marker?: PickPoint | null;
}) {
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const aspectCb = useRef(onAspect);
  aspectCb.current = onAspect;
  /** 依實際畫面尺寸更新比例(只在變化明顯時更新,避免抖動)。 */
  const measure = (w: number, h: number) => {
    if (!(w > 0 && h > 0)) return;
    const a = w / h;
    setAspect((prev) => {
      if (Math.abs(prev - a) / prev < 0.03) return prev;
      aspectCb.current?.(a);
      return a;
    });
  };
  const vids = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const [front, setFront] = useState(0); // 目前顯示中的 <video>
  const [playing, setPlaying] = useState(false);
  const queue = useRef<Segment[]>([]);
  const cursor = useRef<string | undefined>(undefined);
  const backReady = useRef(false); // 背面 video 已指定下一段(載入中或已可播)
  const backLoaded = useRef(false); // 背面 video 的第一幀已解碼(換上去才不會黑一下)
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
    backLoaded.current = false;
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
      backLoaded.current = false;
      back.src = seg.url;
      back.dataset['t'] = String(seg.t);
      back.load();
    }
    // 下一段的第一幀解碼完才換上;還沒好就讓目前這段停在最後一幀(不會黑一下)。
    if (frontIdle && backReady.current && backLoaded.current) swap();
  }

  function swap() {
    const backIdx = 1 - frontRef.current;
    const back = vids[backIdx]!.current;
    if (!back) return;
    backReady.current = false;
    backLoaded.current = false;
    frontRef.current = backIdx;
    setFront(backIdx);
    setPlaying(true);
    // 有積壓時稍微加速追上。
    back.playbackRate = queue.current.length >= 2 ? 1.25 : 1;
    measure(back.videoWidth, back.videoHeight);
    const t = Number(back.dataset['t']);
    if (Number.isFinite(t)) lastSegT.current = t;
    back.play().catch(() => { /* 自動播放被擋(含聲音時):保持靜音重試 */ back.muted = true; void back.play().catch(() => {}); });
    stateCb.current?.({ playing: true, delaySec: Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 1000) : undefined });
    pump();
  }

  function onEnded(idx: number) {
    if (idx !== frontRef.current) return;
    if (backReady.current && backLoaded.current) swap();
    else pump(); // 下一段還沒載好:停在最後一幀,載好時(onLoadedData)再換
  }

  useEffect(() => { if (!playing) stateCb.current?.({ playing: false }); }, [playing]);

  // 外框固定(填滿容器),直向/橫向畫面都以 contain 置中;點選與標記都以「實際畫面內容」換算。
  const boxRef = useRef<HTMLDivElement>(null);
  const mediaSize = (): [number, number] => {
    const v = vids[frontRef.current]?.current;
    if (playing && v && v.videoWidth > 0) return [v.videoWidth, v.videoHeight];
    const img = boxRef.current?.querySelector('img');
    if (img && img.naturalWidth > 0) return [img.naturalWidth, img.naturalHeight];
    return [aspect * 1000, 1000];
  };
  // 指點手勢:按下 → (拖) → 放開。移動很少 = 點一下;否則 = 從按下處拖到放開處。
  // 用 pointer events + pointer capture:滑鼠、觸控板、觸控螢幕都一樣,拖出框外也追得到。
  const drag = useRef<{ id: number; start: PickPoint; cx: number; cy: number; t: number } | null>(null);
  const [preview, setPreview] = useState<PickPoint | null>(null);
  const locate = (clientX: number, clientY: number, clamp: boolean): PickPoint | null => {
    if (!boxRef.current) return null;
    const r = boxRef.current.getBoundingClientRect();
    const [mw, mh] = mediaSize();
    return clamp
      ? toContentPointClamped(clientX - r.left, clientY - r.top, r.width, r.height, mw, mh)
      : toContentPoint(clientX - r.left, clientY - r.top, r.width, r.height, mw, mh);
  };
  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!onPick || e.button !== 0) return;
    const p = locate(e.clientX, e.clientY, false); // 起點必須在畫面內容上(不是黑邊)
    if (!p) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, start: p, cx: e.clientX, cy: e.clientY, t: performance.now() };
    setPreview(p);
  }
  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const end = locate(e.clientX, e.clientY, true);
    if (end) setPreview(gestureFrom(d.start, end, Math.hypot(e.clientX - d.cx, e.clientY - d.cy), 0));
  }
  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    setPreview(null);
    const end = locate(e.clientX, e.clientY, true) ?? d.start;
    onPick?.(gestureFrom(d.start, end, Math.hypot(e.clientX - d.cx, e.clientY - d.cy), performance.now() - d.t));
  }
  function handlePointerCancel() {
    drag.current = null;
    setPreview(null);
  }
  // 指點模式下吃掉 click,不要冒泡到外層(例如「開新視窗」按鈕)。
  function swallowClick(e: ReactMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
  }
  // 標記位置:畫面內容矩形內的比例 → 外框 px(重新渲染時依當下尺寸重算,縮放視窗也準)。
  const [, force] = useState(0);
  useEffect(() => {
    if (!marker) return;
    const onResize = () => force((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [marker]);
  const arrowId = `lp-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const shown = preview ?? marker ?? null;
  let markerStyle: CSSProperties | undefined;
  let path: { x1: number; y1: number; x2: number; y2: number; w: number; h: number } | undefined;
  if (shown && boxRef.current) {
    const r = boxRef.current.getBoundingClientRect();
    const [mw, mh] = mediaSize();
    const c = containRect(r.width, r.height, mw, mh);
    const x1 = c.left + shown.x * c.width;
    const y1 = c.top + shown.y * c.height;
    markerStyle = { left: x1, top: y1 };
    if (shown.to) path = { x1, y1, x2: c.left + shown.to.x * c.width, y2: c.top + shown.to.y * c.height, w: r.width, h: r.height };
  }
  return (
    <div
      ref={boxRef}
      className={`liveplayer ${onPick ? 'is-picking' : ''} ${className ?? ''}`}
      {...(onPick
        ? {
            onPointerDown: handlePointerDown,
            onPointerMove: handlePointerMove,
            onPointerUp: handlePointerUp,
            onPointerCancel: handlePointerCancel,
            onClick: swallowClick,
          }
        : {})}
    >
      {vids.map((r, i) => (
        <video
          key={i}
          ref={r}
          className={`liveplayer__video ${playing && front === i ? 'is-front' : ''}`}
          playsInline
          muted
          preload="auto"
          onLoadedMetadata={(e) => { if (i === frontRef.current) measure(e.currentTarget.videoWidth, e.currentTarget.videoHeight); }}
          onResize={(e) => { if (i === frontRef.current) measure(e.currentTarget.videoWidth, e.currentTarget.videoHeight); }}
          onEnded={() => onEnded(i)}
          onLoadedData={() => { if (i !== frontRef.current) { backLoaded.current = true; pump(); } }}
          onCanPlay={() => { if (i !== frontRef.current) { backLoaded.current = true; pump(); } }}
          onError={() => { if (i !== frontRef.current) { backReady.current = false; backLoaded.current = false; pump(); } }}
          aria-hidden={!(playing && front === i)}
        />
      ))}
      {!playing && fallbackUrl && (
        <img
          className="liveplayer__img"
          src={fallbackUrl}
          alt={alt}
          onLoad={(e) => measure(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
        />
      )}
      {playing && <span className="visually-hidden">{alt}</span>}
      {path && (
        <svg className="liveplayer__drag" width={path.w} height={path.h} viewBox={`0 0 ${path.w} ${path.h}`} aria-hidden="true" focusable="false">
          <defs>
            <marker id={arrowId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" className="liveplayer__drag-head" />
            </marker>
          </defs>
          <line x1={path.x1} y1={path.y1} x2={path.x2} y2={path.y2} className="liveplayer__drag-halo" />
          <line x1={path.x1} y1={path.y1} x2={path.x2} y2={path.y2} className="liveplayer__drag-line" markerEnd={`url(#${arrowId})`} />
          <circle cx={path.x2} cy={path.y2} r="9" className="liveplayer__drag-end" />
        </svg>
      )}
      {markerStyle && <span className={`liveplayer__marker ${path ? 'is-drag' : ''}`} style={markerStyle} aria-hidden="true" />}
    </div>
  );
}
