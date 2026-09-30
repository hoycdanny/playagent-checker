import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { apiGet, apiPost, apiDelete, type ListResponse, type CloudDevice } from '../api/client.ts';
import { usePagedList } from '../api/usePagedList.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import type { AppRef } from '../components/AppRef.tsx';
import { modelLabel } from '../components/modelProvider.ts';
import { recommendedDefault, sortByRecommend, starLabel } from '../components/modelRecommend.ts';
import RangeSlider from '../components/RangeSlider.tsx';
import TasksTable from '../components/TasksTable.tsx';
import DevicePicker from '../components/DevicePicker.tsx';
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
/** 需要選 VLM 模型(判畫面座標)的後端。web 用固定預設模型,不讓使用者選。 */
const VLM_BACKENDS = new Set(['emulator', 'devicefarm', 'attached']);

/** App 平台決定可用的執行後端:web 應用只能用 Web 瀏覽器;原生(android/ios)只能用 Device Farm 真機。 */
function backendForPlatform(platform: string | undefined): string {
  return platform === 'web' ? 'web' : 'devicefarm';
}

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
  // Device Farm 裝置選擇:真機池清單 + 使用者所選裝置 ARN(空 = 讓引擎自動挑第一台可用)。
  const [cloudDevices, setCloudDevices] = useState<CloudDevice[]>([]);
  const [deviceArn, setDeviceArn] = useState('');
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 多欄位篩選:狀態 / 環境 / 位置 / 應用 / 三個模型欄(空字串 = 全部)。
  const [stateFilter, setStateFilter] = useState<string>('');
  const [backendFilter, setBackendFilter] = useState<string>('');
  const [localityFilter, setLocalityFilter] = useState<string>('');
  const [appFilter, setAppFilter] = useState<string>('');
  const [agentFilter, setAgentFilter] = useState<string>('');
  const [vlmFilter, setVlmFilter] = useState<string>('');
  const [subagentFilter, setSubagentFilter] = useState<string>('');
  // 範圍篩選:步數 / 花費。null = 尚未縮限(用完整上下界)。
  const [stepsRange, setStepsRange] = useState<[number, number] | null>(null);
  const [costRange, setCostRange] = useState<[number, number] | null>(null);
  // 批次刪除:勾選的 jobId 集合。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);

  async function refetch() {
    // 只取最新 100 筆:後端據此只讀該 N 筆的物件(避免對全部任務 N+1 展開),
    // 列表載入從十幾秒降到 1~2 秒。前端仍以 usePagedList 於此範圍內漸進顯示。
    const res = await apiGet<ListResponse<TaskItem>>('/tasks?limit=100');
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
    // Device Farm 真機池(供 devicefarm 後端挑機型/版本);唯讀清單。
    apiGet<ListResponse<CloudDevice>>('/devices/cloud')
      .then((r) => setCloudDevices(r.items))
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

  // 每列任務在三個模型欄實際顯示的 modelId(與表格 render 邏輯一致,供篩選比對)。
  const taskAgentModel = (x: TaskItem) => x.seatModels?.agent ?? x.vlmModel;
  const taskVlmModel = (x: TaskItem) => x.seatModels?.vlm ?? x.vlmModel;
  const taskSubagentModel = (x: TaskItem) => x.seatModels?.subagent;

  // 模型欄篩選選項:只列目前任務中實際出現過的 modelId(避免死選項)。
  const availableAgentModels = useMemo(
    () => [...new Set(tasks.map(taskAgentModel).filter(Boolean) as string[])].sort(),
    [tasks],
  );
  const availableVlmModels = useMemo(
    () => [...new Set(tasks.map(taskVlmModel).filter(Boolean) as string[])].sort(),
    [tasks],
  );
  const availableSubagentModels = useMemo(
    () => [...new Set(tasks.map(taskSubagentModel).filter(Boolean) as string[])].sort(),
    [tasks],
  );

  // 步數 / 花費的上下界:取清單實際最小最大(無資料時退回 0)。
  const stepsBounds = useMemo<[number, number]>(() => {
    const v = tasks.map((x) => x.stepCount).filter((n): n is number => typeof n === 'number');
    return v.length ? [Math.min(...v), Math.max(...v)] : [0, 0];
  }, [tasks]);
  const costBounds = useMemo<[number, number]>(() => {
    const v = tasks
      .map((x) => x.billableSpendUsd)
      .filter((n): n is number => typeof n === 'number');
    if (!v.length) return [0, 0];
    // 花費以 2 位小數為 step,上界向上取整到 0.01。
    return [Math.floor(Math.min(...v) * 100) / 100, Math.ceil(Math.max(...v) * 100) / 100];
  }, [tasks]);

  // 目前生效的範圍值(未縮限時用完整上下界)。
  const stepsVal = stepsRange ?? stepsBounds;
  const costVal = costRange ?? costBounds;
  const stepsNarrowed = Boolean(
    stepsRange && (stepsRange[0] > stepsBounds[0] || stepsRange[1] < stepsBounds[1]),
  );
  const costNarrowed = Boolean(
    costRange && (costRange[0] > costBounds[0] || costRange[1] < costBounds[1]),
  );

  // 是否已套用任一篩選(用於顯示「清除篩選」)。
  const hasFilter = Boolean(
    stateFilter ||
      backendFilter ||
      localityFilter ||
      appFilter ||
      agentFilter ||
      vlmFilter ||
      subagentFilter ||
      stepsNarrowed ||
      costNarrowed,
  );

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
        // Device Farm:使用者明選的真機(空 = 引擎自動挑第一台可用)。附機型/版本供顯示。
        ...(backend === 'devicefarm' && deviceArn
          ? (() => {
              const d = cloudDevices.find((x) => x.arn === deviceArn);
              return {
                deviceArn,
                ...(d?.name ? { deviceModel: d.name } : {}),
                ...(d?.os ? { osVersion: d.os } : {}),
              };
            })()
          : {}),
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
      (!appFilter || x.appId === appFilter) &&
      (!agentFilter || taskAgentModel(x) === agentFilter) &&
      (!vlmFilter || taskVlmModel(x) === vlmFilter) &&
      (!subagentFilter || taskSubagentModel(x) === subagentFilter) &&
      // 範圍篩選:僅在縮限時套用。無 stepCount/花費的任務在縮限時排除。
      (!stepsNarrowed ||
        (typeof x.stepCount === 'number' &&
          x.stepCount >= stepsVal[0] &&
          x.stepCount <= stepsVal[1])) &&
      (!costNarrowed ||
        (typeof x.billableSpendUsd === 'number' &&
          x.billableSpendUsd >= costVal[0] &&
          x.billableSpendUsd <= costVal[1])),
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
                // 執行後端由 App 平台決定(web→web 瀏覽器;原生→Device Farm 真機),不讓使用者亂選。
                if (app) setBackend(backendForPlatform(app.platform));
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
            {/* 執行環境由 App 平台決定:選了 App 後鎖定(web→Web 瀏覽器;原生→Device Farm),
                避免 web 應用誤選真機、或原生應用誤選瀏覽器。未選 App 前才可自由選。 */}
            {(() => {
              const selApp = apps.find((a) => a.id === appId);
              if (selApp) {
                const locked = backendForPlatform(selApp.platform);
                const label = BACKENDS.find((b) => b.value === locked);
                return (
                  <>
                    <input
                      type="text"
                      readOnly
                      className="tasks__readonly"
                      value={label ? t(label.labelKey) : locked}
                    />
                    <span className="tasks__field-hint">{t('tasks.backendLocked')}</span>
                  </>
                );
              }
              return (
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
              );
            })()}
          </label>
          {backend === 'devicefarm' && (
            <div className="tasks__field">
              <span className="tasks__label">{t('tasks.device')}</span>
              <span className="tasks__field-hint">{t('tasks.deviceHint')}</span>
              {(() => {
                const d = cloudDevices.find((x) => x.arn === deviceArn);
                const specs = d
                  ? [
                      `Android ${d.os}`,
                      d.arch,
                      d.resolution,
                      typeof d.memoryBytes === 'number'
                        ? `${Math.round(d.memoryBytes / 1024 / 1024 / 1024)} GB`
                        : undefined,
                      d.cpu,
                    ].filter(Boolean)
                  : [];
                return (
                  <div className="tasks__device-pick">
                    <span className="tasks__device-current">
                      {d ? d.name : t('tasks.deviceAuto')}
                      {specs.length > 0 && (
                        <span className="tasks__device-specs">{specs.join(' · ')}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="tasks__device-btn"
                      onClick={() => setDevicePickerOpen(true)}
                    >
                      {t('tasks.deviceChange')}
                    </button>
                  </div>
                );
              })()}
            </div>
          )}
          {devicePickerOpen && (
            <DevicePicker
              devices={cloudDevices}
              value={deviceArn}
              onSelect={(d) => {
                setDeviceArn(d?.arn ?? '');
                setDevicePickerOpen(false);
              }}
              onClose={() => setDevicePickerOpen(false)}
            />
          )}
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
        {/* 篩選欄順序對齊表格欄位:狀態 →(建立時間無篩選)→ 應用程式 → 環境 → 位置 →
            步數 → 花費 → 控制遊戲 → 分析畫面 → 子代理。 */}
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
        {stepsBounds[1] > stepsBounds[0] && (
          <div className="tasks__filter-item">
            <span className="tasks__filter-label">{t('tasks.colSteps')}</span>
            <RangeSlider
              min={stepsBounds[0]}
              max={stepsBounds[1]}
              step={1}
              value={[stepsVal[0], stepsVal[1]]}
              onChange={setStepsRange}
              label={t('tasks.colSteps')}
              minLabel={t('tasks.rangeMin')}
              maxLabel={t('tasks.rangeMax')}
            />
          </div>
        )}
        {costBounds[1] > costBounds[0] && (
          <div className="tasks__filter-item">
            <span className="tasks__filter-label">{t('tasks.colCost')}</span>
            <RangeSlider
              min={costBounds[0]}
              max={costBounds[1]}
              step={0.01}
              value={[costVal[0], costVal[1]]}
              onChange={setCostRange}
              format={(n) => `$${n.toFixed(2)}`}
              label={t('tasks.colCost')}
              minLabel={t('tasks.rangeMin')}
              maxLabel={t('tasks.rangeMax')}
            />
          </div>
        )}
        {availableAgentModels.length > 0 && (
          <label className="tasks__filter-item">
            <span className="tasks__filter-label">{t('tasks.roleAgent')}</span>
            <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
              <option value="">{t('tasks.filterAll')}</option>
              {availableAgentModels.map((id) => (
                <option key={id} value={id}>
                  {modelLabel(id)}
                </option>
              ))}
            </select>
          </label>
        )}
        {availableVlmModels.length > 0 && (
          <label className="tasks__filter-item">
            <span className="tasks__filter-label">{t('tasks.roleVlm')}</span>
            <select value={vlmFilter} onChange={(e) => setVlmFilter(e.target.value)}>
              <option value="">{t('tasks.filterAll')}</option>
              {availableVlmModels.map((id) => (
                <option key={id} value={id}>
                  {modelLabel(id)}
                </option>
              ))}
            </select>
          </label>
        )}
        {availableSubagentModels.length > 0 && (
          <label className="tasks__filter-item">
            <span className="tasks__filter-label">{t('tasks.roleSubagent')}</span>
            <select value={subagentFilter} onChange={(e) => setSubagentFilter(e.target.value)}>
              <option value="">{t('tasks.filterAll')}</option>
              {availableSubagentModels.map((id) => (
                <option key={id} value={id}>
                  {modelLabel(id)}
                </option>
              ))}
            </select>
          </label>
        )}
        {hasFilter && (
          <button
            type="button"
            className="tasks__filter-clear"
            onClick={() => {
              setStateFilter('');
              setBackendFilter('');
              setLocalityFilter('');
              setAppFilter('');
              setAgentFilter('');
              setVlmFilter('');
              setSubagentFilter('');
              setStepsRange(null);
              setCostRange(null);
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
        <TasksTable
          tasks={visible}
          appById={(id) => appById.get(id)}
          onCancel={onCancel}
          onDelete={onDelete}
          showCheckbox
          selectedIds={selectedIds}
          onToggleRow={(jobId, checked) =>
            setSelectedIds((prev) => {
              const next = new Set(prev);
              if (checked) next.add(jobId);
              else next.delete(jobId);
              return next;
            })
          }
          onToggleAll={(checked) =>
            setSelectedIds((prev) => {
              const next = new Set(prev);
              if (checked) visible.forEach((x) => next.add(x.jobId));
              else visible.forEach((x) => next.delete(x.jobId));
              return next;
            })
          }
        />
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
