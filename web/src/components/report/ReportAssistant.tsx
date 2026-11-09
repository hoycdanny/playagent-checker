import { useState } from 'react';
import type { Finding, StructuredReport } from './reportTypes.ts';
import { tr, txt, type RLang } from './reportText.ts';
import { TaskAskPanel } from '../tasks/TaskAskPanel.tsx';
import { apiPost } from '../../api/client.ts';
import './ReportAssistant.css';

/**
 * 報告助手 —— 平時收起來的導讀面板。
 *
 * 為什麼需要它:結構化報告有 29 個章節,權重相同。一個專業測試人員打開它,
 * 不會知道該先看哪裡 —— 而最該先知道的三件事剛好分散在不同章節:
 *   1. 結論是什麼、憑什麼(驗收判定 + 缺陷統計)
 *   2. 這個結論**不涵蓋**什麼(適用邊界,在第 8 節)
 *   3. 平台本身做不到什麼(可執行範圍,在倒數第二節的表格裡)
 *
 * 助手刻意**不產生任何新結論**:它只重新排序與突顯報告已經算出來的東西。
 * 這一點是設計約束而不是實作偷懶 —— 報告的價值在於只主張證據支持的事,
 * 如果助手自己加判斷,就多出一個沒有證據鏈的主張來源。
 *
 * 所以這裡沒有任何運算,只有挑選與呈現;數字全部來自 report 物件。
 */

type Tab = 'guide' | 'ask' | 'review';

/**
 * 判定覆核的一列:確認是缺陷、或標為誤判。
 *
 * 理由是必填的,而且送出前就擋 —— 不是等後端退回。報告會原文顯示這段理由,
 * 沒有理由的覆寫在後端也會被忽略,先擋住比較不會讓使用者白填一次。
 */
function ReviewRow({
  finding,
  lang,
  onSubmit,
}: {
  finding: Finding;
  lang: RLang;
  onSubmit: (body: { findingId: string; reason: string; dismissed?: boolean; classification?: string }) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const send = async (kind: 'confirm' | 'dismiss') => {
    if (!reason.trim()) { setErr(txt('asstReasonRequired', lang)); return; }
    setBusy(true);
    setErr('');
    try {
      await onSubmit({
        findingId: finding.id,
        reason: reason.trim(),
        ...(kind === 'dismiss' ? { dismissed: true } : { classification: 'GAME_FAILURE' }),
      });
      setReason('');
    } catch (e) {
      setErr(txt('asstOverrideFailed', lang) + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rasst__review">
      <p className="rasst__review-title">
        <code>{finding.id}</code> {tr(finding.title, lang)}
      </p>
      <p className="rasst__review-meta">{finding.category} / {finding.severity}</p>
      <label className="rasst__review-label" htmlFor={`rasst-reason-${finding.id}`}>
        {txt('asstReasonLabel', lang)}
      </label>
      <textarea
        id={`rasst-reason-${finding.id}`}
        className="rasst__review-input"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={busy}
      />
      <p className="rasst__review-hint">{txt('asstReasonHint', lang)}</p>
      <div className="rasst__review-actions">
        <button type="button" className="rasst__btn rasst__btn--confirm" disabled={busy} onClick={() => send('confirm')}>
          {busy ? txt('asstSubmitting', lang) : txt('asstConfirm', lang)}
        </button>
        <button type="button" className="rasst__btn rasst__btn--dismiss" disabled={busy} onClick={() => send('dismiss')}>
          {txt('asstDismiss', lang)}
        </button>
      </div>
      {err && <p className="rasst__review-err">{err}</p>}
    </li>
  );
}

/** 把 {n} / {status} / {total} 這類佔位符換掉(與 reportText 的 txt 搭配)。 */
function fill(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function ReportAssistant({
  report,
  lang,
  jobId,
  onGoVerdicts,
  onGoSection,
  onReloaded,
}: {
  report: StructuredReport;
  lang: RLang;
  /**
   * 有 jobId 才顯示問答分頁 —— 問答是對「某一次任務」發問,沒有任務 id
   * 就沒有可問的對象(例如從匯出的報告檔開啟時)。
   */
  jobId?: string;
  /** 跳到判定明細並套用篩選。 */
  onGoVerdicts: (filter: 'all' | 'unclear') => void;
  /** 捲動到某一節(用報告既有的 section id)。 */
  onGoSection: (id: string) => void;
  /**
   * 覆核送出後呼叫 —— 由上層重新取整份報告。
   *
   * 不在這裡做局部更新是刻意的:覆寫會讓驗收判定、缺陷統計與放行建議一起重算,
   * 只改本地狀態會讓畫面上的判定與後端算出來的不一致。
   */
  onReloaded?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('guide');
  const [done, setDone] = useState(0);
  const r = report;

  // 待判斷的件數:AI 自己無法確定的缺陷 + 無法判斷的檢查項。
  // 這兩類都是「需要人看一眼」,而不是「平台做不到」—— 後者放在能力宣告裡。
  const triage = r.findings.filter((f) => f.classification === 'NEEDS_TRIAGE');
  const unclear = r.counts.unclear ?? 0;
  const pending = triage.length + unclear;

  const notCovered = r.claimScope?.notVaried ?? [];
  const cap = r.qaDocs?.capability;

  if (!open) {
    return (
      <button
        type="button"
        className="rasst__launch"
        onClick={() => setOpen(true)}
        aria-label={txt('asstOpen', lang)}
      >
        <span className="rasst__launch-mark" aria-hidden="true">?</span>
        <span>{txt('asstOpen', lang)}</span>
        {pending > 0 && <span className="rasst__count">{pending}</span>}
      </button>
    );
  }

  return (
    <aside className="rasst" role="complementary" aria-label={txt('asstOpen', lang)}>
      <header className="rasst__head">
        <h2 className="rasst__title">{txt('asstOpen', lang)}</h2>
        <button
          type="button"
          className="rasst__x"
          onClick={() => setOpen(false)}
          aria-label={txt('asstClose', lang)}
        >
          ×
        </button>
      </header>

      <nav className="rasst__tabs">
        <button
          type="button"
          className={`rasst__tab${tab === 'guide' ? ' is-on' : ''}`}
          onClick={() => setTab('guide')}
        >
          {txt('asstTabGuide', lang)}
        </button>
        {jobId && (
          <button
            type="button"
            className={`rasst__tab${tab === 'ask' ? ' is-on' : ''}`}
            onClick={() => setTab('ask')}
          >
            {txt('asstTabAsk', lang)}
          </button>
        )}
        {jobId && (
          <button
            type="button"
            className={`rasst__tab${tab === 'review' ? ' is-on' : ''}`}
            onClick={() => setTab('review')}
          >
            {txt('asstTabReview', lang)}
            {triage.length > 0 && <span className="rasst__tab-n">{triage.length}</span>}
          </button>
        )}
      </nav>

      <div className="rasst__body">
        {/*
          問答重用任務詳情頁的那一個面板(同一個後端、同一份對話紀錄),
          不另做一套 —— 兩套對話會讓同一個任務出現兩份歷史。
        */}
        {tab === 'ask' && jobId && <TaskAskPanel jobId={jobId} lang={lang} embedded />}

        {/*
          判定覆核:只列待判讀的缺陷 —— 那是系統自己說「無法確認」的那些,
          也就是最需要人看一眼的。已確認的缺陷要調整的話從缺陷明細進去,
          不放在這裡,避免這份清單變成「可以隨手改掉任何判定」的入口。
        */}
        {tab === 'review' && jobId && (
          <>
            <p className="rasst__card-text">{txt('asstReviewIntro', lang)}</p>
            {triage.length === 0 ? (
              <p className="rasst__card-text">{txt('asstReviewNone', lang)}</p>
            ) : (
              <ul className="rasst__reviews">
                {triage.map((f) => (
                  <ReviewRow
                    key={f.id}
                    finding={f}
                    lang={lang}
                    onSubmit={async (bodyIn) => {
                      await apiPost(`/tasks/${encodeURIComponent(jobId)}/report-overrides`, bodyIn);
                      // 覆寫會讓驗收判定重算,所以重新取整份報告而不是只改本地狀態 ——
                      // 局部更新會讓畫面上的判定與後端算出來的不一致。
                      setDone((n) => n + 1);
                      onReloaded?.();
                    }}
                  />
                ))}
              </ul>
            )}
            {done > 0 && <p className="rasst__review-ok">{txt('asstOverridden', lang)} · {done}</p>}
          </>
        )}

        {tab === 'guide' && (
          <>
            {/* 1. 結論憑什麼 —— 理由直接用驗收判定算出來的那一句,不自己改寫 */}
            <section className={`rasst__card rasst__card--${r.overallStatus.toLowerCase()}`}>
              <h3 className="rasst__card-title">
                {fill(txt('asstVerdictWhy', lang), { status: r.overallStatus })}
              </h3>
              <p className="rasst__card-text">{tr(r.acceptance?.verdictReason ?? r.statusReason, lang)}</p>
              <ul className="rasst__facts">
                <li>{txt('passed', lang)} {r.counts.passed} / {txt('executed', lang)} {r.counts.executedChecks}</li>
                <li>{txt('criticalDefects', lang)} {r.counts.defects.critical}</li>
                {unclear > 0 && <li>{fill(txt('asstUnclear', lang), { n: unclear })}</li>}
              </ul>
              <button type="button" className="rasst__link" onClick={() => onGoVerdicts('all')}>
                {txt('asstEvidencePath', lang)}
              </button>
            </section>

            {/* 2. 不涵蓋什麼 —— 適用邊界埋在第 8 節,這裡提到最前面 */}
            <section className="rasst__card rasst__card--limit">
              <h3 className="rasst__card-title">
                {fill(txt('asstNotCovered', lang), { n: notCovered.length })}
              </h3>
              {notCovered.length === 0 ? (
                <p className="rasst__card-text">{txt('asstNoClaimScope', lang)}</p>
              ) : (
                <>
                  <ul className="rasst__limits">
                    {notCovered.map((n) => (
                      <li key={n.id}>
                        <b>{tr(n.label, lang)}</b> — {tr(n.note, lang)}
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="rasst__link" onClick={() => onGoSection('srep-claimScope')}>
                    {txt('asstNotCoveredFrom', lang)}
                  </button>
                </>
              )}
            </section>

            {/* 3. 平台做不到什麼 —— 三段條,數字來自後端的結構化統計 */}
            {cap && (
              <section className="rasst__card">
                <h3 className="rasst__card-title">
                  {fill(txt('asstCapability', lang), { total: cap.total })}
                </h3>
                <div className="rasst__bar" role="img" aria-label={tr(cap.note, lang)}>
                  <span className="rasst__seg rasst__seg--auto" style={{ flexGrow: cap.automated }}>
                    {cap.automated}
                  </span>
                  <span className="rasst__seg rasst__seg--partial" style={{ flexGrow: cap.partial }}>
                    {cap.partial}
                  </span>
                  <span className="rasst__seg rasst__seg--none" style={{ flexGrow: cap.not_supported }}>
                    {cap.not_supported}
                  </span>
                </div>
                <ul className="rasst__legend">
                  <li><i className="rasst__dot rasst__dot--auto" />{txt('asstCapAuto', lang)}</li>
                  <li><i className="rasst__dot rasst__dot--partial" />{txt('asstCapPartial', lang)}</li>
                  <li><i className="rasst__dot rasst__dot--none" />{txt('asstCapNone', lang)}</li>
                </ul>
                {/* 這一句是必要的,不是裝飾:三個數字很容易被讀成涵蓋率 */}
                <p className="rasst__warn">{tr(cap.note, lang)}</p>
              </section>
            )}

            {/* 4. 待你判斷 */}
            <section className="rasst__card">
              <h3 className="rasst__card-title">{txt('asstPending', lang)}</h3>
              {pending === 0 ? (
                <p className="rasst__card-text">{txt('asstAllClear', lang)}</p>
              ) : (
                <>
                  {triage.length > 0 && (
                    <p className="rasst__card-text">{fill(txt('asstTriage', lang), { n: triage.length })}</p>
                  )}
                  <button type="button" className="rasst__link" onClick={() => onGoVerdicts(unclear > 0 ? 'unclear' : 'all')}>
                    {txt('asstTriageGo', lang)}
                  </button>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
