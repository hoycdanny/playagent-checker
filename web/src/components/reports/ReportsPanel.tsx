import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import type { MessageKey } from '../../i18n/messages.ts';
import { CaseVersionBadge } from '../cases/CaseVersions.tsx';
import './ReportsPanel.css';

export interface ReportItem {
  jobId: string;
  appId: string;
  caseId: string;
  caseName?: string;
  caseVersion?: string;
  state: string;
  backend: string;
  createdAt: string;
  finishedAt?: string;
  stepCount?: number;
  billableSpendUsd?: number;
  message?: string;
  deviceModel?: string;
  /** 這次測的版本標籤(多版本 App 用;舊任務沒有)。 */
  artifactLabel?: string;
  artifactVersion?: string;
}

const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);
/** 篩選用的狀態籌碼(依嚴重度排,通過在最前)。 */
const STATES = ['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead'] as const;

function stateClass(state: string): string {
  if (state === 'pass') return 'task-state--pass';
  if (state === 'fail') return 'task-state--fail';
  if (state === 'error') return 'task-state--error';
  if (state === 'cancelled') return 'task-state--cancelled';
  if (state === 'budget_exceeded') return 'task-state--budget';
  if (state === 'dead') return 'task-state--dead';
  return 'task-state--queued';
}

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);

/**
 * ReportsPanel —— 某個 App 的測試報告清單(統計 + 狀態篩選 + 搜尋 + 刪除)。
 *
 * 「報告」在後端就是已終局的任務,所以輸入直接吃任務清單,這裡只負責篩選與呈現。
 * 刪除報告 = 刪整個任務資料夾(由呼叫端執行,這裡只觸發)。
 */
export default function ReportsPanel({
  items,
  onDelete,
  emptyText,
}: {
  items: ReportItem[];
  onDelete?: (jobId: string) => void | Promise<void>;
  emptyText?: string;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [state, setState] = useState<string>('all');
  const [sort, setSort] = useState<'new' | 'old' | 'cost'>('new');

  const reports = useMemo(() => items.filter((x) => TERMINAL.has(x.state)), [items]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of reports) m.set(r.state, (m.get(r.state) ?? 0) + 1);
    return m;
  }, [reports]);

  const passRate = useMemo(() => {
    // 通過率只看 pass + fail(error/取消/預算用盡不是功能判定,算進去會失真)。
    const decided = reports.filter((r) => r.state === 'pass' || r.state === 'fail');
    if (decided.length === 0) return null;
    return Math.round((decided.filter((r) => r.state === 'pass').length / decided.length) * 100);
  }, [reports]);

  const totalCost = useMemo(
    () => reports.reduce((s, r) => s + (typeof r.billableSpendUsd === 'number' ? r.billableSpendUsd : 0), 0),
    [reports],
  );

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = reports.filter((r) => {
      if (state !== 'all' && r.state !== state) return false;
      if (!needle) return true;
      return [r.caseName, r.caseId, r.jobId, r.message, r.artifactLabel, r.deviceModel]
        .some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
    });
    const sorted = [...filtered];
    if (sort === 'new') sorted.sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt));
    if (sort === 'old') sorted.sort((a, b) => (a.finishedAt ?? a.createdAt).localeCompare(b.finishedAt ?? b.createdAt));
    if (sort === 'cost') sorted.sort((a, b) => (b.billableSpendUsd ?? 0) - (a.billableSpendUsd ?? 0));
    return sorted;
  }, [reports, q, state, sort]);

  if (reports.length === 0) {
    return <div className="listpage__empty"><p>{emptyText ?? t('page.reports.empty')}</p></div>;
  }

  return (
    <div className="rp">
      <div className="rp__stats">
        <div className="rp__stat"><b>{reports.length}</b><span>{t('reports.stat.total')}</span></div>
        <div className="rp__stat"><b>{passRate === null ? '—' : `${passRate}%`}</b><span>{t('reports.stat.passRate')}</span></div>
        <div className="rp__stat"><b>{usd(totalCost)}</b><span>{t('reports.stat.cost')}</span></div>
      </div>

      <div className="rp__filters">
        <input
          className="rp__search"
          type="search"
          value={q}
          placeholder={t('reports.searchPlaceholder')}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t('reports.searchPlaceholder')}
        />
        <div className="rp__chips" role="group" aria-label={t('reports.allStates')}>
          <button
            type="button"
            className={`rp__chip ${state === 'all' ? 'is-active' : ''}`}
            aria-pressed={state === 'all'}
            onClick={() => setState('all')}
          >
            {t('reports.allStates')} {reports.length}
          </button>
          {STATES.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => (
            <button
              key={s}
              type="button"
              className={`rp__chip ${state === s ? 'is-active' : ''}`}
              aria-pressed={state === s}
              onClick={() => setState(s)}
            >
              {t(`state.${s}` as MessageKey)} {counts.get(s)}
            </button>
          ))}
        </div>
        <label className="rp__sort">
          <span className="visually-hidden">{t('reports.sort')}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as 'new' | 'old' | 'cost')}>
            <option value="new">{t('reports.sort.newest')}</option>
            <option value="old">{t('reports.sort.oldest')}</option>
            <option value="cost">{t('reports.sort.cost')}</option>
          </select>
        </label>
      </div>

      {view.length === 0 ? (
        <div className="listpage__empty"><p>{t('reports.noMatch')}</p></div>
      ) : (
        <ul className="rp__list">
          {view.map((r) => (
            <li key={r.jobId} className="rp__item">
              <span className={`task-state ${stateClass(r.state)}`}>
                {t(`state.${r.state}` as MessageKey)}
              </span>
              <div className="rp__main">
                <Link className="rp__title" to={`/reports/${r.jobId}`}>
                  {r.caseName ?? r.caseId}
                </Link>
                <div className="rp__meta">
                  {r.caseVersion && <CaseVersionBadge version={r.caseVersion} />}
                  {r.artifactLabel && <span className="rp__tag rp__tag--build">{r.artifactLabel}</span>}
                  {r.deviceModel && <span className="rp__tag">{r.deviceModel}</span>}
                  {typeof r.stepCount === 'number' && <span className="rp__tag">{r.stepCount} {t('reports.col.steps')}</span>}
                  {typeof r.billableSpendUsd === 'number' && <span className="rp__tag">{usd(r.billableSpendUsd)}</span>}
                </div>
                {r.message && <p className="rp__msg" title={r.message}>{r.message}</p>}
              </div>
              <div className="rp__side">
                <time className="rp__time" dateTime={r.finishedAt ?? r.createdAt}>
                  {new Date(r.finishedAt ?? r.createdAt).toLocaleString()}
                </time>
                <span className="rp__actions">
                  <Link className="rp__open" to={`/reports/${r.jobId}`}>{t('workspace.openReport')}</Link>
                  {onDelete && (
                    <button type="button" className="rp__delete" onClick={() => void onDelete(r.jobId)}>
                      {t('report.delete')}
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
