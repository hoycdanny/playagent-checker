import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiGet, apiDelete, type ListResponse } from '../api/client.ts';
import { usePagedList } from '../api/usePagedList.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import AppBadge, { useAppLookup } from '../components/AppRef.tsx';
import TaskIcon, { backendIcon } from '../components/TaskIcon.tsx';
import { modelLabel } from '../components/modelProvider.ts';
import { CaseVersionBadge } from '../components/cases/CaseVersions.tsx';
import { outcomeClass, outcomeKey, outcomeOf, outcomeTip, type VerdictInfo } from '../components/outcome.ts';
import './ListPage.css';
import './TasksPage.css';
import './ReportsPage.css';
import { usd4 } from '../components/money.ts';
import { formatDuration, taskDurationMs } from '../components/duration.ts';
import UserTag from '../components/UserTag.tsx';

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
  /** Device Farm 段數(0 = 不限、>1 = 長時)。 */
  maxSegments?: number;
  /** 測試結論(驗收標準;與報告封面同一個值)。 */
  verdict?: VerdictInfo;
  /** 送出任務的使用者。 */
  submittedBy?: string;
}

const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);
/** 篩選 chip 的順序:先測試結論,再其餘執行狀態(尚未算出結論的舊任務)。 */
const STATE_ORDER = ['pass', 'pass_risk', 'fail', 'blocked', 'error', 'cancelled', 'budget_exceeded', 'dead'];
const RANGES: Record<string, number> = { '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000, '30d': 30 * 24 * 3600_000 };
type SortKey = 'newest' | 'oldest' | 'duration' | 'steps' | 'cost';

/** 耗時算法與格式與任務列表共用(components/duration.ts)。 */
const durationOf = (x: ReportItem): number | null => taskDurationMs(x);

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

/**
 * 測試報告頁。
 *
 * 傳入 appId 時進入「嵌入模式」:同一份版面嵌在應用工作區的報告分頁裡,
 * 鎖定單一應用 —— 省掉頁標題與應用篩選,其餘統計/篩選/清單排版與這頁完全一致。
 */
export default function ReportsPage({ appId: lockedApp }: { appId?: string } = {}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const embedded = Boolean(lockedApp);
  const [items, setItems] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const { apps, lookup } = useAppLookup();

  // 篩選狀態放在 URL query,重新整理/分享連結都保留。
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const stateF = params.get('state') ?? 'all';
  // 嵌入模式鎖定應用;非嵌入模式才讀 ?app=。
  const appF = lockedApp ?? params.get('app') ?? 'all';
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
  const hasFilters =
    Boolean(q) ||
    [stateF, catF, backendF, rangeF].some((v) => v !== 'all') ||
    (!embedded && appF !== 'all') ||
    sortF !== 'newest';
  /** 清除篩選:嵌入模式要保留 ?tab=,否則會被踢回工作區總覽。 */
  function clearFilters() {
    setParams((prev) => {
      const next = new URLSearchParams();
      const tab = prev.get('tab');
      if (tab) next.set('tab', tab);
      return next;
    }, { replace: true });
  }

  useEffect(() => {
    apiGet<ListResponse<ReportItem>>(
      lockedApp ? `/reports?app=${encodeURIComponent(lockedApp)}` : '/reports',
    )
      .then((r) => setItems(r.items.filter((x) => TERMINAL.has(x.state))))
      .catch(() => {})
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedApp]);

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
    const list = stateF === 'all' ? baseFiltered : baseFiltered.filter((x) => outcomeOf(x) === stateF);
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
    for (const x of baseFiltered) { const o = outcomeOf(x); m.set(o, (m.get(o) ?? 0) + 1); }
    return m;
  }, [baseFiltered]);

  const stats = useMemo(() => {
    // 通過率 = 通過(含有風險)÷(通過 + 失敗);受阻不算進分母(那次測試不能作為驗收依據)。
    const oc = filtered.map(outcomeOf);
    const pass = oc.filter((o) => o === 'pass' || o === 'pass_risk').length;
    const fail = oc.filter((o) => o === 'fail').length;
    const durs = filtered.map(durationOf).filter((d): d is number => d !== null);
    const cost = filtered.reduce((a, x) => a + (x.billableSpendUsd ?? 0), 0);
    const concluded = pass + fail;
    return {
      total: filtered.length,
      pass,
      fail,
      blocked: oc.filter((o) => o === 'blocked').length,
      error: oc.filter((o) => o === 'error' || o === 'dead').length,
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

  // 同時最多 3 筆;只把「真的刪掉」的從畫面移除,失敗的保留勾選並提示(之前失敗也從畫面消失,重新整理又冒出來)。
  async function onBatchDelete() {
    if (selectedIds.size === 0) return;
    if (!window.confirm(t('report.batchDeleteConfirm').replace('{n}', String(selectedIds.size)))) return;
    setBatchDeleting(true);
    const queue = [...selectedIds];
    const done = new Set<string>();
    const failed: string[] = [];
    try {
      const worker = async () => {
        for (let jobId = queue.shift(); jobId; jobId = queue.shift()) {
          try {
            await apiDelete(`/tasks/${encodeURIComponent(jobId)}`);
            done.add(jobId);
          } catch {
            failed.push(jobId);
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      setItems((prev) => prev.filter((x) => !done.has(x.jobId)));
      setSelectedIds(new Set(failed));
      if (failed.length) window.alert(t('tasks.batchDeleteFailed').replace('{n}', String(failed.length)));
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
    <section className={`listpage listpage--wide rpts${embedded ? ' listpage--embed' : ''}`}>
      {!embedded && (
        <header className="listpage__header rpts__header">
          <h1 className="listpage__title">{t('page.reports.title')}</h1>
        </header>
      )}

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
            <Stat label={t('outcome.pass')} value={String(stats.pass)} tone="pass" />
            <Stat label={t('outcome.fail')} value={String(stats.fail)} tone={stats.fail ? 'fail' : undefined} />
            <Stat label={t('outcome.blocked')} value={String(stats.blocked)} tone={stats.blocked ? 'warn' : undefined} />
            <Stat label={t('state.error')} value={String(stats.error)} tone={stats.error ? 'warn' : undefined} />
            <Stat label={t('reports.stat.passRate')} value={stats.passRate === null ? '—' : `${stats.passRate}%`} />
            <Stat label={t('reports.stat.avgDuration')} value={formatDuration(stats.avgDuration)} />
            <Stat label={t('reports.stat.cost')} value={`${usd4(stats.cost)}${stats.anyEstimated ? ` (${t('reports.estimated')})` : ''}`} />
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
                  {t(outcomeKey(s))} <span className="rpts__chip-count">{stateCounts.get(s)}</span>
                </button>
              ))}
            </div>

            <div className="rpts__selects">
              {/* 嵌入工作區時清單已鎖定單一應用,這個篩選沒有意義 */}
              {!embedded && (
                <Select label={t('reports.filterApp')} value={appF} onChange={(v) => setParam('app', v)}>
                  <option value="all">{t('reports.allApps')}</option>
                  {appOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              )}
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
                <button type="button" className="rpts__clear" onClick={clearFilters}>
                  {t('reports.clearFilters')}
                </button>
              )}
            </div>
          </div>

          {/* 結果列 + 批次操作(全選在表頭勾選框) */}
          <div className="rpts__bar">
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
            /* 與「測試任務」同一套表格排版:勾選欄 + 圖示欄,點整列進報告,刪除走上方「刪除選取」。 */
            <table className="tasks__table rpts__table">
              <thead>
                <tr>
                  <th className="tasks__col-check">
                    <input
                      type="checkbox"
                      aria-label={t('tasks.selectAll')}
                      checked={visible.length > 0 && visible.every((x) => selectedIds.has(x.jobId))}
                      onChange={(e) => visible.forEach((x) => toggle(x.jobId, e.target.checked))}
                    />
                  </th>
                  <th className="tasks__col-icon">{t('tasks.colState')}</th>
                  <th>{t('tasks.colCreated')}</th>
                  <th>{t('tasks.colApp')}</th>
                  <th className="tasks__col-case">{t('reports.col.case')}</th>
                  <th className="tasks__col-icon">{t('tasks.colBackend')}</th>
                  <th className="tasks__col-steps">{t('reports.col.steps')}</th>
                  <th>{t('reports.col.duration')}</th>
                  <th>{t('reports.col.cost')}</th>
                  <th>{t('reports.col.device')}</th>
                  <th title={t('tasks.roleAgentHint')}>{t('tasks.roleAgent')}</th>
                  <th title={t('tasks.roleVlmHint')}>{t('tasks.roleVlm')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((x) => {
                  const agent = x.seatModels?.agent;
                  const vlm = x.seatModels?.vlm ?? x.vlmModel;
                  const selected = selectedIds.has(x.jobId);
                  const model = (id: string | undefined) =>
                    id ? <span className="tasks__model" title={id}>{modelLabel(id)}</span> : <span className="tasks__muted-cell">—</span>;
                  return (
                    <tr
                      key={x.jobId}
                      className={`tasks__row--link${selected ? ' tasks__row--selected' : ''}`}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('input, a, button, label, .tasks__col-check')) return;
                        if (window.getSelection()?.toString()) return;
                        navigate(`/reports/${x.jobId}`);
                      }}
                    >
                      <td className="tasks__col-check">
                        <input
                          type="checkbox"
                          aria-label={t('tasks.selectRow')}
                          checked={selected}
                          onChange={(e) => toggle(x.jobId, e.target.checked)}
                        />
                      </td>
                      <td className="tasks__col-icon">
                        <span className={`tasks__state-link ${outcomeClass(outcomeOf(x))}`}>
                          <TaskIcon kind="state" value={outcomeOf(x)} label={outcomeTip(x, (k) => t(k), locale === 'en' ? 'en' : 'zh')} />
                        </span>
                      </td>
                      <td className="tasks__created" title={relativeTime(x.createdAt, locale)}>
                        <Link to={`/reports/${x.jobId}`} className="tasks__row-link" aria-label={`${t('report.open')} ${formatDateTime(x.createdAt)}`}>
                          <time dateTime={x.createdAt}>{formatDateTime(x.createdAt)}</time>
                        </Link>
                        {x.submittedBy && (
                          <div className="tasks__by">
                            <UserTag user={x.submittedBy} prefix={t('tasks.submittedBy')} />
                          </div>
                        )}
                      </td>
                      <td><AppBadge app={lookup(x.appId)} fallbackId={x.appId} /></td>
                      <td className="tasks__col-case" title={[x.caseName, x.message].filter(Boolean).join('\n')}>
                        <span className="tasks__case-name">
                          {x.caseName ?? t(`reports.category.${x.category === 'exploration' ? 'exploration' : 'test'}` as MessageKey)}
                        </span>
                        {x.caseVersion && <CaseVersionBadge version={x.caseVersion} />}
                      </td>
                      <td className="tasks__col-icon">
                        {(() => {
                          const bi = backendIcon(x.backend, x.maxSegments, (k) => t(k as MessageKey));
                          return <TaskIcon kind="backend" value={bi.value} label={bi.label} />;
                        })()}
                      </td>
                      <td className="tasks__col-steps">{x.stepCount ?? <span className="tasks__muted-cell">—</span>}</td>
                      <td className="rpts__nowrap">{formatDuration(durationOf(x))}</td>
                      <td className="tasks__cost">
                        {typeof x.billableSpendUsd === 'number' ? (
                          <>
                            {usd4(x.billableSpendUsd)}
                            {x.spendEstimated && <span className="tasks__cost-est"> {t('reports.estimated')}</span>}
                          </>
                        ) : <span className="tasks__muted-cell">—</span>}
                      </td>
                      <td className="tasks__text-cell" title={x.deviceModel}>{x.deviceModel ?? <span className="tasks__muted-cell">—</span>}</td>
                      <td className="tasks__text-cell">{model(agent)}</td>
                      <td className="tasks__text-cell">{model(vlm)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
