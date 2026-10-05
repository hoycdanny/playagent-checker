import { useEffect, useState } from 'react';
import type { RLang } from '../report/reportText.ts';
import { LivePlayer, type LivePlayerState, type PickPoint } from './LivePlayer.tsx';
import { useLiveSound } from './useLiveSound.ts';
import './LiveScreen.css';

const T = {
  soundOn: ['開啟音效', 'Turn sound on'],
  soundOff: ['靜音', 'Mute'],
  volume: ['音量', 'Volume'],
  delayed: ['含音效 · 延遲約 {n} 秒', 'With sound · ~{n}s behind'],
  realtime: ['即時', 'Live'],
  frames: ['截圖', 'Snapshots'],
  popout: ['在新視窗開啟(雙螢幕)', 'Open in a new window'],
  noAudio: ['此裝置無法錄製音效', 'Sound capture unavailable on this device'],
  waitingAudio: ['音效緩衝中…(第一段約 25 秒後出現)', 'Buffering sound… (first clip in ~25s)'],
  pickHint: ['點畫面可指定位置讓 AI 點', 'Click the screen to tell the AI where to tap'],
  pickTitle: ['指定點擊位置', 'Tap position'],
  tapHere: ['讓 AI 點這裡', 'Tap here'],
  sending: ['送出中…', 'Sending…'],
  cancel: ['取消', 'Cancel'],
  pointSent: ['已送出,AI 下一步會點這裡', 'Sent — the AI taps it next step'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      {on ? <><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></> : <path d="m16 9 5 6M21 9l-5 6" />}
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
 * 即時畫面 + 精簡控制列(聲音開關 / 音量 / 新視窗)。
 * 聲音關:播 screenrecord 即時段落(無聲、延遲約 3–5 秒)。
 * 聲音開:改播含音效的錄影段落(畫面與聲音同步,延遲約 25–30 秒)。
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
  /** audio-levels 的 state:'on' | 'unavailable' | 'none' … */
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
  const sound = useLiveSound();
  const [ps, setPs] = useState<LivePlayerState>({ playing: false });
  const [aspect, setAspect] = useState(9 / 20);
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState(0);
  const handleAspect = (a: number) => { setAspect(a); onAspect?.(a); };
  const open = () => openLivePopout(jobId, aspect);
  const audioUsable = audioState !== 'unavailable';
  const withSound = sound.on && audioUsable;
  const mode = withSound ? 'audio' : 'live';
  const delay = ps.delaySec !== undefined ? Math.max(1, Math.round(ps.delaySec)) : undefined;
  // 執行中且外層有接收 → 點畫面 = 選位置(新視窗改由 ↗ 按鈕開)。
  const pickable = isLive && !!onPoint;

  async function sendPoint() {
    if (!point || !onSendPoint || sending) return;
    setSending(true);
    try {
      await onSendPoint(point);
      onPoint?.(null);
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
      source={mode}
      muted={!withSound}
      volume={sound.volume}
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
        {withSound && isLive && !ps.playing && !point && <span className="livescreen__note">{tx('waitingAudio', lang)}</span>}
        {pickable && !point && !sentAt && <span className="livescreen__hint">{tx('pickHint', lang)}</span>}
        {sentAt > 0 && <span className="livescreen__note is-ok" role="status">{tx('pointSent', lang)}</span>}
        {pickable && point && (
          <div className="livescreen__pick" role="group" aria-label={tx('pickTitle', lang)}>
            <span className="livescreen__pick-pos">📍 {Math.round(point.x * 100)}%, {Math.round(point.y * 100)}%</span>
            {onSendPoint && (
              <button type="button" className="livescreen__pick-go" onClick={() => void sendPoint()} disabled={sending}>
                {sending ? tx('sending', lang) : tx('tapHere', lang)}
              </button>
            )}
            <button type="button" className="livescreen__pick-x" onClick={() => onPoint?.(null)} aria-label={tx('cancel', lang)}>✕</button>
          </div>
        )}
      </div>

      {isLive && (
        <div className="livescreen__bar">
          <span className={`livescreen__mode ${withSound ? 'is-sound' : ps.playing ? 'is-live' : ''}`}>
            {withSound
              ? tx('delayed', lang).replace('{n}', String(delay ?? 25))
              : ps.playing ? `${tx('realtime', lang)}${delay ? ` · ~${delay}s` : ''}` : tx('frames', lang)}
          </span>
          <span className="livescreen__spacer" />
          <button
            type="button"
            className={`livescreen__btn ${withSound ? 'is-on' : ''}`}
            onClick={sound.toggle}
            disabled={!audioUsable}
            aria-pressed={withSound}
            title={!audioUsable ? tx('noAudio', lang) : withSound ? tx('soundOff', lang) : tx('soundOn', lang)}
            aria-label={withSound ? tx('soundOff', lang) : tx('soundOn', lang)}
          >
            <SpeakerIcon on={withSound} />
          </button>
          <input
            type="range"
            className="livescreen__vol"
            min={0}
            max={1}
            step={0.05}
            value={withSound ? sound.volume : 0}
            onChange={(e) => sound.setVolume(Number(e.target.value))}
            disabled={!audioUsable}
            aria-label={tx('volume', lang)}
            style={{ ['--vol' as string]: `${Math.round((withSound ? sound.volume : 0) * 100)}%` }}
          />
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
