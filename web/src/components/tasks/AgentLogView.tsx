import { useEffect, useMemo, useState } from 'react';
import { apiGet, type ListResponse } from '../../api/client.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { modelLabel } from '../modelProvider.ts';

/** 單步模型互動 log(對應後端 traces/<i>.json)。 */
export interface TraceLog {
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
  /** 呼叫耗時(決策 / 輔助 Agent 有記)。 */
  ms?: number;
}

export type AgentSeat = 'vlm' | 'agent' | 'subagent';

/**
 * 讀 trace(執行中每 10 秒更新)。
 * seat:只讀某個 Agent 的最新 200 筆(長測試三個 Agent 合計上千筆,一次全讀太大);
 * 'summary':全部 Agent 的精簡紀錄(只有 token / 成敗 / 耗時,用量分頁用)。
 */
export function useTraces(jobId: string, isLive: boolean, enabled: boolean, mode: AgentSeat | 'summary' = 'summary') {
  const [items, setItems] = useState<TraceLog[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setItems(null);
    const q = mode === 'summary' ? 'summary=1' : `seat=${mode}&limit=200`;
    const load = async () => {
      try {
        const r = await apiGet<ListResponse<TraceLog>>(`/tasks/${encodeURIComponent(jobId)}/logs?${q}`);
        if (!stop) setItems(r.items);
      } catch {
        if (!stop) setItems((p) => p ?? []);
      }
      if (!stop && isLive) timer = setTimeout(() => void load(), 10_000);
    };
    void load();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [jobId, isLive, enabled, mode]);
  return items;
}

/** 某一個 Agent 每一步的模型互動(最新在上)。 */
export function AgentLogView({ traces, seat, emptyText, loadingText }: { traces: TraceLog[] | null; seat: AgentSeat; emptyText: string; loadingText: string }) {
  const { t } = useI18n();
  const list = useMemo(
    () => (traces ?? []).filter((lg) => (lg.seat ?? 'vlm') === seat).sort((a, b) => b.index - a.index),
    [traces, seat],
  );
  if (traces === null) return <p className="devlogs__muted">{loadingText}</p>;
  if (list.length === 0) return <p className="devlogs__muted">{emptyText}</p>;
  return (
    <ol className="detail__log-list devlogs__agent">
      {list.map((lg) => (
        <li key={`${lg.seat}-${lg.index}`} className={`detail__log ${lg.ok === false ? 'detail__log--err' : ''}`}>
          <div className="detail__log-head">
            <span className="detail__log-idx">{t('detail.step')} {lg.index}</span>
            {lg.modelId && <span className="detail__log-model" title={lg.modelId}>{modelLabel(lg.modelId)}</span>}
            {lg.channel && <span className="detail__log-channel">{lg.channel}</span>}
            <span className={`detail__log-status ${lg.ok === false ? 'is-err' : 'is-ok'}`}>
              {lg.ok === false ? t('detail.logFail') : t('detail.logOk')}
            </span>
          </div>
          {lg.request && (
            <div className="detail__log-row">
              <span className="detail__log-key">{t('detail.logRequest')}</span>
              <span className="detail__log-val">
                {t('detail.logImages')}: {lg.request.imageCount ?? 0}
                {typeof lg.request.imageApproxKB === 'number' ? ` (~${lg.request.imageApproxKB} KB)` : ''}
                {typeof lg.request.messageTurns === 'number' ? ` · ${t('detail.logTurns')}: ${lg.request.messageTurns}` : ''}
              </span>
            </div>
          )}
          {lg.request?.turnText && (
            <details className="detail__log-row">
              <summary className="detail__log-key">{t('detail.logPrompt')}</summary>
              <span className="detail__log-val detail__log-pre">{lg.request.turnText}</span>
            </details>
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
              <span className="detail__log-val detail__log-mono">↑ {lg.tokens.input ?? 0} · ↓ {lg.tokens.output ?? 0}</span>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
