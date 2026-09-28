import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiGet, apiPost, apiPut, apiDelete, type ListResponse } from '../api/client.ts';
import { useQuery } from '../api/useQuery.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { CaseTrendBadge } from '../components/CaseTrendBadge.tsx';
import AppBadge, { type AppRef } from '../components/AppRef.tsx';
import './ListPage.css';
import './CasesPage.css';
import './TasksPage.css';

type AppRecord = AppRef;
interface CaseSummary {
  id: string;
  app: string;
  name: string;
}

type Mode = 'nl' | 'yaml';

export default function CasesPage() {
  const { t } = useI18n();
  const casesQuery = useQuery<ListResponse<CaseSummary>>('cases', () =>
    apiGet<ListResponse<CaseSummary>>('/cases'),
  );
  const appsQuery = useQuery<ListResponse<AppRecord>>('apps', () =>
    apiGet<ListResponse<AppRecord>>('/apps'),
  );

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('nl');
  const [appId, setAppId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [yaml, setYaml] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);

  const editing = editingId != null;
  // 從記憶地圖範本帶入的基礎 YAML(供「範本感知 AI 編修」);null 表示非範本流程。
  const [baseYaml, setBaseYaml] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  function resetForm() {
    setEditingId(null);
    setMode('nl');
    setAppId('');
    setName('');
    setDescription('');
    setYaml('');
    setBaseYaml(null);
    setError(null);
  }

  // 記憶地圖「使用範本」會帶 ?tpl=<base64>&app=&name= 進來:開表單並預填範本為基礎。
  useEffect(() => {
    const tpl = searchParams.get('tpl');
    if (!tpl) return;
    try {
      const decoded = decodeURIComponent(atob(tpl));
      const app = searchParams.get('app') ?? '';
      const nm = searchParams.get('name') ?? '從範本建立';
      resetForm();
      setAppId(app);
      setName(nm);
      setYaml(decoded);
      setBaseYaml(decoded);
      setMode('nl'); // 停在自然語言分頁,讓使用者輸入微調指令做範本感知編修
      setShowForm(true);
    } catch {
      /* 範本解析失敗則忽略 */
    }
    // 清掉 query,避免重整或返回時重複帶入。
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // 表單 inline 展開於頁面上方;開啟時捲動到表單,避免從下方按「編輯」看不到而誤操作。
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (showForm) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [showForm]);

  function openCreate() {
    resetForm();
    setShowForm(true);
  }

  async function openEdit(c: CaseSummary) {
    resetForm();
    setEditingId(c.id);
    setAppId(c.app);
    setName(c.name);
    setMode('yaml');
    setShowForm(true);
    // 讀既有 YAML 供編輯
    try {
      const detail = await apiGet<{ yaml: string }>(
        `/cases/${encodeURIComponent(c.app)}/${encodeURIComponent(c.id)}`,
      );
      setYaml(detail.yaml);
    } catch {
      setError(t('page.loadError'));
    }
  }

  async function onDelete(c: CaseSummary) {
    if (!window.confirm(t('cases.deleteConfirm'))) return;
    setBusyId(c.id);
    try {
      await apiDelete(
        `/cases/${encodeURIComponent(c.app)}/${encodeURIComponent(c.id)}`,
      );
      casesQuery.refetch();
    } finally {
      setBusyId(null);
    }
  }

  // 案例用複合鍵(app/id)識別。
  const caseKey = (c: CaseSummary) => `${c.app}/${c.id}`;

  // 批次刪除:對勾選的案例逐一呼單筆刪除。
  async function onBatchDelete() {
    if (selectedKeys.size === 0) return;
    if (!window.confirm(t('cases.batchDeleteConfirm').replace('{n}', String(selectedKeys.size)))) return;
    setBatchDeleting(true);
    try {
      await Promise.all(
        cases
          .filter((c) => selectedKeys.has(caseKey(c)))
          .map((c) =>
            apiDelete(`/cases/${encodeURIComponent(c.app)}/${encodeURIComponent(c.id)}`).catch(() => {}),
          ),
      );
      setSelectedKeys(new Set());
      casesQuery.refetch();
    } finally {
      setBatchDeleting(false);
    }
  }

  const apps = appsQuery.data?.items ?? [];
  const cases = casesQuery.data?.items ?? [];
  const appById = useMemo(() => {
    const m = new Map<string, AppRecord>();
    for (const a of apps) m.set(a.id, a);
    return m;
  }, [apps]);

  async function onDraft() {
    if (!appId) {
      setError(t('cases.needApp'));
      return;
    }
    setError(null);
    setDrafting(true);
    try {
      const res = await apiPost<{ yaml: string }>('/cases/draft', {
        description,
        appId,
        // 有範本基礎時走「範本感知編修」(後端據此以既有範本為基礎修改)。
        ...(baseYaml ? { baseYaml } : {}),
      });
      setYaml(res.yaml);
      setBaseYaml(res.yaml); // 編修後的結果成為下一輪微調的新基礎
      setMode('yaml'); // 草擬完成後切到 YAML 供審閱/修改
    } catch {
      setError(t('cases.draftError'));
    } finally {
      setDrafting(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!appId) {
      setError(t('cases.needApp'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await apiPut(
          `/cases/${encodeURIComponent(appId)}/${encodeURIComponent(editingId)}`,
          { name, yaml },
        );
      } else {
        await apiPost('/cases', { app: appId, name, yaml });
      }
      setShowForm(false);
      resetForm();
      casesQuery.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="listpage">
      <header className="listpage__header cases__header">
        <h1 className="listpage__title">{t('page.cases.title')}</h1>
        <span className="cases__header-actions">
          {selectedKeys.size > 0 && (
            <button
              type="button"
              className="tasks__batch-delete"
              onClick={onBatchDelete}
              disabled={batchDeleting}
            >
              {batchDeleting
                ? t('tasks.batchDeleting')
                : t('tasks.batchDelete').replace('{n}', String(selectedKeys.size))}
            </button>
          )}
          {!showForm && (
            <button
              type="button"
              className="cases__create-btn"
              onClick={openCreate}
            >
              {t('cases.create')}
            </button>
          )}
        </span>
      </header>

      {showForm && (
        <form ref={formRef} className="cases__form" onSubmit={onSubmit}>
          {editing && <h2 className="cases__form-title">{t('cases.editTitle')}</h2>}
          <div className="cases__row">
            <label className="cases__field">
              <span className="cases__label">{t('cases.app')}</span>
              {/* 編輯時 App 固定(案例 key 綁定 app),不可改 */}
              <select
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                disabled={editing}
              >
                <option value="">—</option>
                {apps.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="cases__field cases__field--grow">
              <span className="cases__label">{t('cases.name')}</span>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          </div>

          <div className="cases__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'nl'}
              className={`cases__tab ${mode === 'nl' ? 'cases__tab--active' : ''}`}
              onClick={() => setMode('nl')}
            >
              {t('cases.tabNL')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'yaml'}
              className={`cases__tab ${mode === 'yaml' ? 'cases__tab--active' : ''}`}
              onClick={() => setMode('yaml')}
            >
              {t('cases.tabYaml')}
            </button>
          </div>

          {mode === 'nl' ? (
            <div className="cases__field">
              {baseYaml && (
                <p className="cases__tpl-note">{t('cases.fromTemplate')}</p>
              )}
              <span className="cases__label">
                {baseYaml ? t('cases.refineInstruction') : t('cases.describe')}
              </span>
              <textarea
                className="cases__textarea"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={baseYaml ? t('cases.refineHint') : t('cases.describeHint')}
              />
              <div className="cases__draft-row">
                <button
                  type="button"
                  className="cases__draft-btn"
                  onClick={onDraft}
                  disabled={drafting || (!baseYaml && !description.trim())}
                >
                  {drafting
                    ? t('cases.drafting')
                    : baseYaml
                      ? t('cases.refine')
                      : t('cases.draft')}
                </button>
              </div>
            </div>
          ) : (
            <label className="cases__field">
              <span className="cases__label">{t('cases.yamlLabel')}</span>
              {/* 使用者內容,逐字呈現、不翻譯(Req 10.10) */}
              <textarea
                className="cases__textarea cases__textarea--mono"
                rows={12}
                value={yaml}
                onChange={(e) => setYaml(e.target.value)}
                spellCheck={false}
              />
            </label>
          )}

          {error && (
            <p className="cases__error" role="alert">
              {error}
            </p>
          )}

          <div className="cases__actions">
            <button
              type="button"
              className="cases__cancel"
              onClick={() => {
                setShowForm(false);
                resetForm();
              }}
            >
              {t('cases.cancel')}
            </button>
            <button
              type="submit"
              className="cases__submit"
              disabled={saving || !yaml.trim() || !name.trim()}
            >
              {editing
                ? saving
                  ? t('cases.saving')
                  : t('cases.saveEdit')
                : saving
                  ? t('cases.saving')
                  : t('cases.save')}
            </button>
          </div>
        </form>
      )}

      {casesQuery.loading && cases.length === 0 ? (
        <div className="listpage__skeleton" aria-hidden="true">
          <div className="listpage__skeleton-row" />
          <div className="listpage__skeleton-row" />
        </div>
      ) : casesQuery.error ? (
        <p className="listpage__error" role="alert">
          {t('page.loadError')}
        </p>
      ) : cases.length === 0 ? (
        <div className="listpage__empty">
          <p>{t('page.cases.empty')}</p>
        </div>
      ) : (
        <ul className="listpage__list">
          {cases.map((c) => (
            <li key={`${c.app}/${c.id}`} className={`listpage__item cases__item ${selectedKeys.has(caseKey(c)) ? 'tasks__row--selected' : ''}`}>
              <input
                type="checkbox"
                aria-label={t('tasks.selectRow')}
                checked={selectedKeys.has(caseKey(c))}
                onChange={(e) => {
                  const k = caseKey(c);
                  setSelectedKeys((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(k);
                    else next.delete(k);
                    return next;
                  });
                }}
              />
              <span className="cases__item-name">{c.name}</span>
              <AppBadge app={appById.get(c.app)} fallbackId={c.app} />
              <span className="cases__item-trend">
                <CaseTrendBadge app={c.app} caseId={c.id} />
              </span>
              <span className="cases__item-actions">
                <button
                  type="button"
                  className="cases__row-btn"
                  onClick={() => void openEdit(c)}
                  disabled={busyId === c.id}
                >
                  {t('cases.edit')}
                </button>
                <button
                  type="button"
                  className="cases__row-btn cases__row-btn--danger"
                  onClick={() => void onDelete(c)}
                  disabled={busyId === c.id}
                >
                  {t('cases.delete')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
