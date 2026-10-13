import { useEffect, useState } from 'react';
import type { RLang } from '../report/reportText.ts';
import { formatPick, LivePlayer, type LivePlayerState, type PickPoint } from './LivePlayer.tsx';
import './LiveScreen.css';

const T = {
  realtime: ['即時', 'Live'],
  frames: ['截圖', 'Snapshots'],
  popout: ['在新視窗開啟(雙螢幕)', 'Open in a new window'],
  noAudio: ['此裝置無法錄製聲音', 'Sound recording unavailable on this device'],
  recording: ['錄影中(含聲音)· 測試結束後可回放', 'Recording with sound · replay after the test'],
  recordingHint: ['為了不打斷遊戲,測試中不播放聲音;整場錄影(含聲音)會在結束後出現在這裡。', 'To avoid pausing the game, sound is not played live; the full recording with sound appears here after the test.'],
  pickMode: ['指定點擊或拖曳', 'Pick a tap or drag'],
  pickHint: ['點一下 = 指定點擊位置;按住拖曳 = 指定拖曳路徑', 'Click to set a tap · press and drag to set a drag path'],
  pickTitle: ['指定點擊位置', 'Tap position'],
  dragTitle: ['指定拖曳路徑', 'Drag path'],
  tapHere: ['讓 AI 點這裡', 'Tap here'],
  dragHere: ['讓 AI 照這樣拖', 'Drag like this'],
  sending: ['送出中…', 'Sending…'],
  cancel: ['取消', 'Cancel'],
  pointSent: ['已送出,AI 下一步會點這裡', 'Sent — the AI taps it next step'],
  dragSent: ['已送出,AI 下一步會照這條路徑拖曳', 'Sent — the AI drags this path next step'],
  dragTime: ['拖曳 {s} 秒', '{s}s drag'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];

function CrosshairIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="6" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PopoutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

/** 開啟彈出播放視窗(可拖到第二個螢幕)。 */
export function openLivePopout(jobId: string, aspect = 9 / 20) {
  // 依目前畫面方向開對應形狀的視窗(橫向遊戲開橫的視窗);之後使用者可自行縮放。
  let w: number;
  let h: number;
  if (aspect > 1) {
    w = Math.min(1280, window.screen.availWidth - 40);
    h = Math.min(window.screen.availHeight - 40, Math.round(w / aspect) + 90);
  } else {
    h = Math.min(980, window.screen.availHeight - 40);
    w = Math.round((h - 90) * aspect) + 20;
  }
  window.open(`${window.location.pathname}#/live/${encodeURIComponent(jobId)}`, `pa-live-${jobId}`, `popup=yes,width=${w},height=${h}`);
}

/**
 * 即時畫面 + 精簡控制列(錄影狀態 / 新視窗)。
 * 即時畫面播 screenrecord 段落(無聲、延遲約 3–5 秒)。聲音不即時播放:分段錄音每次重開都會
 * 讓遊戲失去焦點而暫停,改成整場連續錄影(含聲音),測試結束後在任務頁回放。
 */
export function LiveScreen({
  jobId,
  isLive,
  fallbackUrl,
  alt,
  lang,
  audioState,
  popout = true,
  className,
  onAspect,
  point,
  onPoint,
  onSendPoint,
}: {
  jobId: string;
  isLive: boolean;
  fallbackUrl?: string | null;
  alt: string;
  lang: RLang;
  /** audio-levels 的 state:'recording' | 'on' | 'unavailable' | 'none' … */
  audioState?: string;
  popout?: boolean;
  className?: string;
  /** 畫面比例(寬/高)變化(彈出視窗據此決定形狀)。 */
  onAspect?: (aspect: number) => void;
  /** 目前選取的畫面位置(由外層保管,聊天室可附加說明一起送)。 */
  point?: PickPoint | null;
  onPoint?: (p: PickPoint | null) => void;
  /** 「讓 AI 點這裡」:只送位置。 */
  onSendPoint?: (p: PickPoint) => Promise<void>;
}) {
  const [ps, setPs] = useState<LivePlayerState>({ playing: false });
  const [aspect, setAspect] = useState(9 / 20);
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState(0);
  const [sentDrag, setSentDrag] = useState(false);
  const [pickMode, setPickMode] = useState(false);
  const handleAspect = (a: number) => { setAspect(a); onAspect?.(a); };
  const open = () => openLivePopout(jobId, aspect);
  const delay = ps.delaySec !== undefined ? Math.max(1, Math.round(ps.delaySec)) : undefined;
  // 「指定點擊」要使用者主動開啟;平常觀看不顯示藍框,點畫面仍是開新視窗。
  const pickable = isLive && !!onPoint && pickMode;

  async function sendPoint() {
    if (!point || !onSendPoint || sending) return;
    setSending(true);
    try {
      await onSendPoint(point);
      setSentDrag(!!point.to);
      onPoint?.(null);
      setPickMode(false);
      setSentAt(Date.now());
    } finally {
      setSending(false);
    }
  }
  useEffect(() => {
    if (!sentAt) return;
    const t = setTimeout(() => setSentAt(0), 2500);
    return () => clearTimeout(t);
  }, [sentAt]);
  useEffect(() => {
    if (isLive) return;
    setPickMode(false);
    onPoint?.(null);
  }, [isLive, onPoint]);
  // Esc 取消選取。
  useEffect(() => {
    if (!point || !onPoint) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onPoint(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [point, onPoint]);

  const player = (
    <LivePlayer
      jobId={jobId}
      isLive={isLive}
      source="live"
      muted
      fallbackUrl={fallbackUrl ?? null}
      alt={alt}
      onState={setPs}
      onAspect={handleAspect}
      {...(pickable ? { onPick: (p: PickPoint) => onPoint!(p), marker: point ?? null } : {})}
    />
  );

  return (
    <div className={`livescreen ${className ?? ''}`}>
      <div className="livescreen__stage">
        {pickable || !popout ? player : (
          <button type="button" className="livescreen__click" onClick={open} title={tx('popout', lang)} aria-label={tx('popout', lang)}>
            {player}
          </button>
        )}
        {pickable && !point && !sentAt && <span className="livescreen__hint">{tx('pickHint', lang)}</span>}
        {sentAt > 0 && <span className="livescreen__note is-ok" role="status">{tx(sentDrag ? 'dragSent' : 'pointSent', lang)}</span>}
        {pickable && point && (
          <div className="livescreen__pick" role="group" aria-label={tx(point.to ? 'dragTitle' : 'pickTitle', lang)}>
            <span className="livescreen__pick-pos">
              {point.to ? '↗' : '📍'} {formatPick(point)}
              {point.to && point.ms ? ` · ${tx('dragTime', lang).replace('{s}', (point.ms / 1000).toFixed(1))}` : ''}
            </span>
            {onSendPoint && (
              <button type="button" className="livescreen__pick-go" onClick={() => void sendPoint()} disabled={sending}>
                {sending ? tx('sending', lang) : tx(point.to ? 'dragHere' : 'tapHere', lang)}
              </button>
            )}
            <button type="button" className="livescreen__pick-x" onClick={() => onPoint?.(null)} aria-label={tx('cancel', lang)}>✕</button>
          </div>
        )}
      </div>

      {isLive && (
        <div className="livescreen__bar">
          <span className={`livescreen__mode ${ps.playing ? 'is-live' : ''}`}>
            {ps.playing ? `${tx('realtime', lang)}${delay ? ` · ~${delay}s` : ''}` : tx('frames', lang)}
          </span>
          <span className="livescreen__spacer" />
          {onPoint && (
            <button
              type="button"
              className={`livescreen__btn ${pickMode ? 'is-on' : ''}`}
              onClick={() => {
                const next = !pickMode;
                setPickMode(next);
                if (!next) onPoint(null);
              }}
              aria-pressed={pickMode}
              title={tx('pickMode', lang)}
              aria-label={tx('pickMode', lang)}
            >
              <CrosshairIcon />
            </button>
          )}
          {audioState === 'recording' && (
            <span className="livescreen__rec" title={tx('recordingHint', lang)}>{tx('recording', lang)}</span>
          )}
          {audioState === 'unavailable' && <span className="livescreen__rec is-off">{tx('noAudio', lang)}</span>}
          {popout && (
            <button type="button" className="livescreen__btn" onClick={open} title={tx('popout', lang)} aria-label={tx('popout', lang)}>
              <PopoutIcon />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
