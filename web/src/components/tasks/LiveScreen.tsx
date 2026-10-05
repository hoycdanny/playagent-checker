import { useState } from 'react';
import type { RLang } from '../report/reportText.ts';
import { LivePlayer, type LivePlayerState } from './LivePlayer.tsx';
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
export function openLivePopout(jobId: string) {
  const h = Math.min(980, window.screen.availHeight - 40);
  const w = Math.round(h * 0.52);
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
}) {
  const sound = useLiveSound();
  const [ps, setPs] = useState<LivePlayerState>({ playing: false });
  const audioUsable = audioState !== 'unavailable';
  const withSound = sound.on && audioUsable;
  const mode = withSound ? 'audio' : 'live';
  const delay = ps.delaySec !== undefined ? Math.max(1, Math.round(ps.delaySec)) : undefined;

  return (
    <div className={`livescreen ${className ?? ''}`}>
      <div className="livescreen__stage">
        {popout ? (
          <button type="button" className="livescreen__click" onClick={() => openLivePopout(jobId)} title={tx('popout', lang)} aria-label={tx('popout', lang)}>
            <LivePlayer jobId={jobId} isLive={isLive} source={mode} muted={!withSound} volume={sound.volume} fallbackUrl={fallbackUrl ?? null} alt={alt} onState={setPs} />
          </button>
        ) : (
          <LivePlayer jobId={jobId} isLive={isLive} source={mode} muted={!withSound} volume={sound.volume} fallbackUrl={fallbackUrl ?? null} alt={alt} onState={setPs} />
        )}
        {withSound && isLive && !ps.playing && <span className="livescreen__note">{tx('waitingAudio', lang)}</span>}
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
            <button type="button" className="livescreen__btn" onClick={() => openLivePopout(jobId)} title={tx('popout', lang)} aria-label={tx('popout', lang)}>
              <PopoutIcon />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
