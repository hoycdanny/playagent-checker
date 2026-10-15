import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useJobStream } from '../api/useJobStream.ts';
import { apiGet, apiPost, type ListResponse } from '../api/client.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import { OperatorChat } from '../components/tasks/OperatorChat.tsx';
import { ScriptPanel } from '../components/tasks/ScriptPanel.tsx';
import { TaskInfoStrip } from '../components/tasks/TaskInfoStrip.tsx';
import { BootTimeline } from '../components/tasks/BootTimeline.tsx';
import { InfoIcon } from '../components/tasks/InfoIcon.tsx';
import { LiveScreen } from '../components/tasks/LiveScreen.tsx';
import { gestureBody, type PickPoint } from '../components/tasks/LivePlayer.tsx';
import { StepSound } from '../components/tasks/StepSound.tsx';
import { RecordingPlayer, type SeekRequest } from '../components/tasks/RecordingPlayer.tsx';
import { DeviceLogsPanel } from '../components/tasks/DeviceLogsPanel.tsx';
import { TaskAskPanel } from '../components/tasks/TaskAskPanel.tsx';
import { soundInWindow, useAudioLevels } from '../components/tasks/audioLevels.ts';
import { reportLang, type RLang } from '../components/report/reportText.ts';
import { outcomeKey, outcomeOf, outcomeTip } from '../components/outcome.ts';
import { MemoryUsagePanel, StepMemoryChips } from '../components/tasks/MemoryUsagePanel.tsx';
import './ListPage.css';
import './TaskDetailPage.css';

interface KbSummary {
  id: string;
  name: string;
}

/** 把任意值安全轉成可渲染字串;非 string/number/boolean 一律字串化,避免把物件/陣列當
 *  React child 直接渲染而丟出未捕捉例外(長任務的 step 欄位型別偶爾會跑掉,例如模型
 *  輸出異常或 runner 版本差異造成 thinking 不是純字串)。 */
function asText(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** 狀態訊息開頭的「第 N 步:」/「Step N:」與標題列步數重複,去掉。 */
export function stripStepPrefix(msg: string | undefined | null): string {
  return String(msg ?? '').replace(/^\s*(第\s*\d+\s*步|Step\s*\d+)\s*[:：]\s*/i, '');
}

/** 本頁新增文案(zh/en)。 */
const PT = {
  progress: ['第 {n} 步', 'Step {n}'],
  limit: ['上限 {m}', 'of {m}'],
  newestFirst: ['最新在上', 'Newest first'],
  current: ['目前', 'Now'],
  stepCount: ['{n} 步', '{n} steps'],
  booting: ['啟動中…', 'Starting…'],
  bootingDevicefarm: ['真機啟動中…', 'Starting the device…'],
  bootingEmulator: ['Android 容器啟動中…', 'Starting the Android container…'],
  bootingWeb: ['瀏覽器啟動中…', 'Starting the browser…'],
  bootingWindows: ['Windows 主機啟動中…', 'Starting the Windows host…'],
  bootingHint: ['畫面就緒後會自動出現。', 'The screen appears automatically once ready.'],
  bootingHintDevicefarm: ['Device Farm 開機通常需要 3–5 分鐘,畫面就緒後會自動出現。', 'Device Farm usually takes 3–5 minutes; the screen appears automatically.'],
  bootingHintEmulator: ['正在準備 Android 容器(Redroid 雲端主機),畫面就緒後會自動出現。', 'Preparing the Android container (Redroid cloud host); the screen appears automatically.'],
  bootingHintWeb: ['正在啟動雲端瀏覽器,畫面就緒後會自動出現。', 'Starting the cloud browser; the screen appears automatically.'],
  bootingHintWindows: ['Windows 主機(GameLift Streams)首次啟動約需 10–15 分鐘,畫面就緒後會自動出現。', 'The Windows host (GameLift Streams) takes about 10–15 minutes on first start; the screen appears automatically.'],
  replay: ['回放', 'Replay'],
  chat: ['與控制遊戲 Agent 互動', 'Interact with the game-control Agent'],
  goalHint: ['決策 Agent 給這一步的目標', 'Goal set by the Decision Agent for this step'],
  scriptStep: ['腳本 {n}/{m}', 'Script {n}/{m}'],
  effectHint: ['輔助 Agent 判斷這一步的動作有沒有生效', 'Helper Agent verdict on whether this action worked'],
  effectOk: ['✓ 有效', '✓ Worked'],
  effectNone: ['✕ 沒有反應', '✕ No effect'],
  effectOther: ['⚠ 畫面不如預期', '⚠ Unexpected'],
  suspectValue: ['⚠ 疑似讀錯 {k}={v}(前一筆 #{s} = {p})', '⚠ Likely misread {k}={v} (previous #{s} = {p})'],
  betChanged: ['⚠ 投注額變更 {f} → {t}(第 {s} 步起)', '⚠ Bet changed {f} → {t} (since step {s})'],
  segment: ['第 {n} 段連線', 'Session {n}'],
  replayStep: ['回放第 {n} 步(含聲音)', 'Replay step {n} with sound'],
  stop: ['停止測試', 'Stop test'],
  stopping: ['停止中…', 'Stopping…'],
  stopConfirm: ['確定要停止這次測試嗎?AI 會在目前這一步結束後停下並釋放裝置,已完成的步驟和截圖都會保留。', 'Stop this test? The AI stops after the current step and releases the device. Completed steps and screenshots are kept.'],
  stopFailed: ['停止失敗:', 'Could not stop: '],
  stopSent: ['已送出停止,AI 會在這一步結束後停下。', 'Stop requested. The AI stops after the current step.'],
} as const;
const pt = (k: keyof typeof PT, lang: RLang) => PT[k][lang === 'zh' ? 0 : 1];

/** 執行軌跡每一步的日期時間(使用者當地時區,依介面語言格式化),例如 2026/10/08 14:30:45。 */
export function stepTime(iso: string, locale: string): string {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d);
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
}

/** 開機中的標題/說明依執行環境而定(不是每個任務都跑 Device Farm);未知後端用通用文案。 */
const BOOT_SUFFIX: Record<string, 'Devicefarm' | 'Emulator' | 'Web' | 'Windows'> = {
  devicefarm: 'Devicefarm',
  emulator: 'Emulator',
  web: 'Web',
  windows: 'Windows',
};
export function bootText(backend: string | undefined, lang: RLang): { title: string; hint: string } {
  const s = backend ? BOOT_SUFFIX[backend] : undefined;
  return {
    title: pt(s ? (`booting${s}` as const) : 'booting', lang),
    hint: pt(s ? (`bootingHint${s}` as const) : 'bootingHint', lang),
  };
}

export default function TaskDetailPage() {
  const { t, locale } = useI18n();
  const lang = reportLang(locale);
  const { jobId } = useParams<{ jobId: string }>();
  const { state, verdict, message, steps, meta, appId, backend, createdAt, boot, updatedAt, script, connected, loading } = useJobStream(jobId ?? null);
  // 停止測試:POST /tasks/{id}/cancel(runner 在目前這一步結束後停下並釋放裝置)。
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  async function stopTest() {
    if (!jobId || stopping) return;
    if (!window.confirm(pt('stopConfirm', lang))) return;
    setStopping(true);
    setStopError(null);
    try {
      await apiPost(`/tasks/${encodeURIComponent(jobId)}/cancel`, {});
    } catch (err) {
      setStopError(`${pt('stopFailed', lang)}${err instanceof Error ? err.message : String(err)}`);
      setStopping(false);
    }
  }

  // 知識庫 id → 名稱對照(供資訊列以人類可讀名稱呈現)。
  const [kbNames, setKbNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    apiGet<ListResponse<KbSummary>>('/knowledge-bases')
      .then((r) => setKbNames(new Map(r.items.map((k) => [k.id, k.name]))))
      .catch(() => {});
  }, []);

  // 即時畫面串流:任務執行中(非終局)輪詢 live-frame,拿短效 presigned URL 換 <img>。
  // runner 持續覆寫同一 live 幀;URL 每次不同以繞過快取。任務終局即停止輪詢。
  const TERMINAL_STATES = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);
  const isLive = !TERMINAL_STATES.has(state) && state !== 'queued';
  const [liveFrameUrl, setLiveFrameUrl] = useState<string | null>(null);
  // 測試人員在即時畫面上選的位置(可「直接點這裡」在裝置上執行,或在聊天室加說明一起送)。
  const [pickPoint, setPickPoint] = useState<PickPoint | null>(null);
  async function sendPoint(p: PickPoint) {
    if (!jobId) return;
    await apiPost(`/tasks/${jobId}/commands`, { ...gestureBody(p), remember: false, ...(latestScreen ? { screen: latestScreen } : {}) });
    setChatRefresh((n) => n + 1);
  }
  const [chatRefresh, setChatRefresh] = useState(0);
  // 下指令區預設收合(在畫面上點了位置時自動展開,方便補一句說明)。
  const [chatOpen, setChatOpen] = useState(false);
  useEffect(() => {
    if (!jobId || !isLive) {
      setLiveFrameUrl(null);
      return;
    }
    // 依序抓幀:簽 URL → 背景預載(new Image)→ 載完才換上 <img> → 再抓下一幀。
    // 直接每 250ms 換 src 的話,幀還沒下載完就被下一張取消,畫面會看似凍結(需手動刷新)。
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 截圖幀只是影片段落的備援(web 後端仍以截圖串流為主),約 2fps。
    const MIN_INTERVAL_MS = 500;
    const preload = (url: string) =>
      new Promise<boolean>((resolve) => {
        const img = new Image();
        const tm = setTimeout(() => resolve(false), 8000);
        img.onload = () => { clearTimeout(tm); resolve(true); };
        img.onerror = () => { clearTimeout(tm); resolve(false); };
        img.src = url;
      });
    const loop = async () => {
      const started = Date.now();
      let ok = false;
      try {
        const { url } = await apiGet<{ url: string }>(`/tasks/${jobId}/live-frame`);
        if (url && !cancelled && (await preload(url)) && !cancelled) {
          setLiveFrameUrl(url);
          ok = true;
        }
      } catch {
        /* 幀尚未產生/暫時失敗:保留上一幀,不清空 */
      }
      if (cancelled) return;
      const wait = ok ? Math.max(0, MIN_INTERVAL_MS - (Date.now() - started)) : 1500;
      timer = setTimeout(() => void loop(), wait);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, isLive]);

  // 即時畫面回退:取「最新一張有截圖的步驟」(live 幀尚未產生或任務已結束時顯示)。
  const latestShot = [...steps]
    .reverse()
    .find((s) => s.annotatedUrl || s.screenshotUrl);
  const liveUrl = asText(latestShot?.annotatedUrl) ?? asText(latestShot?.screenshotUrl);
  const latestStep = steps[steps.length - 1];
  // 最新一步的畫面名稱:即時指令「記住」時當作提示的畫面範圍,也顯示在即時畫面下方。
  // 略過回應無法解析的步驟(畫面名只是「畫面 87」這種流水號),取最近一個 AI 真的辨識過的畫面。
  const latestScreen = asText([...steps].reverse().find((s) => s.screen && !s.parseFailed)?.screen);
  // 終局後仍顯示指令紀錄(若本次有下過指令)。
  const hasCommands = steps.some((s) => Array.isArray(s.operatorCommands) && s.operatorCommands.length > 0);
  const showChat = !!jobId && (isLive || hasCommands);
  const stepNo = latestStep ? latestStep.index + 1 : 0;
  // 遊戲音效音量時間軸(Device Farm 真機才有):標出每一步有沒有音效。
  const audioLevels = useAudioLevels(jobId, isLive, backend === 'devicefarm');
  const hasAudio = !!audioLevels && audioLevels.chunks.length > 0;
  // 測試結束後的整場錄影(含聲音)回放;點執行軌跡的「回放」跳到那一步。
  const hasRecording = !isLive && !!audioLevels?.chunks.some((c) => typeof c.url === 'string' && c.dur > 0);
  const [seek, setSeek] = useState<SeekRequest | null>(null);
  const [playingStep, setPlayingStep] = useState<number | null>(null);
  // 音效事件要標上「第幾步 / 哪個畫面」。
  const soundStepRefs = useMemo(
    () => steps
      .filter((s) => typeof s.at === 'string')
      .map((s) => ({ index: s.index, t: Date.parse(s.at as string), ...(s.screen && !s.parseFailed ? { screen: String(s.screen) } : {}) }))
      .filter((m) => Number.isFinite(m.t)),
    [steps],
  );
  const stepMarks = useMemo(
    () => steps.filter((s) => typeof s.at === 'string').map((s) => ({ index: s.index, t: Date.parse(s.at as string) })).filter((m) => Number.isFinite(m.t)),
    [steps],
  );

  return (
    <section className="listpage detail">
      {/* 標題列(一行):返回 + 標題 + 狀態 + 步數 + 目前動作 + 任務資訊 + 報告 / 連線狀態 */}
      <header className="detail__head">
        <div className="detail__head-row">
          {/* 回到這個任務所屬應用的「測試任務」分頁(不知道應用時退回總任務清單)。 */}
          <Link
            to={appId ? `/apps/${encodeURIComponent(appId)}?tab=tasks` : '/tasks'}
            className="detail__back detail__back--icon"
            aria-label={t('detail.back')}
            title={t('detail.back')}
          >
            <span aria-hidden="true">←</span>
          </Link>
          <h1 className="detail__title">{t('detail.title')}</h1>
          {/* 測試結論(與報告封面同一個值);沒有結論(執行中 / 舊任務)才顯示執行狀態。 */}
          <span
            className={`detail__pill detail__pill--${outcomeOf({ state, ...(verdict ? { verdict } : {}) })}`}
            title={outcomeTip({ state, ...(verdict ? { verdict } : {}) }, (k) => t(k), lang)}
          >
            {t(outcomeKey(outcomeOf({ state, ...(verdict ? { verdict } : {}) })))}
          </span>
          {verdict && (
            <span className="detail__exec" title={t('outcome.execution')}>
              {t('outcome.execution')}:{t(`state.${state}` as MessageKey)}
            </span>
          )}
          {stepNo > 0 && (
            <span className="detail__progress">
              {pt('progress', lang).replace('{n}', String(stepNo))}
              {meta?.maxSteps ? ` · ${pt('limit', lang).replace('{m}', String(meta.maxSteps))}` : ''}
            </span>
          )}
          {/* 目前狀態訊息:放在標題列步數後面,淺灰色(終局狀態以 ARIA live region 通報,Req 11.3) */}
          {/* 狀態訊息去掉開頭重複的「第 N 步:」(步數已在左邊) */}
          <span className="detail__state" role="status" aria-live="polite" title={message ?? undefined}>
            <span className="visually-hidden">{t(`state.${state}` as MessageKey)}{message ? ' — ' : ''}</span>
            {stripStepPrefix(message)}
          </span>
          <TaskInfoStrip meta={meta} kbNames={kbNames} />
          <span className="detail__head-end">
            {/* 執行中 / 排隊中可停止。 */}
            {jobId && !TERMINAL_STATES.has(state) && (
              <button type="button" className="detail__stop" onClick={() => void stopTest()} disabled={stopping} aria-busy={stopping}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><rect x="1.5" y="1.5" width="9" height="9" rx="1.5" fill="currentColor" /></svg>
                {stopping ? pt('stopping', lang) : pt('stop', lang)}
              </button>
            )}
            {/* 任務結束後直接進結構化測試報告(判定明細、截圖、修正建議)。 */}
            {jobId && TERMINAL_STATES.has(state) && state !== 'cancelled' && (
              <Link to={`/reports/${jobId}`} className="detail__report-link">
                {t('detail.viewReport')} →
              </Link>
            )}
            {/* 即時連線狀態:只用圖示(滑過 / 讀屏顯示文字) */}
            <span
              className={`detail__conn detail__conn--icon ${connected ? 'detail__conn--on' : 'detail__conn--off'}`}
              role="img"
              aria-label={connected ? t('detail.connected') : t('detail.disconnected')}
              title={connected ? t('detail.connected') : t('detail.disconnected')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <circle cx="12" cy="20" r="1" fill="currentColor" />
                {!connected && <path d="M2 2l20 20" />}
              </svg>
            </span>
          </span>
        </div>
        {stopError && <p className="detail__triage detail__triage--error" role="alert">{stopError}</p>}
        {stopping && !TERMINAL_STATES.has(state) && <p className="detail__stop-note" role="status">{pt('stopSent', lang)}</p>}
        {/* 測試結論的理由(驗收標準;細節在報告的「驗收結論與標準」)。 */}
        {verdict && verdict.status !== 'PASS' && (
          <p className={`detail__triage detail__triage--${verdict.status === 'FAIL' ? 'fail' : 'error'}`}>
            {t('outcome.verdict')}:{verdict.reason[lang] ?? verdict.reason.zh}
          </p>
        )}
        {/* 成因引導(Req 12.3):fail → 被測 App/案例;error → 環境/基礎設施 */}
        {!verdict && state === 'fail' && (
          <p className="detail__triage detail__triage--fail">{t('trend.triageFail')}</p>
        )}
        {state === 'error' && (
          <p className="detail__triage detail__triage--error">{t('trend.triageError')}</p>
        )}
      </header>

      {/* 主區三欄:即時畫面 | 下指令 + 測試腳本 | 執行軌跡(窄螢幕自動改兩欄 / 單欄) */}
      <div className="detail__layout">
        {/* 即時畫面:執行中顯示串流幀;否則回退最新步驟截圖。 */}
        <section className="detail__col detail__col--live" aria-labelledby="detail-live-title">
          <h2 id="detail-live-title" className="detail__panel-title">
            {t('detail.liveView')}
            {isLive && (liveFrameUrl || latestStep) && <span className="detail__live-badge">{t('detail.liveBadge')}</span>}
          </h2>
          {/* 啟動時間軸:Device Farm 開機各階段 + 啟動/執行計時 */}
          <BootTimeline
            state={state}
            lang={lang}
            {...(boot ? { boot } : {})}
            {...(createdAt ? { createdAt } : {})}
            {...(updatedAt ? { updatedAt } : {})}
            {...(backend ? { backend } : {})}
          />
          {isLive && jobId && (liveFrameUrl || liveUrl || latestStep) ? (
            // 即時影片(2 秒分段、30+ fps);聲音開啟時改播含音效段落。點畫面 → 新視窗(雙螢幕)。
            <LiveScreen
              jobId={jobId}
              isLive={isLive}
              fallbackUrl={liveFrameUrl ?? liveUrl ?? null}
              alt={latestScreen ?? t('detail.liveView')}
              lang={lang}
              point={pickPoint}
              onPoint={setPickPoint}
              onSendPoint={sendPoint}
              {...(audioLevels?.state ? { audioState: audioLevels.state } : {})}
            />
          ) : hasRecording && audioLevels ? (
            <RecordingPlayer levels={audioLevels} steps={stepMarks} lang={lang} seek={seek} onStep={setPlayingStep} />
          ) : liveUrl ? (
            <figure className="detail__screen">
              <img src={liveUrl} alt={asText(latestShot?.screen) ?? t('detail.liveView')} />
            </figure>
          ) : isLive || state === 'queued' ? (
            // 開機中還沒有畫面:顯示手機外框 + 目前階段,不要只有一行字。
            <div className="detail__booting" role="status">
              <div className="detail__booting-phone" aria-hidden="true">
                <InfoIcon name={boot?.phase === 'connect' ? 'plug' : boot?.phase === 'upload' ? 'upload' : boot?.phase === 'download' ? 'package' : boot?.phase === 'device' ? 'phone' : 'cloud'} size={30} />
                <span className="detail__booting-ring" />
              </div>
              <p className="detail__booting-text">{message || bootText(backend, lang).title}</p>
              <p className="detail__booting-sub">{bootText(backend, lang).hint}</p>
            </div>
          ) : (
            <div className="detail__no-live">{t('detail.noLiveView')}</div>
          )}
          {/* 目前畫面 + 最新動作(看畫面時不必轉頭看軌跡) */}
          {latestStep && (
            <div className="detail__now">
              <span className="detail__now-label">{pt('current', lang)}</span>
              {latestScreen && <span className="detail__now-screen">{latestScreen}</span>}
              {asText(latestStep.action) && <span className="detail__step-action">{asText(latestStep.action)}</span>}
            </div>
          )}
          {/* 即時畫面底下:與控制遊戲 Agent 互動 + 測試腳本(皆可收合,讓畫面保持最大) */}
          <div className="detail__live-ops">
            {showChat && (
              <div className="detail__fold">
                <button
                  type="button"
                  className="detail__fold-btn"
                  aria-expanded={chatOpen || !!pickPoint}
                  aria-controls="detail-chat-body"
                  onClick={() => setChatOpen((v) => !v)}
                >
                  <span aria-hidden="true">{chatOpen || pickPoint ? '▾' : '▸'}</span> {pt('chat', lang)}
                </button>
                {(chatOpen || !!pickPoint) && (
                  <div id="detail-chat-body">
                    <OperatorChat
                      jobId={jobId!}
                      isLive={isLive}
                      {...(latestScreen ? { currentScreen: latestScreen } : {})}
                      {...(appId ? { appId } : {})}
                      point={pickPoint}
                      onClearPoint={() => setPickPoint(null)}
                      refreshKey={chatRefresh}
                    />
                  </div>
                )}
              </div>
            )}
            <ScriptPanel
              lang={lang}
              live={isLive}
              {...(script ? { progress: script } : {})}
              {...(meta?.script ?? meta?.task ? { script: meta?.script ?? meta?.task } : {})}
              {...(meta?.caseName ? { caseName: meta.caseName } : {})}
              {...(meta?.caseVersion ? { caseVersion: meta.caseVersion } : {})}
            />
          </div>
        </section>

        {/* 中:執行軌跡(由新到舊) */}
        <section className="detail__col detail__col--trace" aria-labelledby="detail-trace-title">
          <h2 id="detail-trace-title" className="detail__panel-title">
            {t('detail.trace')}
            {steps.length > 0 && (
              <span className="detail__panel-sub">
                {pt('stepCount', lang).replace('{n}', String(steps.length))} · {pt('newestFirst', lang)}
              </span>
            )}
          </h2>
          {loading && steps.length === 0 ? (
            <div className="listpage__skeleton" aria-hidden="true">
              <div className="listpage__skeleton-row" />
            </div>
          ) : steps.length === 0 ? (
            <p className="detail__no-steps">{t('detail.noSteps')}</p>
          ) : (
            <>
            <MemoryUsagePanel steps={steps} lang={lang} />
            <ol className="detail__steps" reversed>
              {[...steps].reverse().map((s, k) => {
                const thumb = asText(s.annotatedUrl) ?? asText(s.screenshotUrl);
                const screenText = asText(s.screen);
                const actionText = asText(s.action);
                const thinkingText = asText(s.thinking);
                const urlText = asText(s.url);
                const titleText = asText(s.observedTitle);
                const opCmds = Array.isArray(s.operatorCommands)
                  ? (s.operatorCommands as Array<{ id?: unknown; text?: unknown }>)
                      .map((c) => asText(c?.text))
                      .filter((x): x is string => !!x)
                  : [];
                return (
                  <li key={s.index} className={`detail__step ${k === 0 && !hasRecording ? 'detail__step--latest' : ''} ${hasRecording && playingStep === s.index ? 'detail__step--playing' : ''}`}>
                    {thumb && (
                      <a href={thumb} target="_blank" rel="noreferrer" className="detail__step-thumb">
                        <img src={thumb} alt={screenText ?? `step ${s.index}`} loading="lazy" />
                      </a>
                    )}
                    <div className="detail__step-text">
                      <div className="detail__step-head">
                        <span className="detail__step-idx">#{s.index}</span>
                        {typeof s.at === 'string' && Number.isFinite(Date.parse(s.at)) && (
                          <time className="detail__step-time" dateTime={s.at} title={new Date(s.at).toString()}>
                            {stepTime(s.at, locale)}
                          </time>
                        )}
                        {screenText && <span className="detail__step-screen">{screenText}</span>}
                        {actionText && <span className="detail__step-action">{actionText}</span>}
                        {hasAudio && typeof s.at === 'string' && (() => {
                          // 這一步的時間窗:本步開始 → 下一步開始(最新一步用本步耗時)。
                          const from = Date.parse(s.at as string);
                          const next = steps.find((x) => x.index === s.index + 1);
                          const to = next && typeof next.at === 'string'
                            ? Date.parse(next.at as string)
                            : from + (typeof s.durationMs === 'number' ? (s.durationMs as number) : 8000);
                          return <StepSound s={soundInWindow(audioLevels, from, to)} lang={lang} />;
                        })()}
                        {hasRecording && typeof s.at === 'string' && (
                          <button
                            type="button"
                            className="detail__step-replay"
                            onClick={() => setSeek((p) => ({ t: Date.parse(s.at as string), n: (p?.n ?? 0) + 1 }))}
                            aria-label={pt('replayStep', lang).replace('{n}', String(s.index))}
                          >
                            ▶ {pt('replay', lang)}
                          </button>
                        )}
                      </div>
                      {(() => {
                        // 決策 Agent 給這一步的目標 + 輔助 Agent 判斷這一步的動作有沒有生效。
                        const plan = s.plan as { goal?: unknown; scriptStep?: unknown; scriptTotal?: unknown } | undefined;
                        const review = s.review as { effect?: unknown; note?: unknown } | undefined;
                        const goal = asText(plan?.goal);
                        const effect = asText(review?.effect);
                        const effectKey = effect === 'ok' ? 'effectOk' : effect === 'no_effect' ? 'effectNone' : effect === 'unexpected' ? 'effectOther' : null;
                        // runner 即時數值把關(疑似讀錯 / 投注額變更),每筆都標出前後步驟與數值。
                        const warnings = Array.isArray(s.warnings) ? (s.warnings as Array<Record<string, unknown>>) : [];
                        const nf = (v: unknown) => (typeof v === 'number' ? v.toLocaleString() : String(v ?? '?'));
                        const warnText = warnings.map((w) => {
                          if (w.kind === 'suspect_value') {
                            const prev = w.prev as { step?: unknown; value?: unknown } | undefined;
                            return pt('suspectValue', lang).replace('{k}', String(w.key)).replace('{v}', nf(w.value)).replace('{s}', String(prev?.step ?? '?')).replace('{p}', nf(prev?.value));
                          }
                          if (w.kind === 'bet_changed') return pt('betChanged', lang).replace('{f}', nf(w.from)).replace('{t}', nf(w.to)).replace('{s}', String(w.sinceStep ?? '?'));
                          return null;
                        }).filter((x): x is string => !!x);
                        const seg = typeof s.segment === 'number' && (s.segment as number) > 1 ? (s.segment as number) : null;
                        if (!goal && !effectKey && warnText.length === 0 && !seg) return null;
                        return (
                          <div className="detail__step-team">
                            {seg && <span className="detail__step-effect">{pt('segment', lang).replace('{n}', String(seg))}</span>}
                            {warnText.map((w, j) => <span key={j} className="detail__step-effect is-unexpected">{w}</span>)}
                            {goal && (
                              <span className="detail__step-goal" title={pt('goalHint', lang)}>
                                🎯 {typeof plan?.scriptStep === 'number' && typeof plan?.scriptTotal === 'number' && (plan.scriptTotal as number) > 1
                                  ? `${pt('scriptStep', lang).replace('{n}', String(plan.scriptStep)).replace('{m}', String(plan.scriptTotal))} · `
                                  : ''}
                                {goal}
                              </span>
                            )}
                            {effectKey && (
                              <span className={`detail__step-effect is-${effect}`} title={asText(review?.note) ?? pt('effectHint', lang)}>
                                {pt(effectKey, lang)}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      <StepMemoryChips memory={s.memory} lang={lang} />
                      {opCmds.map((txt, j) => (
                        <div key={j} className="detail__step-opcmd">
                          <span aria-hidden="true">💬</span> {txt}
                        </div>
                      ))}
                      {thinkingText && <div className="detail__step-think">{thinkingText}</div>}
                      {urlText && <div className="detail__step-url">{urlText}</div>}
                      {typeof s.httpStatus === 'number' && <div>HTTP {s.httpStatus}</div>}
                      {titleText && <div className="detail__step-title">{titleText}</div>}
                    </div>
                  </li>
                );
              })}
            </ol>
            </>
          )}
          {/* AI 問答:放在執行軌跡下方(同一欄,軌跡區縮小讓出空間,整頁維持一屏) */}
          {jobId && <TaskAskPanel jobId={jobId} lang={lang} />}
        </section>

        {/* 右:日誌檢視(裝置系統 Log / 音效播放狀態 / 三個 AI Agent,由新到舊) */}
        {/* 裝置 log:Device Farm 真機與 Android 容器(Redroid)的 runner 都會上傳 devlogs/logcat。 */}
        {jobId && (
          <section className="detail__col detail__col--devlogs">
            <DeviceLogsPanel
              jobId={jobId}
              isLive={isLive}
              device={backend === 'devicefarm' || backend === 'emulator'}
              {...(appId ? { appId } : {})}
              seats={meta?.seats ?? []}
              {...(meta?.prices ? { prices: meta.prices } : {})}
              levels={audioLevels}
              steps={soundStepRefs}
              {...(hasRecording ? { onSeek: (t: number) => setSeek((p) => ({ t, n: (p?.n ?? 0) + 1 })) } : {})}
            />
          </section>
        )}
      </div>
    </section>
  );
}
