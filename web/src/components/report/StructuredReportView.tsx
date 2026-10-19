import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import type { MessageKey } from '../../i18n/messages.ts';
import { CaseVersionBadge } from '../cases/CaseVersions.tsx';
import { AcceptancePanel } from './AcceptancePanel.tsx';
import { SlotCapturePanel } from './SlotCapturePanel.tsx';
import { InsightsPanel } from './InsightsPanel.tsx';
import { ReportChart } from './ReportChart.tsx';
import { ResultPill, VerdictMatrix, type CheckFilter } from './VerdictMatrix.tsx';
import type { ChartData, CoverageItem, EvidenceStep, Finding, L10n, MetricValue, ReportInsights, StructuredReport } from './reportTypes.ts';
import {
  CATEGORY_TEXT,
  DIMENSION_TEXT,
  SCOPE_TEXT,
  STATUS_TEXT,
  reportLang,
  tr,
  txt,
  type RLang,
  type TextKey,
} from './reportText.ts';
import './StructuredReport.css';

/**
 * 結構化測試報告(固定章節順序,對齊測試顧問規格 §43)。
 * 所有數字與判定來自後端報告引擎(程式計算 + 規則引擎);本元件只負責呈現。
 * Game Quality 與 AI Testing Quality 全程分開呈現。
 */

const RESULT_CHARTS = new Set(['assertion_donut', 'module_pass_bar', 'severity_bar', 'category_bar', 'classification_donut']);
const AI_CHARTS = new Set(['action_bar', 'confidence_line', 'latency_line']);
const PERF_CHARTS = new Set(['fps_line', 'frametime_bar', 'cpu_line', 'gpu_line', 'mem_line', 'temp_line']);
const COVERAGE_CHARTS = new Set(['state_bar']);
const VISUAL_CATS = new Set(['graphics', 'animation', 'ui']);

/**
 * 哪些執行狀態算「跑完了」—— 只有這些才自動產生 AI 分析。
 * 執行中就產生的話,數字還在變,分析一打開就過時。
 */
const INSIGHTS_AUTO_STATES = new Set([
  'pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead',
]);

type SectionId =
  | 'cover' | 'acceptance' | 'boardCapture' | 'executive' | 'insights' | 'verdicts' | 'environment' | 'scope' | 'dashboard' | 'coverage' | 'results' | 'modules'
  | 'genre' | 'mechanics' | 'progression' | 'economy' | 'performance' | 'stability' | 'visual' | 'ux'
  | 'aiReliability' | 'defects' | 'criticalDefects' | 'testCase' | 'evidence' | 'risk' | 'release' | 'appendix';

export function StructuredReportView({
  report,
  onOpenImage,
  appendix,
  jobId,
  insights: initialInsights,
}: {
  report: StructuredReport;
  onOpenImage: (url: string) => void;
  appendix?: ReactNode;
  /** 有值才顯示「產生 AI 分析」按鈕。 */
  jobId?: string;
  insights?: { zh?: ReportInsights; en?: ReportInsights };
}) {
  const { locale, t } = useI18n();
  const lang = reportLang(locale);
  const r = report;
  const checks = r.checks ?? [];
  const [checkFilter, setCheckFilter] = useState<CheckFilter>('all');
  const [moduleFilter, setModuleFilter] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  /** 直接打開某一筆判定(里程碑清單點擊):清除篩選、展開該列並捲動過去。 */
  const openCheck = (id: string) => {
    setCheckFilter('all');
    setModuleFilter(null);
    setFocus((p) => ({ id, n: (p?.n ?? 0) + 1 }));
  };
  const [insights, setInsights] = useState(initialInsights);
  const [active, setActive] = useState<string>('cover');
  const ins = insights?.[lang] ?? insights?.[lang === 'zh' ? 'en' : 'zh'];
  const notes: Record<string, L10n> = ins?.notes ?? {};
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  /** 跳到判定明細並套用篩選(數字點擊 → 讓使用者看到每一筆判定的依據、截圖與修正建議)。 */
  const goVerdicts = (f: CheckFilter, module: string | null = null) => {
    setCheckFilter(f);
    setModuleFilter(module);
    scrollTo('srep-verdicts');
  };
  const goFinding = (id: string) => {
    const el = document.getElementById(`srep-f-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('is-flash');
    window.setTimeout(() => el.classList.remove('is-flash'), 1600);
  };
  const unclearCount = r.counts.unclear ?? checks.filter((c) => c.result === 'unclear').length;
  const milestones = checks.filter((c) => c.kind === 'milestone');
  const genreName = (g?: string) => (g ? t(`genre.${g}` as MessageKey) : '—');
  const labelOf = (x: string) => {
    if (STATUS_TEXT[x]) return tr(STATUS_TEXT[x], lang);
    if (CATEGORY_TEXT[x]) return tr(CATEGORY_TEXT[x], lang);
    return x;
  };

  const metric = (id: string) => r.metrics.find((m) => m.id === id);
  const group = (g: string) => r.metrics.filter((m) => m.group === g);
  const genreCharts = r.charts.filter((c) => !RESULT_CHARTS.has(c.id) && !AI_CHARTS.has(c.id) && !PERF_CHARTS.has(c.id) && !COVERAGE_CHARTS.has(c.id));
  const charts = (ids: Set<string>) => r.charts.filter((c) => ids.has(c.id));
  const gameDefects = r.findings.filter((f) => f.classification === 'GAME_FAILURE');
  const triage = r.findings.filter((f) => f.classification === 'NEEDS_TRIAGE');
  const visual = r.findings.filter((f) => VISUAL_CATS.has(f.category));
  const hasSection = (s: string) => r.sections.includes(s);

  const sections: Array<{ id: SectionId; key: TextKey; show: boolean }> = [
    { id: 'cover', key: 'cover', show: true },
    { id: 'acceptance', key: 'acceptance', show: Boolean(r.acceptance) },
    { id: 'boardCapture', key: 'boardCapture', show: Boolean(r.slotCapture) },
    { id: 'executive', key: 'executive', show: true },
    { id: 'verdicts', key: 'verdicts', show: checks.length > 0 },
    { id: 'insights', key: 'insights', show: Boolean(jobId) || Boolean(ins) },
    { id: 'environment', key: 'environment', show: true },
    { id: 'scope', key: 'scope', show: true },
    { id: 'dashboard', key: 'dashboard', show: true },
    { id: 'coverage', key: 'coverage', show: true },
    { id: 'results', key: 'results', show: true },
    { id: 'modules', key: 'modules', show: true },
    { id: 'genre', key: 'genre', show: group('genre').length > 0 || genreCharts.length > 0 },
    { id: 'mechanics', key: 'mechanics', show: r.mechanics.length > 0 },
    { id: 'progression', key: 'progression', show: hasSection('progression') },
    { id: 'economy', key: 'economy', show: hasSection('economy') },
    { id: 'performance', key: 'performance', show: true },
    { id: 'stability', key: 'stability', show: true },
    { id: 'visual', key: 'visual', show: true },
    { id: 'ux', key: 'ux', show: true },
    { id: 'aiReliability', key: 'aiReliability', show: true },
    { id: 'defects', key: 'defects', show: true },

    { id: 'testCase', key: 'testCase', show: true },
    { id: 'evidence', key: 'evidence', show: r.evidence.length > 0 },
    { id: 'risk', key: 'risk', show: true },
    { id: 'release', key: 'release', show: true },
    { id: 'appendix', key: 'appendix', show: true },
  ];
  const visible = sections.filter((s) => s.show);
  const num = (id: SectionId) => visible.findIndex((s) => s.id === id) + 1;
  // 以函式呼叫(非元件)產生標題:若寫成 render 內定義的元件,每次重繪都會換一個元件型別,
  // React 會卸載重建所有 <h2>,導致目錄捲動追蹤失效。
  const H = (id: SectionId) => (
    <h2 className="srep__h2" id={`srep-${id}`}>
      {num(id)}. {txt(sections.find((s) => s.id === id)!.key, lang)}
    </h2>
  );

  const h = r.header;
  const dur = (ms?: number) => (ms === undefined ? '—' : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
  const time = (iso?: string) => (iso ? new Date(iso).toLocaleString(locale) : '—');

  // 目錄高亮目前閱讀的章節。
  const visibleKey = visible.map((s) => s.id).join(',');
  // 每次捲動都重新查詢標題位置:取「頂端已越過閱讀線」的最後一個章節;捲到底時選最後一章。
  // capture 監聽可同時涵蓋 window 與內層捲動容器。
  useEffect(() => {
    const ids = visibleKey.split(',');
    const OFFSET = 120;
    let raf = 0;
    const update = () => {
      raf = 0;
      let current = ids[0] ?? 'cover';
      for (const id of ids) {
        const el = document.getElementById(`srep-${id}`);
        if (!el) continue;
        if (el.getBoundingClientRect().top - OFFSET <= 0) current = id;
        else break;
      }
      const doc = document.documentElement;
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) current = ids[ids.length - 1] ?? current;
      setActive((prev) => (prev === current ? prev : current));
    };
    const onScroll = () => { if (!raf) raf = window.requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [visibleKey]);

  const totalShown = Math.max(1, r.counts.totalChecks);
  const seg = (n: number) => `${(n / totalShown) * 100}%`;
  const stepsRun = r.evidence.length;

  return (
    <div className="srep">
      <aside className="srep__side">
        <nav className="srep__toc" aria-label={txt('toc', lang)}>
          <strong className="srep__toc-title">{txt('toc', lang)}</strong>
          <ol>
            {visible.map((s, i) => (
              <li key={s.id}>
                <a href={`#srep-${s.id}`} className={active === s.id ? 'is-active' : ''} aria-current={active === s.id ? 'location' : undefined}
                  onClick={(e) => { e.preventDefault(); scrollTo(`srep-${s.id}`); }}>
                  <span className="srep__toc-num">{i + 1}</span>{txt(s.key, lang)}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <button type="button" className="srep__print" onClick={() => window.print()}>{txt('print', lang)}</button>
      </aside>

      <div className="srep__main">
      {/* 1. Cover */}
      <section className={`srep__section srep__hero srep__hero--${r.overallStatus}`}>
        {H('cover')}
        <div className="srep__cover">
          <div className="srep__cover-id">
            <div className="srep__eyebrow">
              {lang === 'zh' ? '遊戲測試報告' : 'Game Test Report'} · {r.testCase.name}
              {h.caseVersion && <> · <CaseVersionBadge version={h.caseVersion} title={txt('caseVersion', lang)} /></>}
            </div>
            <div className="srep__cover-game">{h.gameName ?? '—'}</div>
            <div className="srep__muted">
              {[h.gameVersion && `v${h.gameVersion}`, genreName(h.genre), ...h.secondaryGenres.map(genreName)].filter(Boolean).join(' · ')}
            </div>
            <div className="srep__mono">{h.reportId}</div>
          </div>
          <div className="srep__badges">
            <StatusBadge kind="status" value={r.overallStatus} lang={lang} label={txt('overall', lang)} />
            <StatusBadge kind="release" value={r.release.readiness} lang={lang} label={txt('readiness', lang)} />
          </div>
        </div>
        <p className="srep__reason">{tr(r.statusReason, lang)}</p>
        <dl className="srep__facts" aria-label={txt('keyFacts', lang)}>
          <div><dt>{txt('caseVersion', lang)}</dt><dd className="srep__mono">{h.caseVersion ?? '—'}</dd></div>
          <div><dt>{txt('device', lang)}</dt><dd>{h.device ?? '—'}</dd></div>
          <div><dt>{txt('platform', lang)}</dt><dd>{[h.platform, h.operatingSystem].filter(Boolean).join(' ') || '—'}</dd></div>
          <div><dt>{txt('start', lang)}</dt><dd>{time(h.testStartTime)}</dd></div>
          <div><dt>{txt('duration', lang)}</dt><dd>{dur(h.testDurationMs)}</dd></div>
          <div><dt>{txt('stepsRun', lang)}</dt><dd>{stepsRun}</dd></div>
          <div><dt>{txt('aiModel', lang)}</dt><dd>{h.aiModelVersion?.replace(/^us\./, '') ?? '—'}</dd></div>
        </dl>
      </section>

      {/* 驗收結論與標準(唯一結論來源;每項附證據步驟) */}
      {r.acceptance && (
        <section className="srep__section">
          {H('acceptance')}
          <AcceptancePanel acceptance={r.acceptance} evidence={r.evidence} lang={lang} onOpenImage={onOpenImage} onOpenFinding={goFinding} />
        </section>
      )}

      {r.slotCapture && (
        <section className="srep__section">
          {H('boardCapture')}
          <SlotCapturePanel capture={r.slotCapture} lang={lang} onOpenImage={onOpenImage} />
        </section>
      )}

      {/* 2. Executive Summary */}
      <section className="srep__section">
        {H('executive')}
        <ul className="srep__summary">
          {r.summaryLines.map((l, i) => <li key={i}>{tr(l, lang)}</li>)}
        </ul>

        <div className="srep__verdict-tiles" role="group" aria-label={txt('verdicts', lang)}>
          <Tile label={txt('totalChecks', lang)} value={r.counts.totalChecks} onClick={checks.length ? () => goVerdicts('all') : undefined} hint={txt('clickToFilter', lang)} />
          <Tile label={txt('passed', lang)} value={r.counts.passed} tone="pass" onClick={checks.length ? () => goVerdicts('pass') : undefined} hint={txt('clickToFilter', lang)} />
          <Tile label={txt('failed', lang)} value={r.counts.failed} tone={r.counts.failed ? 'fail' : undefined} onClick={checks.length ? () => goVerdicts('fail') : undefined} hint={txt('clickToFilter', lang)} />
          <Tile label={txt('unclear', lang)} value={unclearCount} tone={unclearCount ? 'warn' : undefined} onClick={checks.length ? () => goVerdicts('unclear') : undefined} hint={txt('clickToFilter', lang)} />
          <Tile label={txt('skipped', lang)} value={r.counts.skipped} onClick={checks.length ? () => goVerdicts('skipped') : undefined} hint={txt('clickToFilter', lang)} />
          <Tile label={txt('passRate', lang)} value={r.counts.passRate} unit="%" lang={lang} />
        </div>
        {r.counts.totalChecks > 0 && (
          <div className="srep__stack" aria-hidden="true">
            <span className="is-pass" style={{ width: seg(r.counts.passed) }} />
            <span className="is-fail" style={{ width: seg(r.counts.failed) }} />
            <span className="is-unclear" style={{ width: seg(unclearCount) }} />
            <span className="is-skipped" style={{ width: seg(r.counts.skipped) }} />
          </div>
        )}

        {milestones.length > 0 && (
          <>
            <h3 className="srep__h3">{txt('overallMilestones', lang)}</h3>
            <ol className="srep__ms" aria-label={txt('overallMilestones', lang)}>
              {milestones.map((c) => (
                <li key={c.id}>
                  <button type="button" className={`srep__ms-item srep__ms-item--${c.result}`} onClick={() => openCheck(c.id)}>
                    <span className="srep__ms-icon" aria-hidden="true">{c.result === 'pass' ? '✓' : c.result === 'fail' ? '✕' : '?'}</span>
                    <span className="srep__ms-text">
                      <strong>{c.title ? tr(c.title, lang) : c.expected}</strong>
                      <small>{c.reason ?? ''}</small>
                    </span>
                    <ResultPill r={c.result} lang={lang} />
                    <span className="srep__ms-go" aria-hidden="true">→</span>
                  </button>
                </li>
              ))}
            </ol>
          </>
        )}

        <h3 className="srep__h3">{txt('gameDefects', lang)}</h3>
        <div className="srep__verdict-tiles srep__verdict-tiles--sev">
          {(['critical', 'high', 'medium', 'low'] as const).map((s) => (
            <Tile key={s} label={s[0]!.toUpperCase() + s.slice(1)} value={r.counts.defects[s]} sev={s}
              tone={r.counts.defects[s] ? (s === 'critical' ? 'fail' : s === 'high' ? 'warn' : undefined) : undefined}
              onClick={() => scrollTo('srep-defects')} hint={txt('defectDetails', lang)} />
          ))}
          <Tile label={tr(STATUS_TEXT['NEEDS_TRIAGE'], lang)} value={triage.length} tone={triage.length ? 'warn' : undefined} onClick={() => scrollTo('srep-defects')} hint={txt('defectDetails', lang)} />
          <Tile label={tr(STATUS_TEXT['AI_TEST_FAILURE'], lang)} value={r.aiFailures.length} onClick={() => scrollTo('srep-aiReliability')} hint={txt('aiReliability', lang)} />
        </div>

        <div className="srep__kpis srep__kpis--secondary">
          <Kpi label={txt('executed', lang)} value={r.counts.executedChecks} />
          <Kpi label={txt('blocked', lang)} value={r.counts.blocked} />
          <Kpi label={txt('executionRate', lang)} value={r.counts.executionRate} unit="%" lang={lang} />
          {['crash_count', 'crash_rate_per_hour', 'fps_avg', 'fps_min', 'avg_vlm_ms', 'wall_clock_s', 'ai_action_count', 'ai_successful_actions', 'ai_action_success_rate'].map((id) => {
            const m = metric(id);
            return m ? <Kpi key={id} label={tr(m.label, lang)} value={m.value} unit={m.unit} lang={lang} /> : null;
          })}
        </div>
      </section>

      {/* 判定明細 */}
      {checks.length > 0 && (
        <section className="srep__section">
          {H('verdicts')}
          <p className="srep__note srep__note--top">{txt('verdictsHint', lang)}</p>
          <VerdictMatrix
            checks={checks}
            evidence={r.evidence}
            lang={lang}
            filter={checkFilter}
            onFilter={setCheckFilter}
            notes={notes}
            onOpenImage={onOpenImage}
            onGoFinding={goFinding}
            modules={r.modules}
            moduleFilter={moduleFilter}
            onModuleFilter={setModuleFilter}
            focus={focus}
          />
        </section>
      )}

      {/* AI 分析 */}
      {visible.some((s) => s.id === 'insights') && (
        <section className="srep__section">
          {H('insights')}
          <InsightsPanel
            {...(jobId ? { jobId } : {})}
            lang={lang}
            {...(insights ? { insights } : {})}
            onChange={setInsights}
            // 執行中的任務不自動產生(數字還在變,分析馬上就過時);終局才自動跑一次。
            autoGenerate={INSIGHTS_AUTO_STATES.has(r.terminal.state)}
            evidence={r.evidence}
            onOpenImage={onOpenImage}
            onGoFinding={goFinding}
          />
        </section>
      )}

      {/* 3. Environment */}
      <section className="srep__section">
        {H('environment')}
        <dl className="srep__kv">
          <KV k={txt('reportId', lang)} v={h.reportId} />
          <KV k={txt('caseVersion', lang)} v={h.caseVersion} />
          <KV k={txt('gameName', lang)} v={h.gameName} />
          <KV k={txt('gameVersion', lang)} v={h.gameVersion} />
          <KV k={txt('build', lang)} v={h.buildNumber} />
          <KV k={txt('genreLabel', lang)} v={genreName(h.genre)} />
          <KV k={txt('secondaryGenre', lang)} v={h.secondaryGenres.map(genreName).join(', ') || undefined} />
          <KV k={txt('platform', lang)} v={h.platform} />
          <KV k={txt('os', lang)} v={h.operatingSystem} />
          <KV k={txt('device', lang)} v={h.device} />
          <KV k={txt('resolution', lang)} v={h.resolution} />
          <KV k={txt('testEnv', lang)} v={h.testEnvironment} />
          <KV k={txt('region', lang)} v={h.serverRegion} />
          <KV k={txt('start', lang)} v={time(h.testStartTime)} />
          <KV k={txt('end', lang)} v={time(h.testEndTime)} />
          <KV k={txt('duration', lang)} v={dur(h.testDurationMs)} />
          <KV k={txt('aiModel', lang)} v={h.aiModelVersion?.replace(/^us\./, '')} />
          <KV k={txt('agentModel', lang)} v={h.agentModel} />
          <KV k={txt('engine', lang)} v={h.testEngineVersion} />
          <KV k={txt('kbVersion', lang)} v={h.knowledgeBaseVersions.join(', ') || undefined} />
          <KV k={txt('planVersion', lang)} v={h.testPlanVersion} />
        </dl>
      </section>

      {/* 4. Scope */}
      <section className="srep__section">
        {H('scope')}
        <div className="srep__chips">
          {r.scope.map((s) => (
            <span key={s.id} className={`srep__chip srep__chip--${s.status}`}>
              {tr(SCOPE_TEXT[s.id], lang) || s.id}
              <small>{s.status === 'executed' ? txt('executed', lang) : s.status === 'not_executed' ? txt('notExecuted', lang) : txt('notApplicable', lang)}{s.selected ? ` · ${txt('selected', lang)}` : ''}</small>
            </span>
          ))}
        </div>
      </section>

      {/* 5. Quality Dashboard */}
      <section className="srep__section">
        {H('dashboard')}
        <div className="srep__dims">
          {r.dashboard.map((d) => (
            <div key={d.dimension} className={`srep__dim ${d.score === null ? 'srep__dim--na' : ''}`}>
              <div className="srep__dim-head">
                <span>{tr(DIMENSION_TEXT[d.dimension], lang) || d.dimension}</span>
                <strong>{d.score === null ? txt('notExecuted', lang) : d.score}</strong>
              </div>
              {d.score !== null && (
                <div className="srep__meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.score} aria-label={tr(DIMENSION_TEXT[d.dimension], lang)}>
                  <span style={{ width: `${d.score}%` }} className={d.score >= 80 ? 'is-good' : d.score >= 60 ? 'is-warn' : 'is-bad'} />
                </div>
              )}
              <ul className="srep__dim-metrics">
                {d.metrics.map((id) => {
                  const m = metric(id);
                  return m ? <li key={id}>{tr(m.label, lang)}: <MetricVal m={m} lang={lang} /></li> : null;
                })}
                {d.findingCount > 0 && <li>{txt('gameDefects', lang)}: {d.findingCount}</li>}
              </ul>
            </div>
          ))}
        </div>
        <p className="srep__note">{txt('scoreFormula', lang)}</p>
      </section>

      {/* 6. Coverage */}
      <section className="srep__section">
        {H('coverage')}
        <div className="srep__grid2">
          <CoverageList title={txt('featureCov', lang)} items={r.coverage.feature} lang={lang} />
          <CoverageList title={txt('scenarioCov', lang)} items={r.coverage.scenario} lang={lang} />
          <CoverageList title={txt('stateCov', lang)} items={r.coverage.gameState} lang={lang} />
          <div>
            <h3 className="srep__h3">{txt('deviceCov', lang)}</h3>
            <dl className="srep__kv srep__kv--compact">
              {r.coverage.device.map((d, i) => <KV key={i} k={tr(d.label, lang)} v={d.value} />)}
            </dl>
          </div>
        </div>
        <MetricGrid metrics={group('coverage')} lang={lang} />
        <Charts list={charts(COVERAGE_CHARTS)} lang={lang} labelOf={labelOf} />
      </section>

      {/* 7. Results */}
      <section className="srep__section">
        {H('results')}
        <Charts list={charts(RESULT_CHARTS)} lang={lang} labelOf={labelOf} empty={txt('noData', lang)} />
      </section>

      {/* Modules */}
      <section className="srep__section">
        {H('modules')}
        <div className="srep__table-wrap">
          <table className="srep__table">
            <thead>
              <tr>
                <th scope="col">{txt('module', lang)}</th>
                <th scope="col">{txt('steps', lang)}</th>
                <th scope="col">{txt('checks', lang)}</th>
                <th scope="col">{txt('passed', lang)}</th>
                <th scope="col">{txt('failed', lang)}</th>
                <th scope="col">{txt('passRate', lang)}</th>
                <th scope="col">Critical</th>
                <th scope="col">High</th>
                <th scope="col">{txt('avgDuration', lang)}</th>
              </tr>
            </thead>
            <tbody>
              {r.modules.map((m) => (
                <tr key={m.id} className={m.steps === 0 ? 'is-dim' : ''}>
                  <th scope="row">{tr(m.label, lang)}</th>
                  <td>{m.steps}</td>
                  <td><CountLink n={m.checks} onClick={checks.length ? () => goVerdicts('all', m.id) : undefined} label={`${tr(m.label, lang)} · ${txt('checks', lang)}`} /></td>
                  <td><CountLink n={m.pass} tone="pass" onClick={checks.length ? () => goVerdicts('pass', m.id) : undefined} label={`${tr(m.label, lang)} · ${txt('passed', lang)}`} /></td>
                  <td><CountLink n={m.fail} tone="fail" onClick={checks.length ? () => goVerdicts('fail', m.id) : undefined} label={`${tr(m.label, lang)} · ${txt('failed', lang)}`} /></td>
                  <td>{m.passRate === null ? '—' : `${m.passRate}%`}</td>
                  <td>{m.critical}</td>
                  <td>{m.high}</td>
                  <td>{m.avgDurationMs === null ? '—' : dur(m.avgDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Genre-specific */}
      {visible.some((s) => s.id === 'genre') && (
        <section className="srep__section">
          {H('genre')}
          <p className="srep__muted">{r.profiles.filter((p) => p.id !== 'global').map((p) => `${tr(p.label, lang)} v${p.version}`).join(' + ')}</p>
          <MetricGrid metrics={group('genre')} lang={lang} />
          <Charts list={genreCharts} lang={lang} labelOf={labelOf} />
        </section>
      )}

      {/* Mechanics */}
      {r.mechanics.length > 0 && (
        <section className="srep__section">
          {H('mechanics')}
          <div className="srep__table-wrap">
            <table className="srep__table">
              <thead>
                <tr>
                  <th scope="col">{txt('mechanics', lang)}</th>
                  <th scope="col">{txt('tested', lang)}</th>
                  <th scope="col">{txt('steps', lang)}</th>
                  <th scope="col">{txt('passed', lang)}</th>
                  <th scope="col">{txt('failed', lang)}</th>
                </tr>
              </thead>
              <tbody>
                {r.mechanics.map((m) => (
                  <tr key={m.id} className={m.tested ? '' : 'is-dim'}>
                    <th scope="row">{tr(m.label, lang)}</th>
                    <td>{m.tested ? '✓' : '—'}</td>
                    <td>{m.steps}</td>
                    <td>{m.pass}</td>
                    <td>{m.fail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {hasSection('progression') && (
        <section className="srep__section">
          {H('progression')}
          <MetricGrid metrics={group('progression')} lang={lang} />
        </section>
      )}
      {hasSection('economy') && (
        <section className="srep__section">
          {H('economy')}
          <MetricGrid metrics={group('economy')} lang={lang} />
        </section>
      )}

      {/* Performance */}
      <section className="srep__section">
        {H('performance')}
        <MetricGrid metrics={group('performance')} lang={lang} />
        <Charts list={charts(PERF_CHARTS)} lang={lang} labelOf={labelOf} />
      </section>

      {/* Stability */}
      <section className="srep__section">
        {H('stability')}
        <MetricGrid metrics={group('stability')} lang={lang} />
      </section>

      {/* Visual */}
      <section className="srep__section">
        {H('visual')}
        <p className="srep__note">{txt('visualHint', lang)}</p>
        {visual.length === 0 ? <p className="srep__muted">{txt('noFindings', lang)}</p> : (
          <div className="srep__findings">
            {visual.map((f) => <FindingCard key={f.id} f={f} lang={lang} onOpenImage={onOpenImage} />)}
          </div>
        )}
      </section>

      {/* UX */}
      <section className="srep__section">
        {H('ux')}
        <p className="srep__note">{txt('uxHint', lang)}</p>
        <MetricGrid metrics={r.metrics.filter((m) => ['retry_rate', 'stuck_count', 'navigation_failure_count', 'unique_screens'].includes(m.id))} lang={lang} />
        {r.findings.filter((f) => f.category === 'ux').map((f) => <FindingCard key={f.id} f={f} lang={lang} onOpenImage={onOpenImage} />)}
      </section>

      {/* AI Reliability */}
      <section className="srep__section">
        {H('aiReliability')}
        <MetricGrid metrics={group('ai_reliability')} lang={lang} />
        <Charts list={charts(AI_CHARTS)} lang={lang} labelOf={labelOf} />
        <h3 className="srep__h3">{txt('aiFailures', lang)} ({r.aiFailures.length})</h3>
        {r.aiFailures.length === 0 ? <p className="srep__muted">{txt('noFindings', lang)}</p> : (
          <div className="srep__findings">
            {r.aiFailures.map((f) => <FindingCard key={f.id} f={f} lang={lang} onOpenImage={onOpenImage} compact anchor note={notes[f.id]} />)}
          </div>
        )}
      </section>

      {/* Defects */}
      <section className="srep__section">
        {H('defects')}
        <div className="srep__kpis">
          <Kpi label={txt('gameDefects', lang)} value={gameDefects.length} tone={gameDefects.length ? 'fail' : 'pass'} />
          <Kpi label={tr(STATUS_TEXT['NEEDS_TRIAGE'], lang)} value={triage.length} tone={triage.length ? 'warn' : undefined} />
          <Kpi label={tr(STATUS_TEXT['AI_TEST_FAILURE'], lang)} value={r.aiFailures.length} />
        </div>
        {r.findings.length === 0 ? <p className="srep__muted">{txt('noFindings', lang)}</p> : (
          <div className="srep__table-wrap">
            <table className="srep__table">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">{txt('severity', lang)}</th>
                  <th scope="col">{txt('category', lang)}</th>
                  <th scope="col">{txt('classification', lang)}</th>
                  <th scope="col">{txt('certainty', lang)}</th>
                  <th scope="col">{txt('frequency', lang)}</th>
                  <th scope="col">{txt('result', lang)}</th>
                  <th scope="col">{txt('suggestion', lang)}</th>
                </tr>
              </thead>
              <tbody>
                {r.findings.map((f) => (
                  <tr key={f.id}>
                    <td className="srep__mono"><button type="button" className="vm__link" onClick={() => goFinding(f.id)}>{f.id}</button></td>
                    <td><SevTag sev={f.severity} /></td>
                    <td>{tr(CATEGORY_TEXT[f.category], lang) || f.category}</td>
                    <td>{tr(STATUS_TEXT[f.classification], lang)}</td>
                    <td>{tr(STATUS_TEXT[f.certainty], lang)}</td>
                    <td>{f.frequency}</td>
                    <th scope="row">{tr(f.title, lang)}</th>
                    <td className="vm__wrap"><span className="vm__clamp">{f.suggestion ? tr(f.suggestion, lang) : '—'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {r.findings.length > 0 && (
          <>
            <h3 className="srep__h3">{txt('defectDetails', lang)}</h3>
            <div className="srep__findings">
              {[...r.findings].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity)).map((f) => (
                <FindingCard key={f.id} f={f} lang={lang} onOpenImage={onOpenImage} anchor note={notes[f.id]} />
              ))}
            </div>
          </>
        )}
      </section>



      {/* Test Case */}
      <section className="srep__section">
        {H('testCase')}
        <dl className="srep__kv">
          <KV k={txt('caseId', lang)} v={r.testCase.id} />
          <KV k={txt('caseName', lang)} v={r.testCase.name} />
          <KV k={txt('caseVersion', lang)} v={r.testCase.version ?? (r.testCase.category === 'exploration' ? undefined : txt('caseVersionLegacy', lang))} />
          <KV k={txt('category', lang)} v={r.testCase.category} />
          <KV k={txt('module', lang)} v={r.testCase.module} />
          <KV k={txt('priority', lang)} v={r.testCase.priority} />
          <KV k={txt('severity', lang)} v={r.testCase.severity} />
          <KV k={txt('precondition', lang)} v={r.testCase.precondition} />
          <KV k={txt('input', lang)} v={r.testCase.input} />
          <KV k={txt('testSteps', lang)} v={r.testCase.testSteps} wide />
          <KV k={txt('expected', lang)} v={r.testCase.expectedResult} wide />
          <KV k={txt('actual', lang)} v={r.testCase.actualResult} wide />
          <KV k={txt('result', lang)} v={tr(STATUS_TEXT[r.testCase.result], lang)} />
          <KV k={txt('start', lang)} v={time(r.testCase.startTime)} />
          <KV k={txt('end', lang)} v={time(r.testCase.endTime)} />
          <KV k={txt('duration', lang)} v={dur(r.testCase.durationMs)} />
          <KV k={txt('aiGenerated', lang)} v={r.testCase.aiGenerated ? '✓' : '—'} />
          <KV k={txt('confidence', lang)} v={r.testCase.aiConfidence !== undefined ? r.testCase.aiConfidence.toFixed(2) : undefined} />
          <KV k={txt('agentModel', lang)} v={r.testCase.agentModel} />
          <KV k={txt('aiModel', lang)} v={r.testCase.vlmModel?.replace(/^us\./, '')} />
          <KV k={txt('retry', lang)} v={String(r.testCase.retryCount)} />
          <KV k={txt('recovery', lang)} v={String(r.testCase.recoveryCount)} />
        </dl>
      </section>

      {/* Evidence */}
      {r.evidence.length > 0 && (
        <section className="srep__section">
          {H('evidence')}
          <EvidenceTrace steps={r.evidence} lang={lang} onOpenImage={onOpenImage} />
        </section>
      )}

      {/* Risk */}
      <section className="srep__section">
        {H('risk')}
        {r.risks.length === 0 ? <p className="srep__muted">{txt('noRisks', lang)}</p> : (
          <div className="srep__findings">
            {r.risks.map((k) => (
              <article key={k.id} className={`srep__card srep__card--${k.level}`}>
                <header className="srep__card-head"><SevTag sev={k.level} /> <strong>{tr(k.title, lang)}</strong></header>
                <dl className="srep__kv srep__kv--compact">
                  <KV k={txt('riskEvidence', lang)} v={tr(k.evidence, lang)} wide />
                  <KV k={txt('impact', lang)} v={tr(k.impact, lang)} wide />
                  <KV k={txt('affected', lang)} v={k.affected ? tr(k.affected, lang) : undefined} />
                  <KV k={txt('frequency', lang)} v={k.frequency !== undefined ? String(k.frequency) : undefined} />
                  <KV k={txt('related', lang)} v={[...k.relatedFindings, ...k.relatedSteps.map((s) => `#${s}`)].join(', ') || undefined} wide />
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Release */}
      <section className="srep__section">
        {H('release')}
        <StatusBadge kind="release" value={r.release.readiness} lang={lang} label={txt('readiness', lang)} large />
        <p className="srep__note">{txt('readinessNote', lang)}</p>
        <h3 className="srep__h3">{txt('rulesHit', lang)}</h3>
        {r.release.hits.length === 0 ? <p className="srep__muted">{txt('noRulesHit', lang)}</p> : (
          <ul className="srep__rules">
            {r.release.hits.map((hit) => (
              <li key={hit.ruleId}>
                <span className={`srep__rule-outcome srep__rule-outcome--${hit.outcome}`}>{tr(STATUS_TEXT[hit.outcome], lang) || hit.outcome}</span>
                {tr(hit.reason, lang)}
                <code className="srep__mono">{hit.metric} = {hit.actual ?? '—'} {hit.op} {hit.threshold}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Appendix */}
      <section className="srep__section">
        {H('appendix')}
        <h3 className="srep__h3">{txt('notes', lang)}</h3>
        <ul className="srep__summary">{r.notes.map((n, i) => <li key={i}>{tr(n, lang)}</li>)}</ul>
        <DataQualityTables q={r.dataQuality} lang={lang} />
        <h3 className="srep__h3">{txt('profiles', lang)}</h3>
        <p className="srep__muted">{r.profiles.map((p) => `${tr(p.label, lang)} v${p.version}`).join(' + ')}</p>
        {Object.keys(r.spec.values).length > 0 && (
          <>
            <h3 className="srep__h3">{txt('specValues', lang)}</h3>
            <p className="srep__mono">{Object.entries(r.spec.values).map(([k, v]) => `${k}=${v}`).join(', ')} ({r.spec.sources.join(', ')})</p>
          </>
        )}
        <details className="srep__details">
          <summary>{txt('thresholds', lang)}</summary>
          <p className="srep__mono">{Object.entries(r.release.thresholds).map(([k, v]) => `${k}=${v}`).join(' · ')}</p>
        </details>
        {appendix}
      </section>
      </div>
    </div>
  );
}

const SEV_ORDER = ['critical', 'high', 'medium', 'low'];

function Tile({ label, value, unit, tone, lang, onClick, hint, sev }: {
  label: string; value: number | null; unit?: string; tone?: 'pass' | 'fail' | 'warn'; lang?: RLang;
  onClick?: () => void; hint?: string; sev?: string;
}) {
  const body = (
    <>
      <span className="srep__tile-label">{sev && <span className={`srep__dot srep__dot--${sev}`} aria-hidden="true" />}{label}</span>
      <span className={`srep__tile-value ${value === null ? 'is-na' : ''}`}>
        {value === null ? txt('notCollected', lang ?? 'en') : `${formatNum(value)}${unit ? unit : ''}`}
      </span>
      {onClick && hint && <span className="srep__tile-hint">{hint} →</span>}
    </>
  );
  const cls = `srep__tile ${tone ? `srep__tile--${tone}` : ''} ${onClick ? 'is-clickable' : ''}`;
  return onClick ? (
    <button type="button" className={cls} onClick={onClick}>{body}</button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

// ───────── 子元件 ─────────

/** 表格內的數字:> 0 且可跳轉時呈現為連結按鈕(跳到判定明細並篩選)。 */
function CountLink({ n, onClick, label, tone }: { n: number; onClick?: () => void; label: string; tone?: 'pass' | 'fail' }) {
  if (!onClick || n === 0) return <>{n}</>;
  return (
    <button type="button" className={`srep__count-link ${tone ? `srep__count-link--${tone}` : ''}`} onClick={onClick} aria-label={`${label}: ${n}`}>
      {n}
    </button>
  );
}

function StatusBadge({ kind, value, lang, label, large }: { kind: 'status' | 'release'; value: string; lang: RLang; label: string; large?: boolean }) {
  const tone =
    value === 'PASS' || value === 'READY' ? 'pass'
      : value === 'FAIL' || value === 'NOT_READY' ? 'fail'
        : value === 'BLOCKED' || value === 'INSUFFICIENT_TESTING' ? 'muted'
          : 'warn';
  return (
    <div className={`srep__badge srep__badge--${tone} ${large ? 'srep__badge--large' : ''}`} data-kind={kind}>
      <span className="srep__badge-label">{label}</span>
      <span className="srep__badge-value">{tr(STATUS_TEXT[value], lang) || value}</span>
    </div>
  );
}

function Kpi({ label, value, unit, tone, lang }: { label: string; value: number | null; unit?: string; tone?: 'pass' | 'fail' | 'warn'; lang?: RLang }) {
  return (
    <div className={`srep__kpi ${tone ? `srep__kpi--${tone}` : ''}`}>
      <span className="srep__kpi-label">{label}</span>
      <span className={`srep__kpi-value ${value === null ? 'is-na' : ''}`}>
        {value === null ? txt('notCollected', lang ?? 'en') : `${formatNum(value)}${unit && unit !== 'count' ? ` ${unit}` : ''}`}
      </span>
    </div>
  );
}

function formatNum(v: number): string {
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function MetricVal({ m, lang }: { m: MetricValue; lang: RLang }) {
  if (m.value === null) return <span className="is-na">{txt('notCollected', lang)}</span>;
  return <strong>{formatNum(m.value)}{m.unit && m.unit !== 'count' ? ` ${m.unit}` : ''}</strong>;
}

function MetricGrid({ metrics, lang }: { metrics: MetricValue[]; lang: RLang }) {
  if (metrics.length === 0) return null;
  return (
    <div className="srep__metrics">
      {metrics.map((m) => (
        <div key={m.id} className={`srep__metric ${m.value === null ? 'srep__metric--na' : ''}`}>
          <span className="srep__metric-label">
            {tr(m.label, lang)}
            {m.source === 'ai_evaluation' && <span className="srep__tag" title={txt('aiEval', lang)}>{txt('aiEval', lang)}</span>}
          </span>
          <MetricVal m={m} lang={lang} />
        </div>
      ))}
    </div>
  );
}

function Charts({ list, lang, labelOf, empty }: { list: ChartData[]; lang: RLang; labelOf: (x: string) => string; empty?: string }) {
  if (list.length === 0) return empty ? <p className="srep__muted">{empty}</p> : null;
  return (
    <div className="srep__charts">
      {list.map((c) => <ReportChart key={c.id} chart={c} lang={lang} labelOf={labelOf} />)}
    </div>
  );
}

function CoverageList({ title, items, lang }: { title: string; items: CoverageItem[]; lang: RLang }) {
  const covered = items.filter((i) => i.covered).length;
  return (
    <div>
      <h3 className="srep__h3">{title} <span className="srep__muted">({covered}/{items.length})</span></h3>
      <ul className="srep__cov">
        {items.map((i) => (
          <li key={i.id} className={i.covered ? 'is-covered' : ''}>
            <span aria-hidden="true">{i.covered ? '●' : '○'}</span> {tr(i.label, lang)}
            {i.covered && <small> · {i.steps}{i.basis ? ` · ${txt(i.basis === 'ai' ? 'aiTagged' : 'inferred', lang)}` : ''}</small>}
            <span className="visually-hidden">{i.covered ? txt('executed', lang) : txt('notExecuted', lang)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SevTag({ sev }: { sev: string }) {
  return <span className={`srep__sev srep__sev--${sev}`}>{sev}</span>;
}

function KV({ k, v, wide }: { k: string; v?: string; wide?: boolean }) {
  return (
    <div className={`srep__kv-item ${wide ? 'srep__kv-item--wide' : ''}`}>
      <dt>{k}</dt>
      <dd>{v && v.trim() ? v : '—'}</dd>
    </div>
  );
}

function FindingCard({ f, lang, onOpenImage, compact, anchor, note }: {
  f: Finding; lang: RLang; onOpenImage: (u: string) => void; compact?: boolean;
  /** 加上 id 錨點(判定明細/建議可跳轉到這張卡)。同一缺陷只應有一張卡帶錨點。 */
  anchor?: boolean;
  note?: L10n;
}) {
  const img = f.annotatedUrl ?? f.screenshotUrl;
  return (
    <article className={`srep__card srep__card--${f.severity}`} {...(anchor ? { id: `srep-f-${f.id}` } : {})}>
      <header className="srep__card-head">
        <SevTag sev={f.severity} />
        <span className="srep__mono">{f.id}</span>
        <strong>{tr(f.title, lang)}</strong>
        <span className={`srep__class srep__class--${f.classification}`}>{tr(STATUS_TEXT[f.classification], lang)}</span>
        <span className="srep__tag">{tr(STATUS_TEXT[f.certainty], lang)}</span>
      </header>
      <div className="srep__card-body">
        {img && (
          <button type="button" className="srep__shot" onClick={() => onOpenImage(img)} aria-label={tr(f.title, lang)}>
            <img src={img} alt="" loading="lazy" />
            {f.box && f.shotSize && (
              <span
                className="srep__box"
                style={{
                  left: `${(f.box[0] / f.shotSize[0]) * 100}%`,
                  top: `${(f.box[1] / f.shotSize[1]) * 100}%`,
                  width: `${((f.box[2] - f.box[0]) / f.shotSize[0]) * 100}%`,
                  height: `${((f.box[3] - f.box[1]) / f.shotSize[1]) * 100}%`,
                }}
              />
            )}
          </button>
        )}
        <div className="srep__card-text">
          <p>{tr(f.description, lang)}</p>
          {!compact && (
            <dl className="srep__kv srep__kv--compact">
              <KV k={txt('category', lang)} v={tr(CATEGORY_TEXT[f.category], lang) || f.category} />
              <KV k={txt('module', lang)} v={f.module} />
              <KV k={txt('gameState', lang)} v={f.gameState} />
              <KV k={txt('frequency', lang)} v={String(f.frequency)} />
              <KV k={txt('reproducibility', lang)} v={tr(STATUS_TEXT[f.reproducibility], lang) || f.reproducibility} />
              <KV k={txt('firstLast', lang)} v={f.firstStep !== undefined ? `#${f.firstStep} / #${f.lastStep ?? f.firstStep}` : undefined} />
              <KV k={txt('expected', lang)} v={f.expected} />
              <KV k={txt('actual', lang)} v={f.actual} />
              <KV k={txt('confidence', lang)} v={f.aiConfidence !== undefined ? f.aiConfidence.toFixed(2) : undefined} />
              <KV k={txt('suspected', lang)} v={f.suspectedCause ? tr(f.suspectedCause, lang) : undefined} />
            </dl>
          )}
          {(f.suggestion || note) && (
            <div className="vm__fix">
              {f.suggestion && (<><strong>{txt('suggestion', lang)}</strong><p>{tr(f.suggestion, lang)}</p></>)}
              {note && (<><strong>{txt('aiNote', lang)}</strong><p>{tr(note, lang)}</p></>)}
            </div>
          )}
          {!compact && f.stepsToReproduce.length > 0 && (
            <details className="srep__details">
              <summary>{txt('stepsToRepro', lang)}</summary>
              <ol className="srep__mono">{f.stepsToReproduce.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </details>
          )}
        </div>
      </div>
    </article>
  );
}

const TRACE_PREVIEW = 40;

/** 數據品質:排除的讀錯數值與投注額變更,每列都能對回步驟。 */
function DataQualityTables({ q, lang }: { q: StructuredReport['dataQuality']; lang: RLang }) {
  if (!q || (q.excluded.length === 0 && q.betChanges.length === 0)) return null;
  const n = (v: number) => v.toLocaleString();
  return (
    <>
      <h3 className="srep__h3">{txt('dataQuality', lang)}</h3>
      {q.excluded.length > 0 && (
        <div className="srep__table-wrap">
          <table className="srep__table">
            <caption className="srep__muted">{txt('dqExcluded', lang)}</caption>
            <thead><tr><th scope="col">{txt('dqStep', lang)}</th><th scope="col">{txt('dqField', lang)}</th><th scope="col">{txt('dqRaw', lang)}</th><th scope="col">{txt('dqReason', lang)}</th></tr></thead>
            <tbody>
              {q.excluded.map((e) => (
                <tr key={`${e.step}-${e.key}`}>
                  <td className="srep__mono">#{e.step}</td>
                  <td className="srep__mono">{e.key}</td>
                  <td className="srep__mono">{n(e.value)}</td>
                  <td>{tr(e.reason, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.betChanges.length > 0 && (
        <div className="srep__table-wrap">
          <table className="srep__table">
            <caption className="srep__muted">{txt('dqBetChanges', lang)}</caption>
            <thead><tr><th scope="col">{txt('dqStep', lang)}</th><th scope="col">{txt('dqField', lang)}</th><th scope="col">{txt('dqChange', lang)}</th></tr></thead>
            <tbody>
              {q.betChanges.map((c) => (
                <tr key={`${c.step}-${c.key}`}>
                  <td className="srep__mono">#{c.prevStep} → #{c.step}</td>
                  <td className="srep__mono">{c.key}</td>
                  <td className="srep__mono">{n(c.from)} → {n(c.to)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function EvidenceTrace({ steps, lang, onOpenImage }: { steps: EvidenceStep[]; lang: RLang; onOpenImage: (u: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? steps : steps.slice(0, TRACE_PREVIEW);
  return (
    <>
      <ol className="srep__trace">
        {shown.map((s) => {
          const img = s.annotatedUrl ?? s.screenshotUrl;
          return (
            <li key={s.index} className={`srep__trace-step ${s.assertion ? `is-${s.assertion}` : ''}`}>
              {img && (
                <button type="button" className="srep__trace-shot" onClick={() => onOpenImage(img)} aria-label={`#${s.index}`}>
                  <img src={img} alt="" loading="lazy" />
                </button>
              )}
              <div className="srep__trace-body">
                <div className="srep__trace-head">
                  <span className="srep__mono">#{String(s.index).padStart(3, '0')}</span>
                  <strong>{s.action}</strong>
                  {s.x !== undefined && <span className="srep__mono">({s.x},{s.y})</span>}
                  {s.module && <span className="srep__tag">{s.module}</span>}
                  {s.mechanic && <span className="srep__tag">{s.mechanic}</span>}
                  {s.override && <span className="srep__tag srep__tag--warn">{txt('override', lang)}: {s.override}</span>}
                  {s.segment && s.segment > 1 && <span className="srep__tag">{txt('segment', lang)} {s.segment}</span>}
                  {s.excludedObs && Object.keys(s.excludedObs).length > 0 && (
                    <span className="srep__tag srep__tag--warn" title={Object.values(s.excludedObs).map((e) => tr(e.reason, lang)).join('\n')}>
                      {txt('excludedValue', lang)}: {Object.entries(s.excludedObs).map(([k, e]) => `${k}=${e.value.toLocaleString()}`).join(' · ')}
                    </span>
                  )}
                  {s.assertion && <span className={`srep__assert srep__assert--${s.assertion}`}>{tr(STATUS_TEXT[s.assertion], lang)}</span>}
                  {typeof s.confidence === 'number' && <span className="srep__muted">conf {s.confidence.toFixed(2)}</span>}
                  {typeof s.vlmMs === 'number' && <span className="srep__muted">{s.vlmMs} ms</span>}
                </div>
                <dl className="srep__chain">
                  <div><dt>{txt('observed', lang)}</dt><dd>{s.screen}</dd></div>
                  {s.thinking && <div><dt>{txt('reason', lang)}</dt><dd>{s.thinking}</dd></div>}
                  {s.expect && <div><dt>{txt('expected', lang)}</dt><dd>{s.expect}</dd></div>}
                  {s.actual && s.expect && <div><dt>{txt('actual', lang)}</dt><dd>{s.actual}</dd></div>}
                  {s.obs && <div><dt>obs</dt><dd className="srep__mono">{Object.entries(s.obs).map(([k, v]) => `${k}=${v}`).join(' · ')}</dd></div>}
                  {s.issue && <div><dt>issue</dt><dd>[{s.issue.severity}] {s.issue.title}</dd></div>}
                </dl>
              </div>
            </li>
          );
        })}
      </ol>
      {steps.length > TRACE_PREVIEW && (
        <button type="button" className="srep__more" onClick={() => setAll((v) => !v)}>
          {all ? txt('showLess', lang) : `${txt('showAll', lang)} (${steps.length})`}
        </button>
      )}
    </>
  );
}
