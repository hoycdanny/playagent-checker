import { useState } from 'react';
import type { StructuredReport } from './reportTypes.ts';
import { tr, txt, type RLang } from './reportText.ts';
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

type Tab = 'guide';

/** 把 {n} / {status} / {total} 這類佔位符換掉(與 reportText 的 txt 搭配)。 */
function fill(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function ReportAssistant({
  report,
  lang,
  onGoVerdicts,
  onGoSection,
}: {
  report: StructuredReport;
  lang: RLang;
  /** 跳到判定明細並套用篩選。 */
  onGoVerdicts: (filter: 'all' | 'unclear') => void;
  /** 捲動到某一節(用報告既有的 section id)。 */
  onGoSection: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab] = useState<Tab>('guide');
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
        <span className="rasst__tab is-on">{txt('asstTabGuide', lang)}</span>
      </nav>

      <div className="rasst__body">
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
