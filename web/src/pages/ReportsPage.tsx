import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiDelete, type ListResponse } from '../api/client.ts';
import { usePagedList } from '../api/usePagedList.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import AppBadge, { type AppRef } from '../components/AppRef.tsx';
import './ListPage.css';
import './TasksPage.css';

interface TaskItem {
  jobId: string;
  backend: string;
  state: string;
  createdAt: string;
  appId?: string;
}

const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);

export default function ReportsPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<TaskItem[]>([]);
  const [apps, setApps] = useState<AppRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  // 客戶端分頁(Req 15.5)。
  const { visible, hasMore, shownCount, total, loadMore } = usePagedList(items);

  const appById = useMemo(() => {
    const m = new Map<string, AppRef>();
    for (const a of apps) m.set(a.id, a);
    return m;
  }, [apps]);

  useEffect(() => {
    apiGet<ListResponse<TaskItem>>('/reports')
      .then((r) => setItems(r.items.filter((x) => TERMINAL.has(x.state))))
      .catch(() => {})
      .finally(() => setLoading(false));
    apiGet<ListResponse<AppRef>>('/apps')
      .then((r) => setApps(r.items))
      .catch(() => {});
  }, []);

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

  // 批次刪除:對勾選的報告(=任務)逐一呼單筆刪除。
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

  return (
    <section className="listpage listpage--wide">
      <header className="listpage__header reports__header">
        <h1 className="listpage__title">{t('page.reports.title')}</h1>
        {items.length > 0 && (
          <div className="reports__toolbar">
            <label className="reports__selectall">
              <input
                type="checkbox"
                aria-label={t('tasks.selectAll')}
                checked={visible.length > 0 && visible.every((x) => selectedIds.has(x.jobId))}
                onChange={(e) => {
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) visible.forEach((x) => next.add(x.jobId));
                    else visible.forEach((x) => next.delete(x.jobId));
                    return next;
                  });
                }}
              />
              <span>{t('tasks.selectAll')}</span>
            </label>
            {selectedIds.size > 0 && (
              <button
                type="button"
                className="tasks__batch-delete"
                onClick={onBatchDelete}
                disabled={batchDeleting}
              >
                {batchDeleting
                  ? t('tasks.batchDeleting')
                  : t('tasks.batchDelete').replace('{n}', String(selectedIds.size))}
              </button>
            )}
          </div>
        )}
      </header>

      {loading && items.length === 0 ? (
        <div className="listpage__skeleton" aria-hidden="true">
          <div className="listpage__skeleton-row" />
          <div className="listpage__skeleton-row" />
        </div>
      ) : items.length === 0 ? (
        <div className="listpage__empty">
          <p>{t('page.reports.empty')}</p>
        </div>
      ) : (
        <>
          <ul className="listpage__list">
            {visible.map((x) => (
              <li key={x.jobId} className={`listpage__item ${selectedIds.has(x.jobId) ? 'tasks__row--selected' : ''}`}>
                <input
                  type="checkbox"
                  aria-label={t('tasks.selectRow')}
                  checked={selectedIds.has(x.jobId)}
                  onChange={(e) => {
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(x.jobId);
                      else next.delete(x.jobId);
                      return next;
                    });
                  }}
                />
                <span>{t(`state.${x.state}` as MessageKey)}</span>
                {x.appId && <AppBadge app={appById.get(x.appId)} fallbackId={x.appId} />}
                <span style={{ marginLeft: 'auto' }} className="reports__row-actions">
                  <Link to={`/reports/${x.jobId}`}>{t('report.open')}</Link>
                  <button
                    type="button"
                    className="reports__row-delete"
                    onClick={() => void onDelete(x.jobId)}
                  >
                    {t('report.delete')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {hasMore && (
            <div className="listpage__more">
              <span className="listpage__more-count" aria-live="polite">
                {shownCount} / {total}
              </span>
              <button type="button" className="listpage__more-btn" onClick={loadMore}>
                {t('list.loadMore')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
