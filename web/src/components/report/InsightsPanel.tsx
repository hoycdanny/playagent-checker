import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../../api/client.ts';
import type { EvidenceStep, ReportInsights } from './reportTypes.ts';
import { tr, txt, type RLang } from './reportText.ts';
import { ResultPill } from './VerdictMatrix.tsx';

type InsightsMap = { zh?: ReportInsights; en?: ReportInsights };

/**
 * AI 分析:根因、修正建議、需求驗證矩陣。由使用者按鈕觸發(有成本),結果快取在後端。
 * API Gateway 30 秒上限:若請求逾時,後端 Lambda 仍會跑完並寫入快取,這裡改輪詢報告。
 */
export function InsightsPanel({
  jobId,
  lang,
  insights,
  onChange,
  autoGenerate = false,
  evidence,
  onOpenImage,
  onGoFinding,
}: {
  jobId?: string;
  lang: RLang;
  insights?: InsightsMap;
  onChange: (m: InsightsMap) => void;
  /** 任務已結束且還沒有分析 → 開啟報告時自動產生一次(結果會快取,不會重複付費)。 */
  autoGenerate?: boolean;
  evidence: EvidenceStep[];
  onOpenImage: (url: string) => void;
  onGoFinding: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const ins = insights?.[lang] ?? insights?.[lang === 'zh' ? 'en' : 'zh'];

  const shotOf = (step: number) => {
    const s = evidence.find((e) => e.index === step);
    return s ? s.annotatedUrl ?? s.screenshotUrl : undefined;
  };

  const generate = async (force: boolean) => {
    if (!jobId || busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await apiPost<ReportInsights>(`/reports/${jobId}/insights`, { lang, force });
      onChange({ ...insights, [lang]: res });
    } catch {
      // 逾時:輪詢報告直到快取出現(最多約 60 秒)。
      const since = ins?.generatedAt;
      let got: ReportInsights | undefined;
      for (let i = 0; i < 12 && !got; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const doc = await apiGet<{ insights?: InsightsMap }>(`/reports/${jobId}`);
          const cand = doc.insights?.[lang];
          if (cand && cand.generatedAt !== since) got = cand;
        } catch { /* 繼續等 */ }
      }
      if (got) onChange({ ...insights, [lang]: got });
      else setError(true);
    } finally {
      setBusy(false);
    }
  };

  // 任務已結束但還沒有分析 → 開啟報告時自動產生一次。
  //
  // 為什麼不在後端任務結束時產生:報告是在 GET /reports/{id} 當下才組出來的,
  // 而 Lambda 回應後就凍結,沒辦法可靠地「回完再做」。放在這裡的另一個好處是
  // 沒人看的報告不會付費;結果快取在 insights-{lang}.json,同一份報告只會產生一次。
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoGenerate || !jobId || ins || autoRan.current) return;
    autoRan.current = true;
    void generate(false);
    // generate 會自己擋重入;只在「從沒有分析」變成可產生時觸發一次。
  }, [autoGenerate, jobId, ins]); // eslint-disable-line react-hooks/exhaustive-deps

  const ownerText = (o: string) => txt(o === 'qa' ? 'ownerQa' : o === 'env' ? 'ownerEnv' : 'ownerDev', lang);

  return (
    <div className="ins">
      <div className="ins__head">
        <p className="srep__muted">{ins ? `${txt('generatedBy', lang)}: ${ins.model.replace(/^us\.anthropic\./, '')} · ${new Date(ins.generatedAt).toLocaleString()}` : txt('insightsEmpty', lang)}</p>
        {jobId && (
          <button type="button" className={`ins__btn ${ins ? '' : 'ins__btn--primary'}`} onClick={() => void generate(Boolean(ins))} disabled={busy} aria-busy={busy}>
            {busy ? txt('generating', lang) : ins ? txt('regenerate', lang) : txt('generateInsights', lang)}
          </button>
        )}
      </div>
      {error && <p className="ins__error" role="alert">{txt('insightsFailed', lang)}</p>}

      {ins && (
        <>
          <div className="ins__grid">
            <article className="ins__card">
              <h3 className="srep__h3">{txt('executive', lang)}</h3>
              <p>{tr(ins.summary, lang)}</p>
            </article>
            <article className="ins__card">
              <h3 className="srep__h3">{txt('rootCause', lang)}</h3>
              <p>{tr(ins.rootCause, lang)}</p>
            </article>
          </div>

          {/* 需要注意的點:針對程式算出的指標逐條點出(舊的 insights 沒有這個欄位)。 */}
          {(ins.watchouts?.length ?? 0) > 0 && (
            <>
              <h3 className="srep__h3">{txt('watchouts', lang)}</h3>
              <p className="srep__note ins__hint">{txt('watchoutsHint', lang)}</p>
              <ul className="ins__watch">
                {ins.watchouts!.map((w, i) => (
                  <li key={i}>{tr(w, lang)}</li>
                ))}
              </ul>
            </>
          )}

          {ins.recommendations.length > 0 && (
            <>
              <h3 className="srep__h3">{txt('recommendations', lang)}</h3>
              <ol className="ins__recs">
                {ins.recommendations.map((r, i) => (
                  <li key={i} className={`ins__rec ins__rec--${r.priority}`}>
                    <span className="ins__prio">{r.priority}</span>
                    <span className="srep__tag">{ownerText(r.owner)}</span>
                    <span className="ins__rec-text">{tr(r.text, lang)}</span>
                    {r.relatedFindings.map((id) => (
                      <button key={id} type="button" className="vm__link srep__mono" onClick={() => onGoFinding(id)}>{id}</button>
                    ))}
                  </li>
                ))}
              </ol>
            </>
          )}

          {ins.requirements.length > 0 && (
            <>
              <h3 className="srep__h3" id="srep-requirements">{txt('requirements', lang)}</h3>
              <p className="srep__note ins__hint">{txt('requirementsHint', lang)}</p>
              <div className="srep__table-wrap">
                <table className="srep__table vm__table">
                  <thead>
                    <tr>
                      <th scope="col">ID</th>
                      <th scope="col">{txt('checkItem', lang)}</th>
                      <th scope="col">{txt('result', lang)}</th>
                      <th scope="col">{txt('evidenceCol', lang)}</th>
                      <th scope="col">{txt('basisCol', lang)}</th>
                      <th scope="col">{txt('suggestion', lang)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ins.requirements.map((q) => (
                      <tr key={q.id} className={`vm__row vm__row--${q.result}`}>
                        <td className="srep__mono">{q.id}</td>
                        <td className="vm__wrap vm__item">{q.text}</td>
                        <td><ResultPill r={q.result} lang={lang} /></td>
                        <td>
                          <div className="vm__thumbs">
                            {q.evidenceSteps.length === 0 && '—'}
                            {q.evidenceSteps.slice(0, 4).map((s) => {
                              const url = shotOf(s);
                              return url ? (
                                <button key={s} type="button" className="vm__thumb" onClick={() => onOpenImage(url)} aria-label={`#${s}`}>
                                  <img src={url} alt="" loading="lazy" />
                                </button>
                              ) : <span key={s} className="srep__mono">#{s}</span>;
                            })}
                          </div>
                        </td>
                        <td className="vm__wrap">{tr(q.reason, lang)}</td>
                        <td className="vm__wrap">{q.suggestion ? tr(q.suggestion, lang) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
