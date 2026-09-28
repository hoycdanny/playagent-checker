import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiGet } from '../api/client.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { LOCALE_LABELS, type Locale } from '../i18n/messages.ts';
import type { MessageKey } from '../i18n/messages.ts';
import { NavGraph } from '../components/NavGraph.tsx';
import './ListPage.css';
import './ReportViewPage.css';

/** emulator 報告的逐步 trace。 */
interface EmuStep {
  stepNumber: number;
  action: string;
  screen?: string;
  reason?: string;
  coords?: { x: number; y: number };
  text?: string;
  screenshotUrl?: string;
  annotatedUrl?: string;
  durationMs?: number;
  tokens?: { input: number; output: number };
}
interface NavNode { id: string; step: number; screen: string; screenshotUrl?: string }
interface NavEdge { from: string; to: string; action: string }

interface ReportDoc {
  jobId: string;
  state: string;
  // web 多語報告欄位
  stepCount?: number;
  budgetUsd?: number | null;
  billableSpendUsd?: number;
  narratives?: Partial<Record<string, string>>;
  availableLanguages?: string[];
  // emulator 報告欄位
  task?: string;
  vlmModel?: string;
  device?: { w: number; h: number };
  steps?: Array<Record<string, unknown>>;
  navGraph?: { nodes: NavNode[]; edges: NavEdge[] };
  tokens?: { input: number; output: number };
  generatedAt?: string;
}

export default function ReportViewPage() {
  const { t, locale } = useI18n();
  const { jobId } = useParams<{ jobId: string }>();
  const [report, setReport] = useState<ReportDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [narrativeLang, setNarrativeLang] = useState<string>(locale);
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    apiGet<ReportDoc>(`/reports/${jobId}`)
      .then((r) => {
        setReport(r);
        const langs = r.availableLanguages ?? [];
        setNarrativeLang(langs.includes(locale) ? locale : langs[0] ?? 'en');
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  if (loading) {
    return (
      <section className="listpage">
        <div className="listpage__skeleton" aria-hidden="true">
          <div className="listpage__skeleton-row" />
        </div>
      </section>
    );
  }

  if (notFound || !report) {
    return (
      <section className="listpage">
        <Link to="/reports" className="report__back">← {t('report.back')}</Link>
        <div className="listpage__empty">
          <p>{t('report.noReport')}</p>
        </div>
      </section>
    );
  }

  // 判別報告類型:emulator 報告有 navGraph / steps 帶 screenshotUrl。
  const emuSteps = (report.steps as EmuStep[] | undefined)?.filter(
    (s) => s.action !== undefined,
  );
  const isEmulator = Boolean(report.navGraph || emuSteps?.some((s) => s.screenshotUrl));

  return (
    <section className="listpage report">
      <Link to="/reports" className="report__back">← {t('report.back')}</Link>

      <header className="listpage__header">
        <h1 className="listpage__title">{t('report.title')}</h1>
        <p className="report__state">{t(`state.${report.state}` as MessageKey)}</p>
      </header>

      {report.task && <p className="report__task">{report.task}</p>}

      {/* 花費 */}
      <div className="report__cost">
        {report.budgetUsd !== undefined && (
          <span>
            {t('report.budget')}:{' '}
            {report.budgetUsd === null ? t('report.notBudgeted') : `$${report.budgetUsd.toFixed(2)}`}
          </span>
        )}
        {report.tokens && (
          <span>
            {t('report.tokens')}: {report.tokens.input + report.tokens.output} tok
          </span>
        )}
        {report.vlmModel && <span className="report__model">{report.vlmModel.replace(/^us\./, '')}</span>}
      </div>

      {isEmulator ? (
        <EmulatorReport
          steps={emuSteps ?? []}
          navGraph={report.navGraph}
          onOpen={setLightbox}
        />
      ) : (
        <WebNarrativeReport
          report={report}
          narrativeLang={narrativeLang}
          setNarrativeLang={setNarrativeLang}
          locale={locale}
        />
      )}

      {lightbox && (
        <div className="report__lightbox" role="dialog" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" />
        </div>
      )}
    </section>
  );
}

/** emulator 報告:遊戲畫面畫廊 + 導覽關係圖 + 逐步 trace。 */
function EmulatorReport({
  steps,
  navGraph,
  onOpen,
}: {
  steps: EmuStep[];
  navGraph?: { nodes: NavNode[]; edges: NavEdge[] };
  onOpen: (url: string) => void;
}) {
  const { t } = useI18n();
  const shots = steps.filter((s) => s.annotatedUrl || s.screenshotUrl);

  return (
    <>
      {/* 遊戲畫面畫廊(標註圖優先) */}
      <h2 className="report__subtitle">{t('report.gameplay')}</h2>
      {shots.length === 0 ? (
        <p className="report__empty-note">{t('report.noScreens')}</p>
      ) : (
        <div className="report__gallery">
          {shots.map((s) => {
            const url = s.annotatedUrl ?? s.screenshotUrl!;
            return (
              <figure key={s.stepNumber} className="report__shot">
                <button type="button" className="report__shot-btn" onClick={() => onOpen(url)} title={t('report.viewFull')}>
                  <img src={url} alt={`step ${s.stepNumber}`} loading="lazy" />
                </button>
                <figcaption>
                  #{s.stepNumber} {s.action}
                  {s.screen ? ` · ${s.screen}` : ''}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}

      {/* 導覽關係圖 */}
      {navGraph && navGraph.nodes.length > 0 && (
        <>
          <h2 className="report__subtitle">{t('report.navGraph')}</h2>
          <p className="report__empty-note">{t('report.navGraphHint')}</p>
          <NavGraph nodes={navGraph.nodes} edges={navGraph.edges} />
        </>
      )}

      {/* 逐步 trace */}
      <h2 className="report__subtitle">
        {t('report.trace')} ({steps.length})
      </h2>
      <ol className="report__trace">
        {steps.map((s) => (
          <li key={s.stepNumber} className="report__trace-step">
            <div className="report__trace-head">
              <span className="report__step-idx">#{s.stepNumber}</span>
              <span className="report__trace-action">{s.action}</span>
              {s.screen && <span className="report__trace-screen">{s.screen}</span>}
              {s.coords && (
                <span className="report__trace-coords">({s.coords.x}, {s.coords.y})</span>
              )}
              {typeof s.durationMs === 'number' && (
                <span className="report__trace-dur">{(s.durationMs / 1000).toFixed(1)}s</span>
              )}
            </div>
            {s.reason && <p className="report__trace-reason">{s.reason}</p>}
          </li>
        ))}
      </ol>
    </>
  );
}

/** web 後端:多語 AI 敘述報告(原有邏輯)。 */
function WebNarrativeReport({
  report,
  narrativeLang,
  setNarrativeLang,
  locale,
}: {
  report: ReportDoc;
  narrativeLang: string;
  setNarrativeLang: (l: string) => void;
  locale: Locale;
}) {
  const { t } = useI18n();
  const langs = report.availableLanguages ?? [];
  const hasSelected = langs.includes(narrativeLang);
  const shownLang = hasSelected ? narrativeLang : 'en';
  const narrative = report.narratives?.[shownLang] ?? '';
  const isFallback = !hasSelected;
  const steps = (report.steps as Array<Record<string, unknown>> | undefined) ?? [];

  return (
    <>
      {report.billableSpendUsd !== undefined && (
        <div className="report__cost">
          <span>{t('report.spend')}: ${report.billableSpendUsd.toFixed(2)}</span>
        </div>
      )}
      <div className="report__narrative-box">
        <div className="report__narrative-head">
          <h2 className="report__subtitle">{t('report.summary')}</h2>
          <label className="report__lang">
            <span className="visually-hidden">{t('report.narrativeLang')}</span>
            <select
              value={narrativeLang}
              onChange={(e) => setNarrativeLang(e.target.value)}
              aria-label={t('report.narrativeLang')}
            >
              {langs.map((l) => (
                <option key={l} value={l}>{LOCALE_LABELS[l as Locale] ?? l}</option>
              ))}
              {!langs.includes(locale) && (
                <option value={locale}>{LOCALE_LABELS[locale] ?? locale}</option>
              )}
            </select>
          </label>
        </div>
        <p className="report__narrative">{narrative}</p>
        {isFallback && (
          <p className="report__fallback" role="note">{t('report.fallbackNote')}</p>
        )}
      </div>

      <h2 className="report__subtitle">
        {t('report.steps')} ({report.stepCount ?? steps.length})
      </h2>
      <ol className="report__steps">
        {steps.map((s, i) => (
          <li key={i} className="report__step">
            <span className="report__step-idx">#{String(s['index'] ?? i)}</span>
            {typeof s['action'] === 'string' && <span className="report__step-action">{s['action']}</span>}
            {typeof s['url'] === 'string' && <span className="report__step-url">{s['url']}</span>}
            {typeof s['httpStatus'] === 'number' && <span>HTTP {s['httpStatus']}</span>}
            {typeof s['observedTitle'] === 'string' && <span className="report__step-title">{s['observedTitle']}</span>}
          </li>
        ))}
      </ol>
    </>
  );
}
