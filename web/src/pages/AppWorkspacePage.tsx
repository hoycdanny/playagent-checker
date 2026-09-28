import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiGet, apiPost, apiPut, apiDelete, type ListResponse } from '../api/client.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import GenreIcon, { genreLabelKey, type Genre } from '../components/GenreIcon.tsx';
import { CaseTrendBadge } from '../components/CaseTrendBadge.tsx';
import './ListPage.css';
import './TasksPage.css';
import './CasesPage.css';
import './AppWorkspacePage.css';

interface AppRecord {
  id: string;
  name: string;
  platform: string;
  identifier?: string;
  genre?: Genre;
  version?: string;
  iconUrl?: string;
  notes?: string;
}
interface CaseSummary {
  id: string;
  app: string;
  name: string;
}
interface TaskItem {
  jobId: string;
  backend: string;
  locality: string;
  appId: string;
  caseId: string;
  state: string;
  createdAt: string;
}

const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);
const PASS_STATES = new Set(['pass']);

type Tab = 'overview' | 'cases' | 'tasks' | 'reports' | 'memory';

const TABS: { key: Tab; labelKey: MessageKey }[] = [
  { key: 'overview', labelKey: 'workspace.tabOverview' },
  { key: 'cases', labelKey: 'workspace.tabCases' },
  { key: 'tasks', labelKey: 'workspace.tabTasks' },
  { key: 'reports', labelKey: 'workspace.tabReports' },
  { key: 'memory', labelKey: 'workspace.tabMemory' },
];

const BACKENDS: { value: string; labelKey: MessageKey; supported: boolean }[] = [
  { value: 'web', labelKey: 'backend.web', supported: true },
  { value: 'emulator', labelKey: 'backend.emulator', supported: true },
  { value: 'windows', labelKey: 'backend.windows', supported: false },
  // devicefarm = iOS/Android 真機(取代模擬器,可過遊戲伺服器對模擬器環境的檢查)。
  { value: 'devicefarm', labelKey: 'backend.devicefarm', supported: true },
  { value: 'attached', labelKey: 'backend.attached', supported: false },
];

/** 需要選 VLM 模型(判畫面座標)的後端。 */
const VLM_BACKENDS = new Set(['emulator', 'devicefarm', 'attached']);

interface ModelEntry {
  modelId: string;
  displayName: string;
  pricing?: { inputPerM: number; outputPerM: number; estimated?: boolean };
}

/** 模型下拉的顯示文字:名稱 + 每百萬 token 進/出價(估算價標註)。 */
function modelOptionLabel(m: ModelEntry): string {
  if (!m.pricing) return m.displayName;
  const { inputPerM, outputPerM, estimated } = m.pricing;
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  return `${m.displayName} — ${fmt(inputPerM)}/${fmt(outputPerM)} 每百萬 token${estimated ? '(估算)' : ''}`;
}

function stateClass(state: string): string {
  if (state === 'pass') return 'task-state--pass';
  if (state === 'fail') return 'task-state--fail';
  if (state === 'error') return 'task-state--error';
  if (state === 'cancelled') return 'task-state--cancelled';
  if (state === 'budget_exceeded') return 'task-state--budget';
  if (state === 'dead') return 'task-state--dead';
  if (state === 'running') return 'task-state--running';
  return 'task-state--queued';
}

export default function AppWorkspacePage() {
  const { t } = useI18n();
  const { appId = '' } = useParams<{ appId: string }>();

  const [app, setApp] = useState<AppRecord | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [memStats, setMemStats] = useState<{ pages: number; edges: number } | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  // 建立/編輯案例(鎖定本 App)
  const [showCaseForm, setShowCaseForm] = useState(false);
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null);
  const [caseName, setCaseName] = useState('');
  const [caseYaml, setCaseYaml] = useState('');
  const [caseDesc, setCaseDesc] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [savingCase, setSavingCase] = useState(false);

  // 提交任務(鎖定本 App)
  const [showTaskForm, setShowTaskForm] = useState(false);
  // 表單 inline 展開;開啟時捲動到表單,避免從下方按鈕開啟後看不到。
  const caseFormRef = useRef<HTMLFormElement>(null);
  const taskFormRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (showCaseForm) caseFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [showCaseForm]);
  useEffect(() => {
    if (showTaskForm) taskFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [showTaskForm]);
  const [taskCaseId, setTaskCaseId] = useState('');
  const [backend, setBackend] = useState('web');
  const [vlmModel, setVlmModel] = useState('');
  const [vlmModels, setVlmModels] = useState<ModelEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [kbs, setKbs] = useState<{ id: string; name: string }[]>([]);
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);

  function loadApp() {
    apiGet<AppRecord>(`/apps/${encodeURIComponent(appId)}`)
      .then((a) => {
        setApp(a);
        // 預選該 App 的預設知識庫。
        const defaults = (a as AppRecord & { defaultKnowledgeBaseIds?: string[] })
          .defaultKnowledgeBaseIds;
        if (defaults && defaults.length > 0) setSelectedKbIds(defaults);
      })
      .catch(() => setNotFound(true));
  }
  function loadCases() {
    apiGet<ListResponse<CaseSummary>>('/cases')
      .then((r) => setCases(r.items.filter((c) => c.app === appId)))
      .catch(() => {});
  }
  function loadTasks() {
    apiGet<ListResponse<TaskItem>>('/tasks')
      .then((r) => setTasks(r.items.filter((x) => x.appId === appId)))
      .catch(() => {});
  }

  useEffect(() => {
    if (!appId) return;
    loadApp();
    loadCases();
    loadTasks();
    apiGet<{ stats: { pages: number; edges: number } }>(
      `/memory?app=${encodeURIComponent(appId)}`,
    )
      .then((o) => setMemStats(o.stats))
      .catch(() => setMemStats(null));
    apiGet<ListResponse<{ id: string; name: string }>>('/knowledge-bases')
      .then((r) => setKbs(r.items))
      .catch(() => {});
    // VLM 模型清單(判畫面座標的 VLM Seat 可選模型);真機/模擬器探索用。
    apiGet<ListResponse<ModelEntry>>('/models?seat=vlm')
      .then((r) => {
        setVlmModels(r.items);
        if (r.items[0]) setVlmModel(r.items[0].modelId);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // 有進行中任務時輪詢。
  useEffect(() => {
    if (!tasks.some((x) => !TERMINAL.has(x.state))) return;
    const timer = setInterval(loadTasks, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const reports = useMemo(() => tasks.filter((x) => TERMINAL.has(x.state)), [tasks]);
  const passRate = useMemo(() => {
    if (reports.length === 0) return null;
    const passed = reports.filter((x) => PASS_STATES.has(x.state)).length;
    return Math.round((passed / reports.length) * 100);
  }, [reports]);

  const caseNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cases) m.set(c.id, c.name);
    return m;
  }, [cases]);

  async function onDraft() {
    if (!caseDesc.trim()) return;
    setDrafting(true);
    try {
      const res = await apiPost<{ yaml: string }>('/cases/draft', {
        description: caseDesc,
        appId,
      });
      setCaseYaml(res.yaml);
    } catch {
      /* 忽略,使用者可手寫 */
    } finally {
      setDrafting(false);
    }
  }

  function resetCaseForm() {
    setEditingCaseId(null);
    setCaseName('');
    setCaseYaml('');
    setCaseDesc('');
  }

  function openCreateCase() {
    resetCaseForm();
    setShowCaseForm(true);
  }

  async function openEditCase(c: CaseSummary) {
    resetCaseForm();
    setEditingCaseId(c.id);
    setCaseName(c.name);
    setShowCaseForm(true);
    try {
      const detail = await apiGet<{ yaml: string }>(
        `/cases/${encodeURIComponent(appId)}/${encodeURIComponent(c.id)}`,
      );
      setCaseYaml(detail.yaml);
    } catch {
      /* 忽略,使用者可重寫 */
    }
  }

  async function onDeleteCase(c: CaseSummary) {
    if (!window.confirm(t('cases.deleteConfirm'))) return;
    try {
      await apiDelete(`/cases/${encodeURIComponent(appId)}/${encodeURIComponent(c.id)}`);
      loadCases();
    } catch {
      /* 忽略 */
    }
  }

  async function onSaveCase(e: FormEvent) {
    e.preventDefault();
    setSavingCase(true);
    try {
      if (editingCaseId) {
        await apiPut(
          `/cases/${encodeURIComponent(appId)}/${encodeURIComponent(editingCaseId)}`,
          { name: caseName, yaml: caseYaml },
        );
      } else {
        await apiPost('/cases', { app: appId, name: caseName, yaml: caseYaml });
      }
      setShowCaseForm(false);
      resetCaseForm();
      loadCases();
    } finally {
      setSavingCase(false);
    }
  }

  async function onDeleteTask(jobId: string) {
    if (!window.confirm(t('tasks.deleteConfirm'))) return;
    try {
      await apiDelete(`/tasks/${encodeURIComponent(jobId)}`);
      loadTasks();
    } catch {
      /* 忽略 */
    }
  }

  async function onDeleteReport(jobId: string) {
    if (!window.confirm(t('report.deleteConfirm'))) return;
    try {
      await apiDelete(`/tasks/${encodeURIComponent(jobId)}`);
      loadTasks();
    } catch {
      /* 忽略 */
    }
  }

  async function onSubmitTask(e: FormEvent) {
    e.preventDefault();
    if (!taskCaseId) {
      setTaskError(t('tasks.needAppCase'));
      return;
    }
    setTaskError(null);
    setSubmitting(true);
    try {
      await apiPost('/tasks', {
        backend,
        appId,
        caseId: taskCaseId,
        category: 'exploration',
        ...(VLM_BACKENDS.has(backend) && vlmModel ? { vlmModel } : {}),
        ...(selectedKbIds.length > 0 ? { knowledgeBaseIds: selectedKbIds } : {}),
      });
      setShowTaskForm(false);
      setTaskCaseId('');
      loadTasks();
    } catch (err) {
      setTaskError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onCancelTask(jobId: string) {
    if (!window.confirm(t('tasks.cancelConfirm'))) return;
    try {
      await apiPost(`/tasks/${jobId}/cancel`, {});
      loadTasks();
    } catch {
      /* 忽略 */
    }
  }

  if (notFound) {
    return (
      <section className="listpage">
        <Link to="/apps" className="ws__back">← {t('workspace.back')}</Link>
        <div className="listpage__empty">
          <p>{t('workspace.notFound')}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="listpage ws">
      <Link to="/apps" className="ws__back">← {t('workspace.back')}</Link>

      {/* App 身份區 */}
      <header className="ws__identity">
        <div className="ws__thumb">
          {app?.iconUrl ? (
            <img src={app.iconUrl} alt={app.name} />
          ) : (
            <span className="ws__thumb-fallback" aria-hidden="true">
              {(app?.name ?? '?').slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>
        <div className="ws__identity-main">
          <h1 className="ws__title">{app?.name ?? appId}</h1>
          <div className="ws__badges">
            {app?.platform && (
              <span className="ws__badge">
                {t(`platform.${app.platform}` as MessageKey)}
              </span>
            )}
            {app?.genre && (
              <span className="ws__badge ws__badge--genre">
                <GenreIcon genre={app.genre} size={13} />
                {t(genreLabelKey(app.genre))}
              </span>
            )}
            {app?.version && <span className="ws__badge ws__mono">{app.version}</span>}
            {app?.identifier && <span className="ws__badge ws__mono">{app.identifier}</span>}
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="ws__tabs" role="tablist">
        {TABS.map((tb) => (
          <button
            key={tb.key}
            type="button"
            role="tab"
            aria-selected={tab === tb.key}
            className={`ws__tab ${tab === tb.key ? 'ws__tab--active' : ''}`}
            onClick={() => setTab(tb.key)}
          >
            {t(tb.labelKey)}
          </button>
        ))}
      </div>

      {/* 總覽 */}
      {tab === 'overview' && (
        <div className="ws__panel">
          <div className="ws__stats">
            <button type="button" className="ws__stat" onClick={() => setTab('cases')}>
              <b>{cases.length}</b>
              <span>{t('workspace.statCases')}</span>
            </button>
            <button type="button" className="ws__stat" onClick={() => setTab('tasks')}>
              <b>{tasks.length}</b>
              <span>{t('workspace.statTasks')}</span>
            </button>
            <button type="button" className="ws__stat" onClick={() => setTab('reports')}>
              <b>{reports.length}</b>
              <span>{t('workspace.statReports')}</span>
            </button>
            <div className="ws__stat">
              <b>{passRate === null ? '—' : `${passRate}%`}</b>
              <span>{t('workspace.statPassRate')}</span>
            </div>
          </div>

          <h2 className="ws__subtitle">{t('workspace.recentTasks')}</h2>
          {tasks.length === 0 ? (
            <p className="ws__empty-note">{t('workspace.noRecent')}</p>
          ) : (
            <ul className="listpage__list">
              {tasks.slice(0, 5).map((x) => (
                <li key={x.jobId} className="listpage__item">
                  <Link to={`/tasks/${x.jobId}`} className="tasks__state-link">
                    <span className={`task-state ${stateClass(x.state)}`}>
                      {t(`state.${x.state}` as MessageKey)}
                    </span>
                  </Link>
                  <span className="ws__muted">
                    {caseNameById.get(x.caseId) ?? x.caseId}
                  </span>
                  <span style={{ marginLeft: 'auto' }} className="ws__muted">
                    {new Date(x.createdAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 測試案例(鎖定本 App) */}
      {tab === 'cases' && (
        <div className="ws__panel">
          <div className="ws__panel-head">
            {!showCaseForm && (
              <button type="button" className="ws__primary" onClick={openCreateCase}>
                {t('cases.create')}
              </button>
            )}
          </div>

          {showCaseForm && (
            <form ref={caseFormRef} className="ws__form" onSubmit={onSaveCase}>
              {editingCaseId && <h3 className="ws__subtitle">{t('cases.editTitle')}</h3>}
              <label className="ws__field">
                <span className="ws__label">{t('cases.name')}</span>
                <input required value={caseName} onChange={(e) => setCaseName(e.target.value)} />
              </label>
              <label className="ws__field">
                <span className="ws__label">{t('cases.describe')}</span>
                <textarea
                  className="ws__textarea"
                  rows={3}
                  value={caseDesc}
                  onChange={(e) => setCaseDesc(e.target.value)}
                  placeholder={t('cases.describeHint')}
                />
                <button
                  type="button"
                  className="ws__secondary"
                  onClick={onDraft}
                  disabled={drafting || !caseDesc.trim()}
                >
                  {drafting ? t('cases.drafting') : t('cases.draft')}
                </button>
              </label>
              <label className="ws__field">
                <span className="ws__label">{t('cases.yamlLabel')}</span>
                <textarea
                  className="ws__textarea ws__mono"
                  rows={10}
                  value={caseYaml}
                  onChange={(e) => setCaseYaml(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <div className="ws__form-actions">
                <button
                  type="button"
                  className="ws__secondary"
                  onClick={() => {
                    setShowCaseForm(false);
                    resetCaseForm();
                  }}
                >
                  {t('cases.cancel')}
                </button>
                <button
                  type="submit"
                  className="ws__primary"
                  disabled={savingCase || !caseName.trim() || !caseYaml.trim()}
                >
                  {savingCase
                    ? t('cases.saving')
                    : editingCaseId
                      ? t('cases.saveEdit')
                      : t('cases.save')}
                </button>
              </div>
            </form>
          )}

          {cases.length === 0 ? (
            <div className="listpage__empty"><p>{t('page.cases.empty')}</p></div>
          ) : (
            <ul className="listpage__list">
              {cases.map((c) => (
                <li key={c.id} className="listpage__item cases__item">
                  <span className="cases__item-name">{c.name}</span>
                  <span style={{ marginLeft: 'auto' }}>
                    <CaseTrendBadge app={c.app} caseId={c.id} />
                  </span>
                  <span className="cases__item-actions">
                    <button
                      type="button"
                      className="cases__row-btn"
                      onClick={() => void openEditCase(c)}
                    >
                      {t('cases.edit')}
                    </button>
                    <button
                      type="button"
                      className="cases__row-btn cases__row-btn--danger"
                      onClick={() => void onDeleteCase(c)}
                    >
                      {t('cases.delete')}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 測試任務(鎖定本 App) */}
      {tab === 'tasks' && (
        <div className="ws__panel">
          <div className="ws__panel-head">
            {!showTaskForm && (
              <button
                type="button"
                className="ws__primary"
                onClick={() => setShowTaskForm(true)}
                disabled={cases.length === 0}
              >
                {t('tasks.submit')}
              </button>
            )}
          </div>

          {showTaskForm && (
            <form ref={taskFormRef} className="ws__form" onSubmit={onSubmitTask}>
              <label className="ws__field">
                <span className="ws__label">{t('tasks.case')}</span>
                <select value={taskCaseId} onChange={(e) => setTaskCaseId(e.target.value)}>
                  <option value="">—</option>
                  {cases.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label className="ws__field">
                <span className="ws__label">{t('tasks.backend')}</span>
                <select value={backend} onChange={(e) => setBackend(e.target.value)}>
                  {BACKENDS.map((b) => (
                    <option key={b.value} value={b.value} disabled={!b.supported}>
                      {t(b.labelKey)}
                      {!b.supported
                        ? ` (${t('backend.unsupported')})`
                        : b.value === 'web'
                          ? ` — ${t('backend.webPreview')}`
                          : ''}
                    </option>
                  ))}
                </select>
              </label>
              {/* 真機/模擬器探索:選判座標的 VLM 模型(這就是「探索時選模型」)。 */}
              {VLM_BACKENDS.has(backend) && vlmModels.length > 0 && (
                <>
                  <label className="ws__field">
                    <span className="ws__label">{t('tasks.vlmModel')}</span>
                    <select value={vlmModel} onChange={(e) => setVlmModel(e.target.value)}>
                      {vlmModels.map((m) => (
                        <option key={m.modelId} value={m.modelId}>{modelOptionLabel(m)}</option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {kbs.length > 0 && (
                <div className="ws__field">
                  <span className="ws__label">{t('tasks.knowledgeBases')}</span>
                  <div className="ws__kb-list">
                    {kbs.map((kb) => (
                      <label key={kb.id} className="ws__kb-option">
                        <input
                          type="checkbox"
                          checked={selectedKbIds.includes(kb.id)}
                          onChange={(e) => {
                            setSelectedKbIds((prev) =>
                              e.target.checked
                                ? [...prev, kb.id]
                                : prev.filter((id) => id !== kb.id),
                            );
                          }}
                        />
                        <span>{kb.name}</span>
                      </label>
                    ))}
                  </div>
                  <span className="ws__muted">{t('tasks.knowledgeBasesHint')}</span>
                </div>
              )}
              {taskError && <p className="listpage__error" role="alert">{taskError}</p>}
              <div className="ws__form-actions">
                <button type="button" className="ws__secondary" onClick={() => setShowTaskForm(false)}>
                  {t('tasks.cancel')}
                </button>
                <button type="submit" className="ws__primary" disabled={submitting}>
                  {submitting ? t('tasks.submitting') : t('tasks.submitBtn')}
                </button>
              </div>
            </form>
          )}

          {tasks.length === 0 ? (
            <div className="listpage__empty"><p>{t('page.tasks.empty')}</p></div>
          ) : (
            <table className="tasks__table">
              <thead>
                <tr>
                  <th>{t('tasks.colState')}</th>
                  <th>{t('tasks.case')}</th>
                  <th>{t('tasks.colBackend')}</th>
                  <th>{t('tasks.colCreated')}</th>
                  <th>{t('tasks.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((x) => (
                  <tr key={x.jobId}>
                    <td>
                      <Link to={`/tasks/${x.jobId}`} className="tasks__state-link">
                        <span className={`task-state ${stateClass(x.state)}`}>
                          {t(`state.${x.state}` as MessageKey)}
                        </span>
                      </Link>
                    </td>
                    <td className="ws__muted">{caseNameById.get(x.caseId) ?? x.caseId}</td>
                    <td>{t(`backend.${x.backend}` as MessageKey)}</td>
                    <td className="tasks__created">{new Date(x.createdAt).toLocaleString()}</td>
                    <td>
                      {!TERMINAL.has(x.state) ? (
                        <button
                          type="button"
                          className="tasks__row-cancel"
                          onClick={() => onCancelTask(x.jobId)}
                        >
                          {t('tasks.cancel')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="tasks__row-cancel"
                          onClick={() => void onDeleteTask(x.jobId)}
                        >
                          {t('tasks.delete')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 測試報告(本 App 的終局任務) */}
      {tab === 'reports' && (
        <div className="ws__panel">
          {reports.length === 0 ? (
            <div className="listpage__empty"><p>{t('page.reports.empty')}</p></div>
          ) : (
            <ul className="listpage__list">
              {reports.map((x) => (
                <li key={x.jobId} className="listpage__item">
                  <span className={`task-state ${stateClass(x.state)}`}>
                    {t(`state.${x.state}` as MessageKey)}
                  </span>
                  <span className="ws__muted">{caseNameById.get(x.caseId) ?? x.caseId}</span>
                  <span style={{ marginLeft: 'auto' }} className="reports__row-actions">
                    <Link to={`/reports/${x.jobId}`}>{t('workspace.openReport')}</Link>
                    <button
                      type="button"
                      className="reports__row-delete"
                      onClick={() => void onDeleteReport(x.jobId)}
                    >
                      {t('report.delete')}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 記憶地圖(導向完整頁,附統計) */}
      {tab === 'memory' && (
        <div className="ws__panel">
          {memStats && (memStats.pages > 0 || memStats.edges > 0) ? (
            <>
              <div className="ws__stats">
                <div className="ws__stat"><b>{memStats.pages}</b><span>{t('memory.statPages')}</span></div>
                <div className="ws__stat"><b>{memStats.edges}</b><span>{t('memory.statEdges')}</span></div>
              </div>
              <Link className="ws__primary ws__link-btn" to={`/memory?app=${encodeURIComponent(appId)}`}>
                {t('workspace.viewMemory')}
              </Link>
            </>
          ) : (
            <div className="listpage__empty"><p>{t('page.memory.empty')}</p></div>
          )}
        </div>
      )}
    </section>
  );
}
