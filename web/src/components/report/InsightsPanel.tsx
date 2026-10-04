import { useState } from 'react';
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
  evidence,
  onOpenImage,
  onGoFinding,
}: {
  jobId?: string;
  lang: RLang;
  insights?: InsightsMap;
  onChange: (m: InsightsMap) => void;
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
