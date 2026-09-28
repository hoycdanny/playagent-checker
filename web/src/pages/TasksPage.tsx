import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, apiDelete, type ListResponse } from '../api/client.ts';
import { usePagedList } from '../api/usePagedList.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import AppBadge, { type AppRef } from '../components/AppRef.tsx';
import TaskIcon from '../components/TaskIcon.tsx';
import { modelLabel } from '../components/modelProvider.ts';
import { recommendedDefault, sortByRecommend, starLabel } from '../components/modelRecommend.ts';
import './ListPage.css';
import './TasksPage.css';

type AppRecord = AppRef & { defaultKnowledgeBaseIds?: string[] };
interface CaseSummary {
  id: string;
  app: string;
  name: string;
}
interface TaskItem {
  jobId: string;
  backend: string;
  locality: string;
  category: string;
  appId: string;
  caseId: string;
  state: string;
  createdAt: string;
  updatedAt?: string;
  vlmModel?: string;
  seatModels?: { agent?: string; vlm?: string; subagent?: string };
  billableSpendUsd?: number;
  spendEstimated?: boolean;
  stepCount?: number;
}

// 後端選項:模擬器(emulator)/Windows 已淘汰(改用 Device Farm 真機),不再列出。
const BACKENDS: { value: string; labelKey: MessageKey }[] = [
  { value: 'web', labelKey: 'backend.web' },
  { value: 'devicefarm', labelKey: 'backend.devicefarm' },
  { value: 'attached', labelKey: 'backend.attached' },
];

/** 目前可端到端執行的後端(其餘標「尚未支援」並停用,避免誤選後才失敗)。
 *  devicefarm=iOS/Android 真機(取代模擬器,可過遊戲伺服器對模擬器的檢查);web=Lambda 瀏覽器。 */
const SUPPORTED_BACKENDS = new Set(['web', 'devicefarm']);
/** 需要選 VLM 模型(判畫面座標)的後端。 */
const VLM_BACKENDS = new Set(['emulator', 'devicefarm', 'attached']);

interface ModelEntry {
  modelId: string;
  displayName: string;
  pricing?: { inputPerM: number; outputPerM: number; estimated?: boolean };
}

/** 模型下拉顯示:名稱 + 每百萬 token 進/出價(估算價標註)。
 *  自建模型(如 UI-TARS,單價 0/0)不按 token 計費,改標「常駐 GPU 計費」。 */
function modelOptionLabel(m: ModelEntry): string {
  if (!m.pricing) return m.displayName;
  const { inputPerM, outputPerM, estimated } = m.pricing;
  if (inputPerM === 0 && outputPerM === 0) return `${m.displayName} — 常駐 GPU 計費`;
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  return `${m.displayName} — ${fmt(inputPerM)}/${fmt(outputPerM)} 每百萬 token${estimated ? '(估算)' : ''}`;
}

/** 六終局狀態 + 執行中 + 排隊。狀態篩選對每個狀態只有一個選項(Req 10.4)。 */
const STATES = [
  'queued',
  'running',
  'pass',
  'fail',
  'error',
  'cancelled',
  'budget_exceeded',
  'dead',
] as const;

/** 終局狀態(不再變動)—— 用於決定是否還要輪詢與能否取消。 */
const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);

/** 建立時間:一律 24 小時制(MM/DD HH:mm:ss,不顯示年份),不受地區 AM/PM 影響。 */
function formatCreated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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

interface KnowledgeBaseSummary {
  id: string;
  name: string;
  kind: string;
}

export default function TasksPage() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [kbs, setKbs] = useState<KnowledgeBaseSummary[]>([]);
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([]);

  const [showForm, setShowForm] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (showForm) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [showForm]);
  const [appId, setAppId] = useState('');
  const [caseId, setCaseId] = useState('');
  const [backend, setBackend] = useState('web');
  const [vlmModel, setVlmModel] = useState('');
  const [vlmModels, setVlmModels] = useState<ModelEntry[]>([]);
  const [agentModel, setAgentModel] = useState('');
  const [agentModels, setAgentModels] = useState<ModelEntry[]>([]);
  const [subagentModel, setSubagentModel] = useState('');
  const [subagentModels, setSubagentModels] = useState<ModelEntry[]>([]);
  // 步數/預算上限:空字串 = 無上限(不帶入提交,引擎/ runner 端不設閘口)。
  const [maxSteps, setMaxSteps] = useState('');
  const [budgetUsd, setBudgetUsd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 多欄位篩選:狀態 / 環境 / 位置 / 應用(空字串 = 全部)。
  const [stateFilter, setStateFilter] = useState<string>('');
  const [backendFilter, setBackendFilter] = useState<string>('');
  const [localityFilter, setLocalityFilter] = useState<string>('');
  const [appFilter, setAppFilter] = useState<string>('');
  // 批次刪除:勾選的 jobId 集合。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);

  async function refetch() {
    const res = await apiGet<ListResponse<TaskItem>>('/tasks');
    setTasks(res.items);
    setLoading(false);
  }

  useEffect(() => {
    refetch().catch(() => setLoading(false));
    apiGet<ListResponse<AppRecord>>('/apps').then((r) => setApps(r.items)).catch(() => {});
    apiGet<ListResponse<CaseSummary>>('/cases').then((r) => setCases(r.items)).catch(() => {});
    apiGet<ListResponse<KnowledgeBaseSummary>>('/knowledge-bases')
      .then((r) => setKbs(r.items))
      .catch(() => {});
    // 各角色 Seat 可選模型:vlm=分析畫面、agent=控制遊戲、subagent=子代理。
    // 預設 = 各 seat 推薦第 1 名;下拉選項前 5 名置頂並加 ★(見 modelRecommend)。
    apiGet<ListResponse<ModelEntry>>('/models?seat=vlm')
      .then((r) => {
        setVlmModels(sortByRecommend('vlm', r.items));
        setVlmModel(recommendedDefault('vlm', r.items));
      })
      .catch(() => {});
    apiGet<ListResponse<ModelEntry>>('/models?seat=agent')
      .then((r) => {
        setAgentModels(sortByRecommend('agent', r.items));
        setAgentModel(recommendedDefault('agent', r.items));
      })
      .catch(() => {});
    apiGet<ListResponse<ModelEntry>>('/models?seat=subagent')
      .then((r) => {
        setSubagentModels(sortByRecommend('subagent', r.items));
        setSubagentModel(recommendedDefault('subagent', r.items));
      })
      .catch(() => {});
  }, []);

  // 有執行中/排隊任務時自動輪詢(Req 3.6 讀 status 真相源)。
  useEffect(() => {
    const hasActive = tasks.some((x) => !TERMINAL.has(x.state));
    if (!hasActive) return;
    const timer = setInterval(() => {
      refetch().catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [tasks]);

  const casesForApp = cases.filter((c) => c.app === appId);
  const appById = useMemo(() => {
    const m = new Map<string, AppRecord>();
    for (const a of apps) m.set(a.id, a);
    return m;
  }, [apps]);

  // 篩選下拉選項:只列出「目前任務中實際出現過」的環境/位置/應用,避免出現無資料的死選項。
  const availableBackends = useMemo(
    () => [...new Set(tasks.map((x) => x.backend))].sort(),
    [tasks],
  );
  const availableLocalities = useMemo(
    () => [...new Set(tasks.map((x) => x.locality))].sort(),
    [tasks],
  );
  const availableApps = useMemo(() => {
    const ids = [...new Set(tasks.map((x) => x.appId))];
    return ids
      .map((id) => ({ id, name: appById.get(id)?.name ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tasks, appById]);

  // 是否已套用任一篩選(用於顯示「清除篩選」)。篩選器現在內嵌於表頭。
  const hasFilter = Boolean(stateFilter || backendFilter || localityFilter || appFilter);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!appId || !caseId) {
      setError(t('tasks.needAppCase'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await apiPost('/tasks', {
        backend,
        appId,
        caseId,
        ...(VLM_BACKENDS.has(backend) && vlmModel ? { vlmModel } : {}),
        ...(VLM_BACKENDS.has(backend) && agentModel ? { agentModel } : {}),
        ...(VLM_BACKENDS.has(backend) && subagentModel ? { subagentModel } : {}),
        ...(selectedKbIds.length > 0 ? { knowledgeBaseIds: selectedKbIds } : {}),
        // 空 = 無上限:僅在填了正數時帶入。
        ...(Number(maxSteps) > 0 ? { maxSteps: Number(maxSteps) } : {}),
        ...(Number(budgetUsd) > 0 ? { budgetUsd: Number(budgetUsd) } : {}),
      });
      setShowForm(false);
      setCaseId('');
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onCancel(jobId: string) {
    if (!window.confirm(t('tasks.cancelConfirm'))) return;
    try {
      await apiPost(`/tasks/${jobId}/cancel`, {});
      await refetch();
    } catch {
      /* 忽略 */
    }
  }

  async function onDelete(jobId: string) {
    if (!window.confirm(t('tasks.deleteConfirm'))) return;
    try {
      await apiDelete(`/tasks/${encodeURIComponent(jobId)}`);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
      await refetch();
    } catch {
      /* 忽略 */
    }
  }

  // 批次刪除:對勾選的任務逐一呼叫單筆刪除 API(後端無批次端點,前端並行呼叫)。
  async function onBatchDelete() {
    if (selectedIds.size === 0) return;
    if (!window.confirm(t('tasks.batchDeleteConfirm').replace('{n}', String(selectedIds.size)))) return;
    setBatchDeleting(true);
    try {
      await Promise.all(
        [...selectedIds].map((jobId) =>
          apiDelete(`/tasks/${encodeURIComponent(jobId)}`).catch(() => {}),
        ),
      );
      setSelectedIds(new Set());
      await refetch();
    } finally {
      setBatchDeleting(false);
    }
  }

  const filtered = tasks.filter(
    (x) =>
      (!stateFilter || x.state === stateFilter) &&
      (!backendFilter || x.backend === backendFilter) &&
      (!localityFilter || x.locality === localityFilter) &&
      (!appFilter || x.appId === appFilter),
  );
  // 客戶端分頁(Req 15.5):清單增長時單次渲染量不隨總量無上限成長。
  const { visible, hasMore, shownCount, total, loadMore } = usePagedList(filtered);

  return (
    <section className="listpage listpage--wide">
      <header className="listpage__header tasks__header">
        <h1 className="listpage__title">{t('page.tasks.title')}</h1>
        {!showForm && (
          <button
            type="button"
            className="tasks__submit-btn"
            onClick={() => setShowForm(true)}
          >
            {t('tasks.submit')}
          </button>
        )}
      </header>

      {showForm && (
        <form ref={formRef} className="tasks__form" onSubmit={onSubmit}>
          <label className="tasks__field">
            <span className="tasks__label">{t('tasks.app')}</span>
            <select
              value={appId}
              onChange={(e) => {
                const nextAppId = e.target.value;
                setAppId(nextAppId);
                setCaseId('');
                // 預選該 App 的預設知識庫(可再增減)。
                const app = apps.find((a) => a.id === nextAppId);
                setSelectedKbIds(app?.defaultKnowledgeBaseIds ?? []);
              }}
            >
              <option value="">—</option>
              {apps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="tasks__field">
            <span className="tasks__label">{t('tasks.case')}</span>
            <select value={caseId} onChange={(e) => setCaseId(e.target.value)}>
              <option value="">—</option>
              {casesForApp.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="tasks__field">
            <span className="tasks__label">{t('tasks.backend')}</span>
            <select value={backend} onChange={(e) => setBackend(e.target.value)}>
              {BACKENDS.map((b) => {
                const supported = SUPPORTED_BACKENDS.has(b.value);
                const suffix = !supported
                  ? ` (${t('backend.unsupported')})`
                  : b.value === 'web'
                    ? ` — ${t('backend.webPreview')}`
                    : '';
                return (
                  <option key={b.value} value={b.value} disabled={!supported}>
                    {t(b.labelKey)}
                    {suffix}
                  </option>
                );
              })}
            </select>
          </label>
          {VLM_BACKENDS.has(backend) && (
            <>
              <p className="tasks__models-intro">{t('tasks.modelsIntro')}</p>
              <label className="tasks__field">
                <span className="tasks__label">{t('tasks.modelAgent')}</span>
                <span className="tasks__field-hint">{t('detail.roleAgentHint')}</span>
                <select value={agentModel} onChange={(e) => setAgentModel(e.target.value)}>
                  {agentModels.map((m) => (
                    <option key={m.modelId} value={m.modelId}>
                      {starLabel('agent', m.modelId, modelOptionLabel(m))}
                    </option>
                  ))}
                </select>
              </label>
              <label className="tasks__field">
                <span className="tasks__label">{t('tasks.modelVlm')}</span>
                <span className="tasks__field-hint">{t('detail.roleVlmHint')}</span>
                <select value={vlmModel} onChange={(e) => setVlmModel(e.target.value)}>
                  {vlmModels.map((m) => (
                    <option key={m.modelId} value={m.modelId}>
                      {starLabel('vlm', m.modelId, modelOptionLabel(m))}
                    </option>
                  ))}
                </select>
              </label>
              <label className="tasks__field">
                <span className="tasks__label">{t('tasks.modelSubagent')}</span>
                <span className="tasks__field-hint">{t('detail.roleSubagentHint')}</span>
                <select value={subagentModel} onChange={(e) => setSubagentModel(e.target.value)}>
                  {subagentModels.map((m) => (
                    <option key={m.modelId} value={m.modelId}>
                      {starLabel('subagent', m.modelId, modelOptionLabel(m))}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="tasks__field">
            <span className="tasks__label">{t('tasks.maxSteps')}</span>
            <span className="tasks__field-hint">{t('tasks.maxStepsHint')}</span>
            <input
              type="number"
              min="0"
              inputMode="numeric"
              placeholder={t('tasks.unlimited')}
              value={maxSteps}
              onChange={(e) => setMaxSteps(e.target.value)}
            />
          </label>
          <label className="tasks__field">
            <span className="tasks__label">{t('tasks.budgetUsd')}</span>
            <span className="tasks__field-hint">{t('tasks.budgetUsdHint')}</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              placeholder={t('tasks.unlimited')}
              value={budgetUsd}
              onChange={(e) => setBudgetUsd(e.target.value)}
            />
          </label>
          {kbs.length > 0 && (
            <div className="tasks__field tasks__kb-field">
              <span className="tasks__label">{t('tasks.knowledgeBases')}</span>
              <div className="tasks__kb-list">
                {kbs.map((kb) => (
                  <label key={kb.id} className="tasks__kb-option">
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
              <span className="tasks__kb-hint">{t('tasks.knowledgeBasesHint')}</span>
            </div>
          )}
          {error && (
            <p className="tasks__error" role="alert">
              {error}
            </p>
          )}
          <div className="tasks__actions">
            <button
              type="button"
              className="tasks__cancel-btn"
              onClick={() => setShowForm(false)}
            >
              {t('tasks.cancel')}
            </button>
            <button type="submit" className="tasks__go" disabled={submitting}>
              {submitting ? t('tasks.submitting') : t('tasks.submitBtn')}
            </button>
          </div>
        </form>
      )}

      <div className="tasks__filter">
        <label className="tasks__filter-item">
          <span className="tasks__filter-label">{t('tasks.filterState')}</span>
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">{t('tasks.filterAll')}</option>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {t(`state.${s}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="tasks__filter-item">
          <span className="tasks__filter-label">{t('tasks.colBackend')}</span>
          <select value={backendFilter} onChange={(e) => setBackendFilter(e.target.value)}>
            <option value="">{t('tasks.filterAll')}</option>
            {availableBackends.map((b) => (
              <option key={b} value={b}>
                {t(`backend.${b}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="tasks__filter-item">
          <span className="tasks__filter-label">{t('tasks.colLocality')}</span>
          <select value={localityFilter} onChange={(e) => setLocalityFilter(e.target.value)}>
            <option value="">{t('tasks.filterAll')}</option>
            {availableLocalities.map((l) => (
              <option key={l} value={l}>
                {t(`locality.${l}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="tasks__filter-item">
          <span className="tasks__filter-label">{t('tasks.colApp')}</span>
          <select value={appFilter} onChange={(e) => setAppFilter(e.target.value)}>
            <option value="">{t('tasks.filterAll')}</option>
            {availableApps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {hasFilter && (
          <button
            type="button"
            className="tasks__filter-clear"
            onClick={() => {
              setStateFilter('');
              setBackendFilter('');
              setLocalityFilter('');
              setAppFilter('');
            }}
          >
            {t('tasks.filterClear')}
          </button>
        )}
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

      {loading && tasks.length === 0 ? (
        <div className="listpage__skeleton" aria-hidden="true">
          <div className="listpage__skeleton-row" />
          <div className="listpage__skeleton-row" />
        </div>
      ) : visible.length === 0 ? (
        <div className="listpage__empty">
          <p>{t('page.tasks.empty')}</p>
        </div>
      ) : (
        <table className="tasks__table">
          <thead>
            <tr>
              <th className="tasks__col-check">
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
              </th>
              <th className="tasks__col-icon">{t('tasks.colState')}</th>
              <th>{t('tasks.colCreated')}</th>
              <th>{t('tasks.colApp')}</th>
              <th className="tasks__col-icon">{t('tasks.colBackend')}</th>
              <th className="tasks__col-icon">{t('tasks.colLocality')}</th>
              <th className="tasks__col-steps">{t('tasks.colSteps')}</th>
              <th>{t('tasks.colCost')}</th>
              <th title={t('tasks.roleAgentHint')}>{t('tasks.roleAgent')}</th>
              <th title={t('tasks.roleVlmHint')}>{t('tasks.roleVlm')}</th>
              <th title={t('tasks.roleSubagentHint')}>{t('tasks.roleSubagent')}</th>
              <th>{t('tasks.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((x) => {
              const backendLabel = t(`backend.${x.backend}` as MessageKey);
              const localityLabel = t(`locality.${x.locality}` as MessageKey);
              const renderModel = (modelId: string | undefined) =>
                modelId ? (
                  <span className="tasks__model" title={modelId}>
                    {modelLabel(modelId)}
                  </span>
                ) : (
                  <span className="tasks__muted-cell">—</span>
                );
              return (
              <tr key={x.jobId} className={selectedIds.has(x.jobId) ? 'tasks__row--selected' : ''}>
                <td className="tasks__col-check">
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
                </td>
                <td className="tasks__col-icon">
                  {/* 狀態只是狀態指示(小圖示 + tooltip),不再是進詳情的連結;
                      進詳情改由「操作」欄的檢視 icon(較符合直覺)。顏色沿用 task-state--*。 */}
                  <span className={`tasks__state-link ${stateClass(x.state)}`}>
                    <TaskIcon
                      kind="state"
                      value={x.state}
                      label={t(`state.${x.state}` as MessageKey)}
                    />
                  </span>
                </td>
                <td className="tasks__created">
                  {formatCreated(x.createdAt)}
                </td>
                <td>
                  <AppBadge app={appById.get(x.appId)} fallbackId={x.appId} />
                </td>
                <td className="tasks__col-icon">
                  <TaskIcon kind="backend" value={x.backend} label={backendLabel} />
                </td>
                <td className="tasks__col-icon">
                  <TaskIcon kind="locality" value={x.locality} label={localityLabel} />
                </td>
                <td className="tasks__col-steps">
                  {typeof x.stepCount === 'number' ? (
                    x.stepCount
                  ) : (
                    <span className="tasks__muted-cell">—</span>
                  )}
                </td>
                <td className="tasks__cost">
                  {typeof x.billableSpendUsd === 'number' ? (
                    <span
                      title={
                        x.spendEstimated
                          ? `${t('detail.cost')} (${t('tasks.costEstimatedShort')})`
                          : t('detail.cost')
                      }
                    >
                      ${x.billableSpendUsd.toFixed(2)}
                      {x.spendEstimated && (
                        <span className="tasks__cost-est"> {t('tasks.costEstimatedShort')}</span>
                      )}
                    </span>
                  ) : (
                    <span className="tasks__muted-cell">—</span>
                  )}
                </td>
                <td className="tasks__text-cell">{renderModel(x.seatModels?.agent ?? x.vlmModel)}</td>
                <td className="tasks__text-cell">{renderModel(x.seatModels?.vlm ?? x.vlmModel)}</td>
                <td className="tasks__text-cell">{renderModel(x.seatModels?.subagent)}</td>
                <td className="tasks__col-icon">
                  <div className="tasks__actions">
                    {/* 檢視:進任務詳情(進詳情的唯一入口)。 */}
                    <Link
                      to={`/tasks/${x.jobId}`}
                      className="tasks__icon-btn"
                      title={t('tasks.view')}
                      aria-label={t('tasks.view')}
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </Link>
                    {!TERMINAL.has(x.state) ? (
                      <button
                        type="button"
                        className="tasks__icon-btn"
                        onClick={() => onCancel(x.jobId)}
                        title={t('tasks.cancel')}
                        aria-label={t('tasks.cancel')}
                      >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                          <circle cx="12" cy="12" r="9" />
                          <path d="M9 9l6 6M15 9l-6 6" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="tasks__icon-btn tasks__icon-btn--danger"
                        onClick={() => onDelete(x.jobId)}
                        title={t('tasks.delete')}
                        aria-label={t('tasks.delete')}
                      >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M10 11v6M14 11v6" />
                        </svg>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}

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
    </section>
  );
}
