import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useJobStream } from '../api/useJobStream.ts';
import { apiGet, type ListResponse } from '../api/client.ts';
import { modelLabel } from '../components/modelProvider.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
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

export default function TaskDetailPage() {
  const { t } = useI18n();
  const { jobId } = useParams<{ jobId: string }>();
  const { state, message, steps, meta, connected, loading } = useJobStream(jobId ?? null);

  // 知識庫 id → 名稱對照(供「套用情境」以人類可讀名稱呈現)。
  const [kbNames, setKbNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    apiGet<ListResponse<KbSummary>>('/knowledge-bases')
      .then((r) => setKbNames(new Map(r.items.map((k) => [k.id, k.name]))))
      .catch(() => {});
  }, []);

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

  // 即時畫面:取「最新一張有截圖的步驟」當作即時畫面(devicefarm/emulator runner 每步都推截圖到 S3,
  // API 已附 presigned URL)。Web 後端無截圖,則回退顯示說明。
  const latestShot = [...steps]
    .reverse()
    .find((s) => s.annotatedUrl || s.screenshotUrl);
  const liveUrl = latestShot?.annotatedUrl ?? latestShot?.screenshotUrl;

  return (
    <section className="listpage detail">
      <div className="detail__topline">
        <Link to="/tasks" className="detail__back">
          ← {t('detail.back')}
        </Link>
        <div className="detail__topline-right">
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

      <header className="listpage__header">
        <h1 className="listpage__title">{t('detail.title')}</h1>
        {/* 終局狀態以 ARIA live region 通報(Req 11.3) */}
        <p className="detail__state" role="status" aria-live="polite">
          {t(`state.${state}` as MessageKey)}
          {message ? ` — ${message}` : ''}
        </p>
        {/* 成因引導(Req 12.3):fail → 被測 App/案例;error → 環境/基礎設施 */}
        {state === 'fail' && (
          <p className="detail__triage detail__triage--fail">{t('trend.triageFail')}</p>
        )}
        {state === 'error' && (
          <p className="detail__triage detail__triage--error">{t('trend.triageError')}</p>
        )}
      </header>

      {/* 任務資訊:套用情境(任務描述 + 知識庫)、使用模型、花費(Req 6.4/7.5)。 */}
      <section className="detail__info">
        <h2 className="detail__panel-title">{t('detail.info')}</h2>
        {(() => {
          const hasInfo =
            meta &&
            (meta.task ||
              meta.knowledgeBaseIds.length > 0 ||
              meta.vlmModel ||
              meta.seats.length > 0 ||
              meta.billableSpendUsd !== undefined ||
              meta.tokens);
          if (!hasInfo) {
            return <p className="detail__no-steps">{t('detail.noInfo')}</p>;
          }
          const kbLabels = meta!.knowledgeBaseIds.map((id) => kbNames.get(id) ?? id);
          const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
          return (
            <dl className="detail__info-grid">
              {meta!.task && (
                <div className="detail__info-row">
                  <dt>{t('detail.scenario')}</dt>
                  <dd>{meta!.task}</dd>
                </div>
              )}
              {kbLabels.length > 0 && (
                <div className="detail__info-row">
                  <dt>{t('detail.knowledgeBases')}</dt>
                  <dd>
                    <ul className="detail__info-tags">
                      {kbLabels.map((label, i) => (
                        <li key={`${label}-${i}`} className="detail__info-tag">
                          {label}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
              {/* 使用模型:依三個角色分行,各標明分工說明,讓人一看就懂哪顆做什麼 */}
              {(() => {
                const seatModel = (seat: string): string | undefined =>
                  meta!.seats.find((s) => s.seat === seat)?.modelId ??
                  (seat === 'vlm' ? meta!.vlmModel : undefined);
                const roles: Array<{ seat: string; label: string; hint: string }> = [
                  { seat: 'agent', label: t('detail.roleAgent'), hint: t('detail.roleAgentHint') },
                  { seat: 'vlm', label: t('detail.roleVlm'), hint: t('detail.roleVlmHint') },
                  { seat: 'subagent', label: t('detail.roleSubagent'), hint: t('detail.roleSubagentHint') },
                ];
                const rows = roles.filter((r) => seatModel(r.seat));
                if (rows.length === 0) return null;
                return (
                  <div className="detail__info-row">
                    <dt>{t('detail.models')}</dt>
                    <dd>
                      <ul className="detail__roles">
                        {rows.map((r) => {
                          const modelId = seatModel(r.seat)!;
                          return (
                            <li key={r.seat} className="detail__role">
                              <span className="detail__role-label">{r.label}</span>
                              <span className="detail__role-hint">{r.hint}</span>
                              <span className="detail__role-model" title={modelId}>
                                {modelLabel(modelId)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </dd>
                  </div>
                );
              })()}
              {meta!.billableSpendUsd !== undefined && (
                <div className="detail__info-row">
                  <dt>{t('detail.cost')}</dt>
                  <dd className="detail__info-cost">
                    {fmtUsd(meta!.billableSpendUsd)}
                    {meta!.spendEstimated ? `(${t('detail.costEstimated')})` : ''}
                    <span className="detail__info-budget">
                      {' / '}
                      {t('detail.budget')}{' '}
                      {meta!.budgetUsd !== undefined ? fmtUsd(meta!.budgetUsd) : t('tasks.unlimited')}
                    </span>
                  </dd>
                </div>
              )}
              {meta!.tokens && (
                <div className="detail__info-row">
                  <dt>{t('detail.tokens')}</dt>
                  <dd className="detail__info-mono">
                    ↑ {meta!.tokens.input.toLocaleString()} · ↓{' '}
                    {meta!.tokens.output.toLocaleString()}
                  </dd>
                </div>
              )}
            </dl>
          );
        })()}
      </section>

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

      <div className="detail__panels">
        {/* 左:即時畫面(最新截圖)。無截圖的後端(Web)顯示說明。 */}
        <div className="detail__panel">
          <h2 className="detail__panel-title">{t('detail.liveView')}</h2>
          {liveUrl ? (
            <figure className="detail__live-shot">
              <img src={liveUrl} alt={latestShot?.screen ?? t('detail.liveView')} />
              {latestShot?.screen && (
                <figcaption className="detail__live-cap">
                  {t('detail.step')} {latestShot.index}
                  {latestShot.screen ? ` · ${latestShot.screen}` : ''}
                </figcaption>
              )}
            </figure>
          ) : (
            <div className="detail__no-live">{t('detail.noLiveView')}</div>
          )}
        </div>

        {/* 右:Trace 步驟串流 */}
        <div className="detail__panel">
          <h2 className="detail__panel-title">{t('detail.trace')}</h2>
          {loading && steps.length === 0 ? (
            <div className="listpage__skeleton" aria-hidden="true">
              <div className="listpage__skeleton-row" />
            </div>
          ) : steps.length === 0 ? (
            <p className="detail__no-steps">{t('detail.noSteps')}</p>
          ) : (
            <ol className="detail__steps">
              {steps.map((s) => {
                const thumb = s.annotatedUrl ?? s.screenshotUrl;
                return (
                  <li key={s.index} className="detail__step">
                    <div className="detail__step-head">
                      <span className="detail__step-idx">
                        {t('detail.step')} {s.index}
                      </span>
                      {s.screen && (
                        <span className="detail__step-screen">{s.screen}</span>
                      )}
                      {s.action && (
                        <span className="detail__step-action">{s.action}</span>
                      )}
                    </div>
                    <div className="detail__step-body">
                      {thumb && (
                        <a
                          href={thumb}
                          target="_blank"
                          rel="noreferrer"
                          className="detail__step-thumb"
                        >
                          <img src={thumb} alt={s.screen ?? `step ${s.index}`} loading="lazy" />
                        </a>
                      )}
                      <div className="detail__step-text">
                        {s.thinking && (
                          <div className="detail__step-think">{s.thinking}</div>
                        )}
                        {s.url && <div className="detail__step-url">{s.url}</div>}
                        {typeof s.httpStatus === 'number' && (
                          <div>HTTP {s.httpStatus}</div>
                        )}
                        {s.observedTitle && (
                          <div className="detail__step-title">{s.observedTitle}</div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
