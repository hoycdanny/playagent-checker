import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useJobStream } from '../api/useJobStream.ts';
import { apiGet, type ListResponse } from '../api/client.ts';
import { modelLabel } from '../components/modelProvider.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import { OperatorChat } from '../components/tasks/OperatorChat.tsx';
import { ScriptPanel } from '../components/tasks/ScriptPanel.tsx';
import { TaskInfoStrip } from '../components/tasks/TaskInfoStrip.tsx';
import { BootTimeline } from '../components/tasks/BootTimeline.tsx';
import { InfoIcon } from '../components/tasks/InfoIcon.tsx';
import { LiveScreen } from '../components/tasks/LiveScreen.tsx';
import { StepSound } from '../components/tasks/StepSound.tsx';
import { soundInWindow, useAudioLevels } from '../components/tasks/audioLevels.ts';
import { reportLang, type RLang } from '../components/report/reportText.ts';
import './ListPage.css';
import './TaskDetailPage.css';

interface KbSummary {
  id: string;
  name: string;
}

/** 單步模型互動 log(對應後端 traces/<i>.json)。 */
interface TraceLog {
  index: number;
  seat?: string;
  modelId?: string;
  channel?: string;
  ok?: boolean;
  request?: {
    systemChars?: number;
    turnText?: string;
    imageCount?: number;
    imageApproxKB?: number;
    messageTurns?: number;
  };
  rawResponse?: string;
  tokens?: { input?: number; output?: number };
  error?: { name?: string; message?: string };
  at?: string;
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

/** 本頁新增文案(zh/en)。 */
const PT = {
  progress: ['第 {n} 步', 'Step {n}'],
  limit: ['上限 {m}', 'of {m}'],
  newestFirst: ['最新在上', 'Newest first'],
  current: ['目前', 'Now'],
  stepCount: ['{n} 步', '{n} steps'],
  booting: ['真機啟動中…', 'Starting the device…'],
  bootingHint: ['Device Farm 開機通常需要 3–5 分鐘,畫面就緒後會自動出現。', 'Device Farm usually takes 3–5 minutes; the screen appears automatically.'],
} as const;
const pt = (k: keyof typeof PT, lang: RLang) => PT[k][lang === 'zh' ? 0 : 1];

export default function TaskDetailPage() {
  const { t, locale } = useI18n();
  const lang = reportLang(locale);
  const { jobId } = useParams<{ jobId: string }>();
  const { state, message, steps, meta, appId, backend, createdAt, boot, updatedAt, connected, loading } = useJobStream(jobId ?? null);

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
  // 遊戲畫面方向(依即時畫面實際比例):橫向遊戲時放寬即時畫面欄。
  const [landscape, setLandscape] = useState(false);
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

  // 模型互動 Log:點「Log」按鈕才抓(traces/*.json),含每步模型/請求摘要/原始回應/錯誤。
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<TraceLog[] | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  async function loadLogs() {
    if (!jobId) return;
    setLogsLoading(true);
    try {
      const r = await apiGet<ListResponse<TraceLog>>(`/tasks/${jobId}/logs`);
      setLogs(r.items);
    } catch {
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }
  function toggleLogs() {
    const next = !showLogs;
    setShowLogs(next);
    if (next && logs === null) void loadLogs();
  }

  // 即時畫面回退:取「最新一張有截圖的步驟」(live 幀尚未產生或任務已結束時顯示)。
  const latestShot = [...steps]
    .reverse()
    .find((s) => s.annotatedUrl || s.screenshotUrl);
  const liveUrl = asText(latestShot?.annotatedUrl) ?? asText(latestShot?.screenshotUrl);
  const latestStep = steps[steps.length - 1];
  // 最新一步的畫面名稱:即時指令「記住」時當作提示的畫面範圍,也顯示在即時畫面下方。
  const latestScreen = asText([...steps].reverse().find((s) => s.screen)?.screen);
  // 終局後仍顯示指令紀錄(若本次有下過指令)。
  const hasCommands = steps.some((s) => Array.isArray(s.operatorCommands) && s.operatorCommands.length > 0);
  const showChat = !!jobId && (isLive || hasCommands);
  const stepNo = latestStep ? latestStep.index + 1 : 0;
  // 遊戲音效音量時間軸(Device Farm 真機才有):標出每一步有沒有音效。
  const audioLevels = useAudioLevels(jobId, isLive, backend === 'devicefarm');
  const hasAudio = !!audioLevels && audioLevels.chunks.length > 0;

  return (
    <section className="listpage detail">
      <div className="detail__topline">
        <Link to="/tasks" className="detail__back">
          ← {t('detail.back')}
        </Link>
        <div className="detail__topline-right">
          {/* 任務結束後直接進結構化測試報告(判定明細、截圖、修正建議)。 */}
          {jobId && TERMINAL_STATES.has(state) && state !== 'cancelled' && (
            <Link to={`/reports/${jobId}`} className="detail__report-link">
              {t('detail.viewReport')} →
            </Link>
          )}
          <button
            type="button"
            className={`detail__logs-btn ${showLogs ? 'detail__logs-btn--on' : ''}`}
            onClick={toggleLogs}
            aria-expanded={showLogs}
          >
            {showLogs ? t('detail.logsHide') : t('detail.logsShow')}
          </button>
          <span
            className={`detail__conn ${connected ? 'detail__conn--on' : 'detail__conn--off'}`}
          >
            {connected ? t('detail.connected') : t('detail.disconnected')}
          </span>
        </div>
      </div>

      {/* 標題列:狀態 + 進度 + 精簡任務資訊(細節 hover 才顯示),把版面留給即時畫面與執行軌跡 */}
      <header className="detail__head">
        <div className="detail__head-row">
          <h1 className="detail__title">{t('detail.title')}</h1>
          <span className={`detail__pill detail__pill--${state}`}>{t(`state.${state}` as MessageKey)}</span>
          {stepNo > 0 && (
            <span className="detail__progress">
              {pt('progress', lang).replace('{n}', String(stepNo))}
              {meta?.maxSteps ? ` · ${pt('limit', lang).replace('{m}', String(meta.maxSteps))}` : ''}
            </span>
          )}
          <TaskInfoStrip meta={meta} kbNames={kbNames} />
        </div>
        {/* 終局狀態以 ARIA live region 通報(Req 11.3) */}
        <p className="detail__state" role="status" aria-live="polite">
          <span className="visually-hidden">{t(`state.${state}` as MessageKey)}{message ? ' — ' : ''}</span>
          {message ?? ''}
        </p>
        {/* 成因引導(Req 12.3):fail → 被測 App/案例;error → 環境/基礎設施 */}
        {state === 'fail' && (
          <p className="detail__triage detail__triage--fail">{t('trend.triageFail')}</p>
        )}
        {state === 'error' && (
          <p className="detail__triage detail__triage--error">{t('trend.triageError')}</p>
        )}
      </header>

      {/* 模型互動 Log:每步完整記錄(模型/請求摘要/原始回應/token/錯誤),供除錯。 */}
      {showLogs && (
        <section className="detail__logs">
          <h2 className="detail__panel-title">{t('detail.logs')}</h2>
          {logsLoading ? (
            <div className="listpage__skeleton" aria-hidden="true">
              <div className="listpage__skeleton-row" />
            </div>
          ) : !logs || logs.length === 0 ? (
            <p className="detail__no-steps">{t('detail.logsEmpty')}</p>
          ) : (
            <ol className="detail__log-list">
              {logs.map((lg) => (
                <li
                  key={lg.index}
                  className={`detail__log ${lg.ok === false ? 'detail__log--err' : ''}`}
                >
                  <div className="detail__log-head">
                    <span className="detail__log-idx">{t('detail.step')} {lg.index}</span>
                    {lg.seat && <span className="detail__log-seat">{lg.seat}</span>}
                    {lg.modelId && (
                      <span className="detail__log-model" title={lg.modelId}>
                        {modelLabel(lg.modelId)}
                      </span>
                    )}
                    {lg.channel && <span className="detail__log-channel">{lg.channel}</span>}
                    <span className={`detail__log-status ${lg.ok === false ? 'is-err' : 'is-ok'}`}>
                      {lg.ok === false ? t('detail.logFail') : t('detail.logOk')}
                    </span>
                  </div>
                  {/* 請求摘要:送了幾張圖、多大、對話輪數 —— body 太大這類問題一眼可見 */}
                  {lg.request && (
                    <div className="detail__log-row">
                      <span className="detail__log-key">{t('detail.logRequest')}</span>
                      <span className="detail__log-val">
                        {t('detail.logImages')}: {lg.request.imageCount ?? 0}
                        {typeof lg.request.imageApproxKB === 'number'
                          ? ` (~${lg.request.imageApproxKB} KB)`
                          : ''}
                        {typeof lg.request.messageTurns === 'number'
                          ? ` · ${t('detail.logTurns')}: ${lg.request.messageTurns}`
                          : ''}
                      </span>
                    </div>
                  )}
                  {lg.request?.turnText && (
                    <div className="detail__log-row">
                      <span className="detail__log-key">{t('detail.logPrompt')}</span>
                      <span className="detail__log-val detail__log-pre">{lg.request.turnText}</span>
                    </div>
                  )}
                  {lg.error ? (
                    <div className="detail__log-row">
                      <span className="detail__log-key">{t('detail.logError')}</span>
                      <span className="detail__log-val detail__log-pre detail__log-errtext">
                        {lg.error.name ? `${lg.error.name}: ` : ''}
                        {lg.error.message}
                      </span>
                    </div>
                  ) : (
                    lg.rawResponse && (
                      <div className="detail__log-row">
                        <span className="detail__log-key">{t('detail.logResponse')}</span>
                        <span className="detail__log-val detail__log-pre">{lg.rawResponse}</span>
                      </div>
                    )
                  )}
                  {lg.tokens && (
                    <div className="detail__log-row">
                      <span className="detail__log-key">{t('detail.tokens')}</span>
                      <span className="detail__log-val detail__log-mono">
                        ↑ {lg.tokens.input ?? 0} · ↓ {lg.tokens.output ?? 0}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {/* 主區三欄:即時畫面 | 下指令 + 測試腳本 | 執行軌跡(窄螢幕自動改兩欄 / 單欄) */}
      <div className={`detail__layout ${landscape ? 'detail__layout--landscape' : ''}`}>
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
              onAspect={(a) => setLandscape(a > 1)}
              {...(audioLevels?.state ? { audioState: audioLevels.state } : {})}
            />
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
              <p className="detail__booting-text">{message || pt('booting', lang)}</p>
              <p className="detail__booting-sub">{pt('bootingHint', lang)}</p>
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
        </section>

        {/* 中:下指令(執行中的主要操作)+ 測試腳本 */}
        <div className="detail__col detail__col--ops">
          {showChat && (
            <OperatorChat
              jobId={jobId!}
              isLive={isLive}
              {...(latestScreen ? { currentScreen: latestScreen } : {})}
              {...(appId ? { appId } : {})}
            />
          )}
          <ScriptPanel
            lang={lang}
            {...(meta?.script ?? meta?.task ? { script: meta?.script ?? meta?.task } : {})}
            {...(meta?.caseName ? { caseName: meta.caseName } : {})}
            {...(meta?.caseVersion ? { caseVersion: meta.caseVersion } : {})}
          />
        </div>

        {/* 右:執行軌跡(由新到舊) */}
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
                  <li key={s.index} className={`detail__step ${k === 0 ? 'detail__step--latest' : ''}`}>
                    {thumb && (
                      <a href={thumb} target="_blank" rel="noreferrer" className="detail__step-thumb">
                        <img src={thumb} alt={screenText ?? `step ${s.index}`} loading="lazy" />
                      </a>
                    )}
                    <div className="detail__step-text">
                      <div className="detail__step-head">
                        <span className="detail__step-idx">#{s.index}</span>
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
                      </div>
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
          )}
        </section>
      </div>
    </section>
  );
}
