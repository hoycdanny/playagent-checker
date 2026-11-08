import { useState } from 'react';
import type { QaDocument, QaDocCoverage, QaDocGroup, QaDocumentSet } from './reportTypes.ts';
import { tr, txt, type RLang, type TextKey } from './reportText.ts';
import { qaDocsFileName, qaDocsToSheets } from './qaDocsExport.ts';

/**
 * 交付文件規範(QA-DS):把報告重新表述成客戶要求的 19 類交付文件。
 *
 * 這一節刻意把三件事放在使用者看得到的地方,而不是藏在資料裡:
 *  - 19 類文件的覆蓋狀態一覽(含「不由執行證據產生」的原因),所以「完整」是可檢查的。
 *  - 三個統計指標的分子與分母,因為三個公式的分母各不相同,只給百分比會被誤讀。
 *  - 每份文件「需人工補填」的欄位,避免把空白當成已驗證。
 *
 * 這一節不做任何判定;結論仍以驗收結論與標準那一節為準。
 */

const COVERAGE_KEY: Record<QaDocCoverage, TextKey> = {
  derived: 'qaDocDerived',
  derived_with_gaps: 'qaDocGaps',
  not_derivable: 'qaDocNotDerivable',
};

const GROUP_KEY: Record<QaDocGroup, TextKey> = {
  planning: 'qaGroupPlanning',
  execution: 'qaGroupExecution',
  defects: 'qaGroupDefects',
  closure: 'qaGroupClosure',
  specialty: 'qaGroupSpecialty',
  research: 'qaGroupResearch',
  training: 'qaGroupTraining',
};

/** 四態的視覺色塊沿用判定明細的樣式類別,讓同一個字在報告裡永遠同一個顏色。 */
const RESULT_CLASS: Record<string, string> = {
  PASS: 'pass',
  FAIL: 'fail',
  BLOCK: 'unclear',
  'N/A': 'skipped',
};

function ResultCell({ v }: { v: string }) {
  const cls = RESULT_CLASS[v];
  return cls ? <span className={`vm__pill vm__pill--${cls}`}>{v}</span> : <>{v}</>;
}

function DocCard({ doc, lang }: { doc: QaDocument; lang: RLang }) {
  const [open, setOpen] = useState(false);
  const hasBody = doc.header.length > 0 || doc.tables.length > 0 || doc.links.length > 0;
  return (
    <li className={`srep__qa-doc srep__qa-doc--${doc.coverage}`}>
      <button
        type="button"
        className="srep__qa-doc-head"
        onClick={() => hasBody && setOpen((o) => !o)}
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
      >
        <code className="srep__qa-code">{doc.code}</code>
        <span className="srep__qa-title">{tr(doc.title, lang)}</span>
        <small className="srep__qa-group">{txt(GROUP_KEY[doc.group], lang)}</small>
        <span className={`vm__pill vm__pill--${doc.coverage === 'derived' ? 'pass' : doc.coverage === 'derived_with_gaps' ? 'unclear' : 'skipped'}`}>
          {txt(COVERAGE_KEY[doc.coverage], lang)}
        </span>
        {hasBody && <span className="srep__qa-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>}
      </button>

      {doc.reason && (
        <p className="srep__qa-reason">
          <strong>{txt('qaDocReason', lang)}:</strong> {tr(doc.reason, lang)}
        </p>
      )}

      {open && (
        <div className="srep__qa-body">
          {doc.header.length > 0 && (
            <dl className="srep__kv">
              {doc.header.map((h) => (
                <div key={h.key}>
                  <dt>{tr(h.label, lang)}</dt>
                  <dd>{h.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {doc.tables.map((t) => (
            <div key={t.id} className="srep__qa-table">
              <h4 className="srep__h4">{tr(t.title, lang)}</h4>
              {t.rows.length > 0 ? (
                <div className="srep__table-wrap">
                  <table className="srep__table">
                    <thead>
                      <tr>{t.columns.map((c) => <th key={c.key}>{tr(c.label, lang)}</th>)}</tr>
                    </thead>
                    <tbody>
                      {t.rows.map((row, i) => (
                        <tr key={i}>
                          {t.columns.map((c) => (
                            <td key={c.key}>
                              {c.key === 'result' || c.key === 'accept' ? <ResultCell v={row[c.key] ?? ''} /> : (row[c.key] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {/* 空表與被截斷的表都要說明原因,否則空白會被讀成「沒問題」。 */}
              {t.emptyReason && <p className="srep__qa-note">{tr(t.emptyReason, lang)}</p>}
            </div>
          ))}

          {doc.links.length > 0 && (
            <>
              <h4 className="srep__h4">{txt('qaDocLinks', lang)}</h4>
              <dl className="srep__kv">
                {doc.links.map((l) => (
                  <div key={l.key}>
                    <dt>{tr(l.label, lang)}</dt>
                    <dd>{l.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          {doc.unfilled.length > 0 && (
            <p className="srep__qa-unfilled">
              <strong>{txt('qaDocUnfilled', lang)}:</strong> {doc.unfilled.map((u) => tr(u, lang)).join('、')}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

export function QaDocsPanel({ set, reportId, lang }: { set: QaDocumentSet; reportId?: string; lang: RLang }) {
  const dash = '—';
  const [exporting, setExporting] = useState(false);
  const [failed, setFailed] = useState(false);

  /** 試算表套件較大,按下匯出才載入(沿用測試項目匯入頁的慣例,不進主包)。 */
  async function exportXlsx() {
    setExporting(true);
    setFailed(false);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      for (const sheet of qaDocsToSheets(set, lang)) {
        const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
        if (sheet.cols) ws['!cols'] = sheet.cols.map((wch) => ({ wch }));
        XLSX.utils.book_append_sheet(wb, ws, sheet.name);
      }
      XLSX.writeFile(wb, qaDocsFileName(set, reportId, lang));
    } catch {
      setFailed(true);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="srep__qa">
      <div className="srep__qa-actions">
        <button type="button" className="ins__btn" onClick={() => void exportXlsx()} disabled={exporting} aria-busy={exporting}>
          {exporting ? txt('qaDocExporting', lang) : txt('qaDocExport', lang)}
        </button>
        <small className="srep__qa-note">{txt('qaDocExportHint', lang)}</small>
        {failed && <small className="srep__qa-unfilled">{txt('qaDocExportFailed', lang)}</small>}
      </div>

      <dl className="srep__kv">
        <div>
          <dt>{txt('qaDocStandard', lang)}</dt>
          <dd><code>{set.standard}</code></dd>
        </div>
        <div>
          <dt>{txt('qaDocInternal', lang)}</dt>
          <dd><code>{set.internalStandard}</code></dd>
        </div>
        <div>
          <dt>{txt('qaDocCoverage', lang)}</dt>
          <dd>
            {txt('qaDocDerived', lang)} {set.coverageSummary.derived}
            {' · '}{txt('qaDocGaps', lang)} {set.coverageSummary.derived_with_gaps}
            {' · '}{txt('qaDocNotDerivable', lang)} {set.coverageSummary.not_derivable}
          </dd>
        </div>
      </dl>

      {/* 統計指標:分子分母一律外顯 —— 三個公式的分母不同,不可互相比較。 */}
      <h3 className="srep__h3">{txt('qaDocStats', lang)}</h3>
      <div className="srep__table-wrap">
        <table className="srep__table">
          <thead>
            <tr>
              <th>{txt('acItem', lang)}</th>
              <th>{txt('qaDocFormula', lang)}</th>
              <th>{txt('qaDocNumerator', lang)}</th>
              <th>{txt('qaDocDenominator', lang)}</th>
              <th>{txt('qaDocValue', lang)}</th>
              <th>{txt('qaDocInclusion', lang)}</th>
              <th>{txt('qaDocBoundary', lang)}</th>
            </tr>
          </thead>
          <tbody>
            {set.statistics.map((s) => (
              <tr key={s.id}>
                <td>{tr(s.label, lang)}</td>
                <td><code>{tr(s.formula, lang)}</code></td>
                <td>{s.numerator ?? dash}</td>
                <td>{s.denominator ?? dash}</td>
                <td>{s.value === null ? <em>{txt('qaDocNotComputed', lang)}</em> : `${s.value}%`}</td>
                <td>{tr(s.basis, lang)}</td>
                <td>{tr(s.caveat, lang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="srep__h3">{txt('qaDocs', lang)}</h3>
      <ul className="srep__qa-docs">
        {set.documents.map((d) => <DocCard key={d.code} doc={d} lang={lang} />)}
      </ul>

      <details className="srep__qa-legend">
        <summary>{txt('qaDocLegendResult', lang)} · {txt('qaDocLegendGrade', lang)} · {txt('qaDocLegendDiscovery', lang)}</summary>
        <dl className="srep__kv">
          {set.resultLegend.map((l) => (
            <div key={l.result}>
              <dt>{l.label}</dt>
              <dd>{tr(l.definition, lang)}</dd>
            </div>
          ))}
          {set.gradeLegend.map((l) => (
            <div key={l.grade}>
              <dt>{tr(l.label, lang)}</dt>
              <dd>{tr(l.definition, lang)}</dd>
            </div>
          ))}
          {set.discoveryLegend.map((l) => (
            <div key={l.grade}>
              <dt>{l.grade}</dt>
              <dd>{tr(l.definition, lang)}</dd>
            </div>
          ))}
        </dl>
      </details>

      <ul className="srep__qa-notes">
        {set.notes.map((n, i) => <li key={i}>{tr(n, lang)}</li>)}
      </ul>
    </div>
  );
}
