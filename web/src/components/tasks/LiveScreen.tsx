import { useEffect, useState } from 'react';
import { InfoIcon } from './InfoIcon.tsx';
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
  tapHere: ['直接點這裡', 'Tap here now'],
  dragHere: ['直接照這樣拖', 'Drag like this now'],
  sending: ['送出中…', 'Sending…'],
  cancel: ['取消', 'Cancel'],
  pointSent: ['已送出,馬上在裝置上點擊', 'Sent — tapping on the device now'],
  dragSent: ['已送出,馬上在裝置上拖曳', 'Sent — dragging on the device now'],
  dragTime: ['拖曳 {s} 秒', '{s}s drag'],
  takeover: ['接管(自己操作)', 'Take over (drive it yourself)'],
  takeoverOn: ['接管中 · AI 已暫停', 'You are driving · AI paused'],
  takeoverHint: ['直接點或拖畫面就會立刻執行,不用再按送出。AI 在接管期間不會動作,也不計費。', 'Click or drag the screen and it runs immediately — no submit needed. The AI is paused and not billed while you drive.'],
  takeoverBusy: ['執行中…', 'Running…'],
  takeoverFail: ['送不出去,請再試一次', 'Could not send — try again'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];

/** 接管模式的圖示:一隻手(= 我自己來)。 */
function HandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
      <path d="M11 11.5V4.5a1.5 1.5 0 0 1 3 0V12" />
      <path d="M14 11.5v-1a1.5 1.5 0 0 1 3 0V16a5 5 0 0 1-5 5h-1a6 6 0 0 1-6-6v-2.5a1.5 1.5 0 0 1 3 0" />
    </svg>
  );
}

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
  takeover,
  onTakeover,
  onTakeoverGesture,
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
  /** 「直接點這裡」:只送位置,runner 直接在裝置上執行(不經 AI)。 */
  onSendPoint?: (p: PickPoint) => Promise<void>;
  /** 接管模式開著嗎(AI 暫停,由測試人員自己操作)。 */
  takeover?: boolean;
  /** 切換接管模式。 */
  onTakeover?: (enabled: boolean) => Promise<void>;
  /** 接管中的手勢:點了就直接送出執行(不用再按送出)。 */
  onTakeoverGesture?: (p: PickPoint) => Promise<void>;
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
  // 接管中:整個畫面一直可操作,點了就直接執行(不需要先開「指定點擊」、也不用按送出)。
  // 非接管:「指定點擊」要使用者主動開啟;平常觀看不顯示藍框,點畫面仍是開新視窗。
  const takeoverOn = !!takeover;
  const pickable = isLive && (takeoverOn ? !!onTakeoverGesture : (!!onPoint && pickMode));
  const [tkBusy, setTkBusy] = useState(0);   // 飛行中的手勢數(連續點擊不互相阻擋)
  const [tkErr, setTkErr] = useState(false);
  const [tkToggling, setTkToggling] = useState(false);

  // 接管中的手勢:立刻送出。刻意不因為「上一個還沒回」就擋住下一個 ——
  // 手動操作常是連續快點,擋住會讓人以為沒反應;每筆各自有 id,runner 依序執行。
  async function runTakeoverGesture(p: PickPoint) {
    if (!onTakeoverGesture) return;
    setTkErr(false);
    setTkBusy((n) => n + 1);
    try { await onTakeoverGesture(p); } catch { setTkErr(true); } finally { setTkBusy((n) => Math.max(0, n - 1)); }
  }

  async function toggleTakeover() {
    if (!onTakeover || tkToggling) return;
    setTkToggling(true);
    try {
      await onTakeover(!takeoverOn);
      if (!takeoverOn) { setPickMode(false); onPoint?.(null); } // 進接管就關掉「指定點擊」,避免兩套操作混在一起
    } catch { setTkErr(true); } finally { setTkToggling(false); }
  }

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
      {...(pickable
        ? {
            // 接管中直接執行;非接管維持「先選位置、再按送出」(那時可以附一句文字說明給 AI)。
            onPick: (p: PickPoint) => { if (takeoverOn) void runTakeoverGesture(p); else onPoint!(p); },
            marker: takeoverOn ? null : (point ?? null),
          }
        : {})}
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
        {takeoverOn && <span className="livescreen__hint">{tx('takeoverHint', lang)}</span>}
        {!takeoverOn && pickable && !point && !sentAt && <span className="livescreen__hint">{tx('pickHint', lang)}</span>}
        {sentAt > 0 && <span className="livescreen__note is-ok" role="status">{tx(sentDrag ? 'dragSent' : 'pointSent', lang)}</span>}
        {!takeoverOn && pickable && point && (
          <div className="livescreen__pick" role="group" aria-label={tx(point.to ? 'dragTitle' : 'pickTitle', lang)}>
            <span className="livescreen__pick-pos">
              {point.to ? '↗' : <InfoIcon name="pin" size={13} />} {formatPick(point)}
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
          {takeoverOn && (
            <span className="livescreen__takeover" role="status">
              {tx('takeoverOn', lang)}{tkBusy > 0 ? ` · ${tx('takeoverBusy', lang)}` : ''}
            </span>
          )}
          {tkErr && <span className="livescreen__note is-bad" role="alert">{tx('takeoverFail', lang)}</span>}
          <span className="livescreen__spacer" />
          {onTakeover && (
            <button
              type="button"
              className={`livescreen__btn ${takeoverOn ? 'is-on' : ''}`}
              onClick={() => void toggleTakeover()}
              disabled={tkToggling}
              aria-pressed={takeoverOn}
              title={tx('takeover', lang)}
              aria-label={tx('takeover', lang)}
            >
              <HandIcon />
            </button>
          )}
          {/* 接管中不顯示「指定點擊」:兩套操作邏輯混在一起會讓人不知道點了會發生什麼事。 */}
          {onPoint && !takeoverOn && (
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
