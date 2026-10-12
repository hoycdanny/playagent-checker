import type { Acceptance, AcceptanceCriterion, EvidenceStep, NonSlotCredit } from './reportTypes.ts';
import { STATUS_TEXT, tr, txt, type RLang, type TextKey } from './reportText.ts';

/**
 * 驗收結論與標準:一次測試只有一個結論(與任務列表、報告封面同一個值)。
 * 每個驗收項目列出要求來源、門檻、實際值、歸因與證據步驟;證據步驟可直接點開當步截圖。
 * RTP 帳務逐筆列出量測區間與非拉霸收入,每個數字都對應到讀到它的步驟。
 */

const RESULT_KEY: Record<AcceptanceCriterion['result'], TextKey | null> = {
  pass: null,
  fail: null,
  not_evaluable: 'acNotEvaluable',
  not_applicable: 'acNotApplicable',
};
const ATTR_KEY: Record<string, TextKey> = {
  game: 'attrGame',
  test_execution: 'attrExecution',
  environment: 'attrEnvironment',
  ai_agent: 'attrAi',
  data: 'attrData',
};
const BASIS_KEY: Record<NonSlotCredit['basis'], TextKey> = {
  obs: 'basisObs',
  balance_diff: 'basisBalanceDiff',
  ai_read: 'basisAiRead',
  none_seen: 'basisNoneSeen',
  unresolved: 'basisUnresolved',
};
const fmt = (n: number) => n.toLocaleString('en-US');

function resultLabel(c: AcceptanceCriterion, lang: RLang): string {
  const k = RESULT_KEY[c.result];
  if (k) return txt(k, lang);
  return tr(STATUS_TEXT[c.result]!, lang);
}

export function AcceptancePanel({
  acceptance: a,
  evidence,
  lang,
  onOpenImage,
  onOpenFinding,
}: {
  acceptance: Acceptance;
  evidence: EvidenceStep[];
  lang: RLang;
  onOpenImage: (url: string) => void;
  onOpenFinding: (id: string) => void;
}) {
  const byIndex = new Map(evidence.map((s) => [s.index, s] as const));
  const refTitle = new Map(a.references.map((r) => [r.id, r.title] as const));

  /** 證據步驟:有截圖就直接開圖;滑過顯示該步 AI 的觀察與說明。 */
  const Step = ({ n }: { n: number }) => {
    const s = byIndex.get(n);
    const img = s?.annotatedUrl ?? s?.screenshotUrl;
    const tip = s ? `#${n} ${s.screen} · ${s.action}${s.thinking ? `\n${s.thinking.slice(0, 220)}` : ''}` : `#${n}`;
    return img ? (
      <button type="button" className="srep__ac-step" title={tip} onClick={() => onOpenImage(img)}>#{n}</button>
    ) : (
      <span className="srep__ac-step srep__ac-step--noimg" title={tip}>#{n}</span>
    );
  };
  const Steps = ({ list }: { list: number[] }) => {
    const uniq = [...new Set(list)].sort((x, y) => x - y);
    if (!uniq.length) return <span className="srep__muted">—</span>;
    const head = uniq.slice(0, 8);
    return (
      <span className="srep__ac-steps">
        {head.map((n) => <Step key={n} n={n} />)}
        {uniq.length > head.length && <span className="srep__muted">+{uniq.length - head.length}</span>}
      </span>
    );
  };

  return (
    <div className="srep__ac">
      <div className={`srep__ac-verdict srep__ac-verdict--${a.verdict}`}>
        <strong>{tr(STATUS_TEXT[a.verdict]!, lang)}</strong>
        <span>{tr(a.verdictReason, lang)}</span>
        <small className="srep__mono">{txt('acStandard', lang)} {a.standard}{a.decidedBy.length ? ` · ${txt('acDecidedBy', lang)}:${a.decidedBy.join(', ')}` : ''}</small>
      </div>

      <div className="srep__table-wrap">
        <table className="srep__table srep__ac-table">
          <thead>
            <tr>
              <th>{txt('acId', lang)}</th>
              <th>{txt('acItem', lang)}</th>
              <th>{txt('acLevel', lang)}</th>
              <th>{txt('acThreshold', lang)}</th>
              <th>{txt('acActual', lang)}</th>
              <th>{txt('acResult', lang)}</th>
              <th>{txt('acAttribution', lang)}</th>
              <th>{txt('acEvidence', lang)}</th>
            </tr>
          </thead>
          <tbody>
            {a.criteria.map((c) => (
              <tr key={c.id} className={`srep__ac-row srep__ac-row--${c.result}${a.decidedBy.includes(c.id) ? ' is-decisive' : ''}`}>
                <td className="srep__mono">{c.id}</td>
                <td>
                  <strong>{tr(c.title, lang)}</strong>
                  <div className="srep__muted">{tr(c.requirement, lang)}</div>
                  {c.sources.filter((s) => s.quote || s.kind === 'standard').map((s, i) => (
                    <div key={i} className="srep__ac-src">
                      {s.kind === 'case' ? `${txt('acCaseQuote', lang)}:「${s.quote}」` : `${txt('acSource', lang)}:${refTitle.get(s.ref) ?? s.ref}`}
                    </div>
                  ))}
                  {c.note && <div className="srep__ac-note">{tr(c.note, lang)}</div>}
                </td>
                <td><span className={`srep__ac-level srep__ac-level--${c.level}`}>{txt(c.level === 'must' ? 'acMust' : 'acShould', lang)}</span></td>
                <td>{c.threshold ? tr(c.threshold, lang) : '—'}</td>
                <td>{c.actual ? tr(c.actual, lang) : '—'}</td>
                <td>
                  <span className={`srep__ac-result srep__ac-result--${c.result}`}>{resultLabel(c, lang)}</span>
                  <div className="srep__muted">{txt(c.basis === 'deterministic' ? 'acDeterministic' : 'acAiEvaluation', lang)}</div>
                </td>
                <td>{c.attribution ? txt(ATTR_KEY[c.attribution]!, lang) : '—'}</td>
                <td>
                  <Steps list={c.evidenceSteps} />
                  {c.relatedFindings.length > 0 && (
                    <div className="srep__ac-steps">
                      {c.relatedFindings.map((id) => (
                        <button key={id} type="button" className="srep__ac-step" onClick={() => onOpenFinding(id)}>{id}</button>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {a.rtp && (
        <>
          <h3 className="srep__h3">{txt('rtpLedger', lang)}</h3>
          <p className="srep__muted">{txt('rtpFormula', lang)}:{tr(a.rtp.formula, lang)}</p>
          <div className="srep__ac-kpis">
            <div><span>{txt('rtpNet', lang)}</span><strong>{a.rtp.rtpNet !== null ? `${a.rtp.rtpNet}%` : txt('rtpNotComputable', lang)}</strong></div>
            <div><span>{txt('rtpGross', lang)}</span><strong>{a.rtp.rtpGross}%</strong></div>
            <div><span>{txt('rtpSpins', lang)}</span><strong>{fmt(a.rtp.spins)}</strong></div>
            <div><span>{txt('rtpWagered', lang)}</span><strong>{fmt(a.rtp.wagered)}</strong></div>
            <div><span>{txt('rtpDelta', lang)}</span><strong>{a.rtp.balanceDelta >= 0 ? '+' : ''}{fmt(a.rtp.balanceDelta)}</strong></div>
            <div><span>{txt('rtpCredits', lang)}</span><strong>{fmt(a.rtp.creditsInWindow)}</strong></div>
          </div>

          <h4 className="srep__h4">{txt('rtpWindows', lang)}</h4>
          <div className="srep__table-wrap">
            <table className="srep__table">
              <thead>
                <tr>
                  <th>{txt('rtpWindow', lang)}</th>
                  <th>{txt('rtpBet', lang)}</th>
                  <th>{txt('rtpCounter', lang)}</th>
                  <th>{txt('rtpSpins', lang)}</th>
                  <th>{txt('rtpWagered', lang)}</th>
                  <th>{txt('rtpBalance', lang)}</th>
                  <th>{txt('rtpDelta', lang)}</th>
                </tr>
              </thead>
              <tbody>
                {a.rtp.windows.map((w) => (
                  <tr key={w.id}>
                    <td className="srep__mono">{w.id}{w.segment > 1 ? ` · ${w.segment}` : ''}</td>
                    <td>{fmt(w.bet)}</td>
                    <td>
                      {fmt(w.counterStart.value)} <Step n={w.counterStart.step} /> → {fmt(w.counterEnd.value)} <Step n={w.counterEnd.step} />
                    </td>
                    <td>{fmt(w.spins)}</td>
                    <td>{fmt(w.wagered)}</td>
                    <td>
                      {fmt(w.balanceStart.value)} <Step n={w.balanceStart.step} /> → {fmt(w.balanceEnd.value)} <Step n={w.balanceEnd.step} />
                    </td>
                    <td>{w.balanceDelta >= 0 ? '+' : ''}{fmt(w.balanceDelta)}</td>
                  </tr>
                ))}
                <tr className="srep__ac-total">
                  <td>{txt('rtpTotal', lang)}</td>
                  <td>—</td>
                  <td>—</td>
                  <td>{fmt(a.rtp.spins)}</td>
                  <td>{fmt(a.rtp.wagered)}</td>
                  <td>—</td>
                  <td>{a.rtp.balanceDelta >= 0 ? '+' : ''}{fmt(a.rtp.balanceDelta)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h4 className="srep__h4">{txt('rtpCredits', lang)}</h4>
          {a.rtp.credits.length === 0 ? (
            <p className="srep__muted">{txt('rtpNoCredits', lang)}</p>
          ) : (
            <div className="srep__table-wrap">
              <table className="srep__table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>{txt('observed', lang)}</th>
                    <th>{txt('rtpAmount', lang)}</th>
                    <th>{txt('rtpCreditBasis', lang)}</th>
                    <th>{txt('rtpInWindow', lang)}</th>
                    <th>{txt('acEvidence', lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {a.rtp.credits.map((c) => (
                    <tr key={c.id} className={c.basis === 'unresolved' && c.windowId ? 'srep__ac-row--fail' : ''}>
                      <td className="srep__mono">{c.id}</td>
                      <td>{c.screen}</td>
                      <td>{c.amount === null ? '—' : fmt(c.amount)}</td>
                      <td>
                        {txt(BASIS_KEY[c.basis], lang)}
                        <div className="srep__muted">{tr(c.note, lang)}{c.quote ? `(「${c.quote}」)` : ''}</div>
                      </td>
                      <td>{c.windowId ?? '—'}</td>
                      <td><Steps list={c.steps} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h4 className="srep__h4">{txt('rtpStats', lang)}</h4>
          <dl className="srep__facts">
            <div><dt>{txt('rtpSigma', lang)}</dt><dd>{a.rtp.stats.sigma}({txt(a.rtp.stats.sigmaSource === 'spec' ? 'rtpSigmaSpec' : 'rtpSigmaAssumed', lang)})</dd></div>
            <div><dt>{txt('rtpCi', lang)}</dt><dd>{a.rtp.stats.ci95Pp !== null ? `±${a.rtp.stats.ci95Pp} pp` : '—'}</dd></div>
            <div><dt>{txt('rtpFor1pp', lang)}</dt><dd>{fmt(a.rtp.stats.spinsFor1Pp)}</dd></div>
            {a.rtp.stats.expectedRtp !== undefined && <div><dt>Expected RTP</dt><dd>{a.rtp.stats.expectedRtp}%{a.rtp.stats.z !== undefined ? `(z = ${a.rtp.stats.z})` : ''}</dd></div>}
          </dl>
        </>
      )}

      <details className="srep__ac-details">
        <summary>{txt('acRules', lang)}</summary>
        <ol>{a.rules.map((r, i) => <li key={i}>{tr(r, lang)}</li>)}</ol>
      </details>
      <details className="srep__ac-details">
        <summary>{txt('acRefs', lang)}</summary>
        <ul>
          {a.references.map((r) => (
            <li key={r.id}>
              <a href={r.url} target="_blank" rel="noreferrer noopener">{r.title}</a>
              <div className="srep__muted">{tr(r.use, lang)}</div>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
