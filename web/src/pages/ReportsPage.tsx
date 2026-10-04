import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiGet, apiDelete, type ListResponse } from '../api/client.ts';
import { usePagedList } from '../api/usePagedList.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import AppBadge, { useAppLookup } from '../components/AppRef.tsx';
import TaskIcon from '../components/TaskIcon.tsx';
import { modelLabel } from '../components/modelProvider.ts';
import { CaseVersionBadge } from '../components/cases/CaseVersions.tsx';
import './ListPage.css';
import './TasksPage.css';
import './ReportsPage.css';

/** GET /reports 回傳的列(對齊後端 TaskListItem)。 */
interface ReportItem {
  jobId: string;
  backend: string;
  locality: string;
  category: string;
  appId: string;
  caseId: string;
  state: string;
  createdAt: string;
  updatedAt?: string;
  finishedAt?: string;
  vlmModel?: string;
  seatModels?: { agent?: string; vlm?: string; subagent?: string };
  billableSpendUsd?: number;
  spendEstimated?: boolean;
  stepCount?: number;
  message?: string;
  task?: string;
  deviceModel?: string;
  /** 執行時的案例版本號 / 名稱快照。 */
  caseVersion?: string;
  caseName?: string;
}

const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);
const STATE_ORDER = ['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead'];
const RANGES: Record<string, number> = { '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000, '30d': 30 * 24 * 3600_000 };
type SortKey = 'newest' | 'oldest' | 'duration' | 'steps' | 'cost';

function durationOf(x: ReportItem): number | null {
  const end = x.finishedAt ?? x.updatedAt;
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(x.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function relativeTime(iso: string, locale: string): string {
  const diff = Date.parse(iso) - Date.now();
  if (!Number.isFinite(diff)) return '';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}

export default function ReportsPage() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const { apps, lookup } = useAppLookup();

  // 篩選狀態放在 URL query,重新整理/分享連結都保留。
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const stateF = params.get('state') ?? 'all';
  const appF = params.get('app') ?? 'all';
  const catF = params.get('cat') ?? 'all';
  const backendF = params.get('backend') ?? 'all';
  const rangeF = params.get('range') ?? 'all';
  const sortF = (params.get('sort') as SortKey | null) ?? 'newest';
  const setParam = (key: string, value: string, def = 'all') => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (!value || value === def) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  };
  const hasFilters = Boolean(q) || [stateF, appF, catF, backendF, rangeF].some((v) => v !== 'all') || sortF !== 'newest';

  useEffect(() => {
    apiGet<ListResponse<ReportItem>>('/reports')
      .then((r) => setItems(r.items.filter((x) => TERMINAL.has(x.state))))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // 除了「狀態」以外的條件先套用:狀態籤的數字反映其他篩選後的分布。
  const baseFiltered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const now = Date.now();
    return items.filter((x) => {
      if (appF !== 'all' && x.appId !== appF) return false;
      if (catF !== 'all' && x.category !== catF) return false;
      if (backendF !== 'all' && x.backend !== backendF) return false;
      if (rangeF !== 'all' && RANGES[rangeF] && now - Date.parse(x.createdAt) > RANGES[rangeF]!) return false;
      if (!needle) return true;
      const hay = [x.jobId, lookup(x.appId)?.name ?? x.appId, x.task, x.message, x.deviceModel, x.caseId, x.caseVersion, x.caseName, x.seatModels?.vlm, x.seatModels?.agent]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [items, q, appF, catF, backendF, rangeF, lookup]);

  const filtered = useMemo(() => {
    const list = stateF === 'all' ? baseFiltered : baseFiltered.filter((x) => x.state === stateF);
    const val = (x: ReportItem): number => {
      switch (sortF) {
        case 'duration': return durationOf(x) ?? -1;
        case 'steps': return x.stepCount ?? -1;
        case 'cost': return x.billableSpendUsd ?? -1;
        default: return Date.parse(x.createdAt);
      }
    };
    return [...list].sort((a, b) => (sortF === 'oldest' ? val(a) - val(b) : val(b) - val(a)));
  }, [baseFiltered, stateF, sortF]);

  const { visible, hasMore, shownCount, total, loadMore } = usePagedList(filtered);

  const stateCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of baseFiltered) m.set(x.state, (m.get(x.state) ?? 0) + 1);
    return m;
  }, [baseFiltered]);

  const stats = useMemo(() => {
    const pass = filtered.filter((x) => x.state === 'pass').length;
    const fail = filtered.filter((x) => x.state === 'fail').length;
    const durs = filtered.map(durationOf).filter((d): d is number => d !== null);
    const cost = filtered.reduce((a, x) => a + (x.billableSpendUsd ?? 0), 0);
    const concluded = filtered.filter((x) => x.state === 'pass' || x.state === 'fail').length;
    return {
      total: filtered.length,
      pass,
      fail,
      error: filtered.filter((x) => x.state === 'error' || x.state === 'dead').length,
      passRate: concluded ? Math.round((pass / concluded) * 100) : null,
      avgDuration: durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null,
      cost,
      anyEstimated: filtered.some((x) => x.spendEstimated),
    };
  }, [filtered]);

  const appOptions = useMemo(() => {
    const ids = [...new Set(items.map((x) => x.appId))];
    return ids
      .map((id) => ({ id, name: lookup(id)?.name ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // apps 進入依賴,確保 App 名稱載入後重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, apps]);
  const backendOptions = useMemo(() => [...new Set(items.map((x) => x.backend))], [items]);

  async function onDelete(jobId: string) {
    if (!window.confirm(t('report.deleteConfirm'))) return;
    try {
      await apiDelete(`/tasks/${encodeURIComponent(jobId)}`);
      setItems((prev) => prev.filter((x) => x.jobId !== jobId));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    } catch {
      /* 忽略 */
    }
  }

  async function onBatchDelete() {
    if (selectedIds.size === 0) return;
    if (!window.confirm(t('report.batchDeleteConfirm').replace('{n}', String(selectedIds.size)))) return;
    setBatchDeleting(true);
    try {
      const ids = [...selectedIds];
      await Promise.all(ids.map((jobId) => apiDelete(`/tasks/${encodeURIComponent(jobId)}`).catch(() => {})));
      setItems((prev) => prev.filter((x) => !selectedIds.has(x.jobId)));
      setSelectedIds(new Set());
    } finally {
      setBatchDeleting(false);
    }
  }

  const toggle = (jobId: string, on: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(jobId);
      else next.delete(jobId);
      return next;
    });

  return (
    <section className="listpage listpage--wide rpts">
      <header className="listpage__header rpts__header">
        <h1 className="listpage__title">{t('page.reports.title')}</h1>
      </header>

      {loading && items.length === 0 ? (
        <div className="listpage__skeleton" aria-hidden="true">
          <div className="listpage__skeleton-row" />
          <div className="listpage__skeleton-row" />
          <div className="listpage__skeleton-row" />
        </div>
      ) : items.length === 0 ? (
        <div className="listpage__empty">
          <p>{t('page.reports.empty')}</p>
        </div>
      ) : (
        <>
          {/* 統計(依目前篩選結果) */}
          <div className="rpts__stats" aria-live="polite">
            <Stat label={t('reports.stat.total')} value={String(stats.total)} />
            <Stat label={t('state.pass')} value={String(stats.pass)} tone="pass" />
            <Stat label={t('state.fail')} value={String(stats.fail)} tone={stats.fail ? 'fail' : undefined} />
            <Stat label={t('state.error')} value={String(stats.error)} tone={stats.error ? 'warn' : undefined} />
            <Stat label={t('reports.stat.passRate')} value={stats.passRate === null ? '—' : `${stats.passRate}%`} />
            <Stat label={t('reports.stat.avgDuration')} value={formatDuration(stats.avgDuration)} />
            <Stat label={t('reports.stat.cost')} value={`$${stats.cost.toFixed(2)}${stats.anyEstimated ? ` (${t('reports.estimated')})` : ''}`} />
          </div>

          {/* 搜尋 + 篩選 */}
          <div className="rpts__filters">
            <label className="rpts__search">
              <span className="visually-hidden">{t('reports.searchPlaceholder')}</span>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="search"
                value={q}
                onChange={(e) => setParam('q', e.target.value, '')}
                placeholder={t('reports.searchPlaceholder')}
              />
            </label>

            <div className="rpts__chips" role="group" aria-label={t('tasks.colState')}>
              <button type="button" className={`rpts__chip ${stateF === 'all' ? 'is-active' : ''}`} aria-pressed={stateF === 'all'} onClick={() => setParam('state', 'all')}>
                {t('reports.allStates')} <span className="rpts__chip-count">{baseFiltered.length}</span>
              </button>
              {STATE_ORDER.filter((s) => stateCounts.has(s)).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`rpts__chip rpts__chip--${s} ${stateF === s ? 'is-active' : ''}`}
                  aria-pressed={stateF === s}
                  onClick={() => setParam('state', stateF === s ? 'all' : s)}
                >
                  <span className="rpts__dot" aria-hidden="true" />
                  {t(`state.${s}` as MessageKey)} <span className="rpts__chip-count">{stateCounts.get(s)}</span>
                </button>
              ))}
            </div>

            <div className="rpts__selects">
              <Select label={t('reports.filterApp')} value={appF} onChange={(v) => setParam('app', v)}>
                <option value="all">{t('reports.allApps')}</option>
                {appOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
              <Select label={t('reports.filterCategory')} value={catF} onChange={(v) => setParam('cat', v)}>
                <option value="all">{t('reports.allCategories')}</option>
                <option value="test">{t('reports.category.test')}</option>
                <option value="exploration">{t('reports.category.exploration')}</option>
              </Select>
              <Select label={t('reports.filterBackend')} value={backendF} onChange={(v) => setParam('backend', v)}>
                <option value="all">{t('reports.allBackends')}</option>
                {backendOptions.map((b) => <option key={b} value={b}>{t(`backend.${b}` as MessageKey)}</option>)}
              </Select>
              <Select label={t('reports.filterRange')} value={rangeF} onChange={(v) => setParam('range', v)}>
                <option value="all">{t('reports.range.all')}</option>
                <option value="24h">{t('reports.range.24h')}</option>
                <option value="7d">{t('reports.range.7d')}</option>
                <option value="30d">{t('reports.range.30d')}</option>
              </Select>
              <Select label={t('reports.sort')} value={sortF} onChange={(v) => setParam('sort', v, 'newest')}>
                {(['newest', 'oldest', 'duration', 'steps', 'cost'] as SortKey[]).map((k) => (
                  <option key={k} value={k}>{t(`reports.sort.${k}` as MessageKey)}</option>
                ))}
              </Select>
              {hasFilters && (
                <button type="button" className="rpts__clear" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  {t('reports.clearFilters')}
                </button>
              )}
            </div>
          </div>

          {/* 結果列 + 批次操作 */}
          <div className="rpts__bar">
            <label className="rpts__selectall">
              <input
                type="checkbox"
                aria-label={t('tasks.selectAll')}
                checked={visible.length > 0 && visible.every((x) => selectedIds.has(x.jobId))}
                onChange={(e) => visible.forEach((x) => toggle(x.jobId, e.target.checked))}
              />
              <span>{t('tasks.selectAll')}</span>
            </label>
            <span className="rpts__count">
              {t('reports.resultCount').replace('{n}', String(filtered.length)).replace('{total}', String(items.length))}
            </span>
            {selectedIds.size > 0 && (
              <button type="button" className="tasks__batch-delete" onClick={onBatchDelete} disabled={batchDeleting}>
                {batchDeleting ? t('tasks.batchDeleting') : t('tasks.batchDelete').replace('{n}', String(selectedIds.size))}
              </button>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="listpage__empty">
              <p>{t('reports.noMatch')}</p>
            </div>
          ) : (
            <ul className="rpts__list">
              {visible.map((x) => {
                const dur = durationOf(x);
                const agent = x.seatModels?.agent;
                const vlm = x.seatModels?.vlm ?? x.vlmModel;
                return (
                  <li key={x.jobId} className={`rpts__row rpts__row--${x.state} ${selectedIds.has(x.jobId) ? 'is-selected' : ''}`}>
                    <input
                      type="checkbox"
                      className="rpts__check"
                      aria-label={t('tasks.selectRow')}
                      checked={selectedIds.has(x.jobId)}
                      onChange={(e) => toggle(x.jobId, e.target.checked)}
                    />
                    <span className={`rpts__state rpts__state--${x.state}`}>
                      <span className="rpts__dot" aria-hidden="true" />
                      {t(`state.${x.state}` as MessageKey)}
                    </span>

                    <Link to={`/reports/${x.jobId}`} className="rpts__main">
                      <span className="rpts__title">
                        <AppBadge app={lookup(x.appId)} fallbackId={x.appId} />
                        <span className="rpts__tag">{t(`reports.category.${x.category === 'exploration' ? 'exploration' : 'test'}` as MessageKey)}</span>
                        <span className="rpts__backend">
                          <TaskIcon kind="backend" value={x.backend} label={t(`backend.${x.backend}` as MessageKey)} />
                        </span>
                      </span>
                      {x.task && <span className="rpts__task">{x.task}</span>}
                      {x.message && <span className="rpts__message">{x.message}</span>}
                    </Link>
                    {x.caseVersion && (
                      <span className="rpts__version">
                        {x.caseName ? <span className="rpts__version-name">{x.caseName}</span> : null}
                        <CaseVersionBadge version={x.caseVersion} />
                      </span>
                    )}

                    <dl className="rpts__meta">
                      <div><dt>{t('reports.col.steps')}</dt><dd>{x.stepCount ?? '—'}</dd></div>
                      <div><dt>{t('reports.col.duration')}</dt><dd>{formatDuration(dur)}</dd></div>
                      <div>
                        <dt>{t('reports.col.cost')}</dt>
                        <dd>
                          {typeof x.billableSpendUsd === 'number' ? `$${x.billableSpendUsd.toFixed(2)}` : '—'}
                          {x.spendEstimated && <small> {t('reports.estimated')}</small>}
                        </dd>
                      </div>
                      <div className="rpts__meta-wide"><dt>{t('reports.col.device')}</dt><dd title={x.deviceModel}>{x.deviceModel ?? '—'}</dd></div>
                      <div className="rpts__meta-wide">
                        <dt>{t('reports.col.models')}</dt>
                        <dd title={[agent, vlm].filter(Boolean).join(' / ')}>
                          {[agent && modelLabel(agent), vlm && modelLabel(vlm)].filter(Boolean).join(' · ') || '—'}
                        </dd>
                      </div>
                    </dl>

                    <div className="rpts__time">
                      <time dateTime={x.createdAt}>{formatDateTime(x.createdAt)}</time>
                      <small>{relativeTime(x.createdAt, locale)}</small>
                    </div>

                    <div className="rpts__actions">
                      <Link to={`/reports/${x.jobId}`} className="rpts__open">{t('report.open')}</Link>
                      <button
                        type="button"
                        className="tasks__icon-btn tasks__icon-btn--danger"
                        onClick={() => void onDelete(x.jobId)}
                        title={t('report.delete')}
                        aria-label={t('report.delete')}
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {hasMore && (
            <div className="listpage__more">
              <span className="listpage__more-count" aria-live="polite">{shownCount} / {total}</span>
              <button type="button" className="listpage__more-btn" onClick={loadMore}>{t('list.loadMore')}</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'pass' | 'fail' | 'warn' }) {
  return (
    <div className={`rpts__stat ${tone ? `rpts__stat--${tone}` : ''}`}>
      <span className="rpts__stat-label">{label}</span>
      <span className="rpts__stat-value">{value}</span>
    </div>
  );
}

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <label className="rpts__select">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>
    </label>
  );
}
