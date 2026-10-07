import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiGet, apiPost, apiPut, apiDelete, type ListResponse } from '../api/client.ts';
import { useQuery } from '../api/useQuery.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { type AppRef } from '../components/AppRef.tsx';
import { ControlSchemePicker } from '../components/controls/ControlSchemePicker.tsx';
import { applyControls, readControls } from '../components/controls/controlsYaml.ts';
import { CaseVersions } from '../components/cases/CaseVersions.tsx';
import { CaseOverviewTable, type CaseOverviewItem } from '../components/cases/CaseOverviewTable.tsx';
import { ExcelImport } from '../components/cases/ExcelImport.tsx';
import { reportLang } from '../components/report/reportText.ts';
import './ListPage.css';
import './CasesPage.css';
import './TasksPage.css';

type AppRecord = AppRef;
interface CaseSummary {
  id: string;
  app: string;
  name: string;
  /** 目前使用中的版本號。 */
  version?: string;
}

type Mode = 'nl' | 'yaml' | 'excel';

export default function CasesPage() {
  const { t, locale } = useI18n();
  const lang = reportLang(locale);
  const casesQuery = useQuery<ListResponse<CaseSummary>>('cases', () =>
    apiGet<ListResponse<CaseSummary>>('/cases'),
  );
  // 專業總覽:解析後的案例設定 + 執行統計(GET /cases/overview)。
  const overviewQuery = useQuery<{ items: CaseOverviewItem[] }>('casesOverview', () =>
    apiGet<{ items: CaseOverviewItem[] }>('/cases/overview'),
  );
  const overview = overviewQuery.data?.items ?? [];
  const refetchAll = () => {
    casesQuery.refetch();
    overviewQuery.refetch();
  };
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
  // 操作行為(undefined = 未指定,執行時用 App 類型建議);與 YAML 的 controls: 欄位雙向同步。
  const [controls, setControls] = useState<string[] | undefined>(undefined);
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
    setControls(undefined);
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
      setControls(readControls(decoded));
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
      setControls(readControls(detail.yaml));
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
      refetchAll();
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
      refetchAll();
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
      const drafted = applyControls(res.yaml, controls);
      setYaml(drafted);
      setBaseYaml(drafted); // 編修後的結果成為下一輪微調的新基礎
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
          { name, yaml: applyControls(yaml, controls) },
        );
      } else {
        await apiPost('/cases', { app: appId, name, yaml: applyControls(yaml, controls) });
      }
      setShowForm(false);
      resetForm();
      refetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="listpage listpage--wide">
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
            {/* Excel 匯入:名稱取自每一列,不用這個欄位 */}
            {mode !== 'excel' && (
              <label className="cases__field cases__field--grow">
                <span className="cases__label">{t('cases.name')}</span>
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
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
            {/* 從 Excel 匯入只用於新建(一次建立多個案例) */}
            {!editing && (
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'excel'}
                className={`cases__tab ${mode === 'excel' ? 'cases__tab--active' : ''}`}
                onClick={() => setMode('excel')}
              >
                {t('cases.tabExcel')}
              </button>
            )}
          </div>

          {mode === 'excel' ? (
            <ExcelImport
              appId={appId}
              controls={controls}
              lang={lang}
              onCreated={(allOk) => {
                refetchAll();
                if (allOk) {
                  setShowForm(false);
                  resetForm();
                }
              }}
            />
          ) : mode === 'nl' ? (
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
                onChange={(e) => {
                  setYaml(e.target.value);
                  setControls(readControls(e.target.value));
                }}
                spellCheck={false}
              />
            </label>
          )}

          <ControlSchemePicker
            value={controls}
            genre={appById.get(appId)?.genre}
            onChange={(ids) => {
              setControls(ids);
              setYaml((y) => applyControls(y, ids));
            }}
          />

          {error && (
            <p className="cases__error" role="alert">
              {error}
            </p>
          )}

          {editingId && (
            <CaseVersions
              app={appId}
              caseId={editingId}
              onActivated={(v) => {
                setName(v.name);
                setYaml(v.yaml);
                setControls(readControls(v.yaml));
                setMode('yaml');
                refetchAll();
              }}
            />
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
            {mode !== 'excel' && (
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
            )}
          </div>
        </form>
      )}

      {overviewQuery.loading && !overviewQuery.data ? (
        <div className="listpage__skeleton" aria-hidden="true">
          <div className="listpage__skeleton-row" />
          <div className="listpage__skeleton-row" />
        </div>
      ) : overviewQuery.error && !overviewQuery.data ? (
        <p className="listpage__error" role="alert">
          {t('page.loadError')}
        </p>
      ) : overview.length === 0 ? (
        <div className="listpage__empty">
          <p>{t('page.cases.empty')}</p>
        </div>
      ) : (
        <CaseOverviewTable
          items={overview}
          appLookup={(id) => appById.get(id)}
          selected={selectedKeys}
          onToggleSelect={(k, checked) =>
            setSelectedKeys((prev) => {
              const next = new Set(prev);
              if (checked) next.add(k);
              else next.delete(k);
              return next;
            })
          }
          onEdit={(c) => void openEdit(c)}
          onDelete={(c) => void onDelete(c)}
          busyId={busyId}
        />
      )}
    </section>
  );
}
