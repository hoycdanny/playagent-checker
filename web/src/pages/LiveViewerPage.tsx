import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiGet } from '../api/client.ts';
import { useJobStream } from '../api/useJobStream.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import { reportLang } from '../components/report/reportText.ts';
import { LiveScreen } from '../components/tasks/LiveScreen.tsx';
import { useAudioLevels } from '../components/tasks/audioLevels.ts';
import { BootTimeline } from '../components/tasks/BootTimeline.tsx';
import './LiveViewerPage.css';

const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);

/** 彈出式即時畫面(可拖到第二個螢幕):只有畫面、狀態與聲音控制,沒有導覽列。 */
export default function LiveViewerPage() {
  const { t, locale } = useI18n();
  const lang = reportLang(locale);
  const { jobId } = useParams<{ jobId: string }>();
  const { state, message, steps, boot, createdAt, updatedAt, backend } = useJobStream(jobId ?? null);
  const isLive = !TERMINAL.has(state) && state !== 'queued';
  const levels = useAudioLevels(jobId, isLive, true);

  // 沒有影片段落時的截圖幀(與任務詳情頁同一來源)。
  const [frame, setFrame] = useState<string | null>(null);
  useEffect(() => {
    if (!jobId || !isLive) return;
    let stop = false;
    const tick = () => apiGet<{ url: string }>(`/tasks/${jobId}/live-frame`).then((r) => { if (!stop && r.url) setFrame(r.url); }).catch(() => {});
    void tick();
    const tm = setInterval(() => void tick(), 3000);
    return () => { stop = true; clearInterval(tm); };
  }, [jobId, isLive]);

  const last = steps[steps.length - 1];
  const lastShot = [...steps].reverse().find((s) => s.annotatedUrl || s.screenshotUrl);
  const fallback = frame ?? (lastShot ? String(lastShot.screenshotUrl ?? lastShot.annotatedUrl ?? '') : null);
  useEffect(() => { document.title = `▶ ${jobId ?? ''} · PlayAgent`; }, [jobId]);

  if (!jobId) return null;
  return (
    <main className="liveview" aria-label={t('detail.liveView')}>
      <header className="liveview__top">
        <span className={`liveview__pill liveview__pill--${state}`}>{t(`state.${state}` as MessageKey)}</span>
        {last && <span className="liveview__step">#{last.index + 1}{last.screen ? ` · ${String(last.screen)}` : ''}</span>}
      </header>
      {!last && (
        <div className="liveview__boot">
          <BootTimeline state={state} lang={lang} {...(boot ? { boot } : {})} {...(createdAt ? { createdAt } : {})} {...(updatedAt ? { updatedAt } : {})} {...(backend ? { backend } : {})} />
        </div>
      )}
      <LiveScreen
        className="liveview__screen"
        jobId={jobId}
        isLive={isLive}
        fallbackUrl={fallback}
        alt={last?.screen ? String(last.screen) : t('detail.liveView')}
        lang={lang}
        popout={false}
        {...(levels?.state ? { audioState: levels.state } : {})}
      />
      {!isLive && message && <p className="liveview__msg">{message}</p>}
    </main>
  );
}
