import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { apiGet, apiPost, apiDelete, type ListResponse, type CloudDevice } from '../api/client.ts';
import { usePagedList } from '../api/usePagedList.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { DisplaySelect, HoursSelect, RuntimeDetail, RuntimeSelect, defaultRuntime, displayError, effectiveHours, runtimeById, type Display, type RuntimeId } from '../components/tasks/RuntimeSelect.tsx';
import { AndroidVersionSelect, EmulatorScreenSelect, FormFactorSelect, deviceFilterHint, type FormFactor } from '../components/tasks/DeviceOptionSelect.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import type { AppRef } from '../components/AppRef.tsx';
import { modelLabel } from '../components/modelProvider.ts';
import { recommendedDefault, recommendStyle, sortByRecommend, starLabel } from '../components/modelRecommend.ts';
import { outcomeKey, outcomeOf, type VerdictInfo } from '../components/outcome.ts';
import RangeSlider from '../components/RangeSlider.tsx';
import TasksTable from '../components/TasksTable.tsx';
import { taskMatchesQuery } from '../components/taskSearch.ts';
import DevicePicker from '../components/DevicePicker.tsx';
import type { CaseVersionSummary } from '../components/cases/CaseVersions.tsx';
import './ListPage.css';
import './TasksPage.css';
import { usd4 } from '../components/money.ts';

type AppRecord = AppRef & {
  defaultKnowledgeBaseIds?: string[];
  /** 使用中的版本(產物 id)。 */
  artifactId?: string;
  /** 已上傳的版本清單(新到舊);多版本 App 才有多筆。 */
  builds?: { artifactId: string; label: string }[];
};
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
  /** 結束時間(報告產生時間;無報告則為最後狀態更新)。 */
  finishedAt?: string;
  /** AI 開始操作遊戲的時間 —— 列表「操作時間」欄的起點。 */
  runStartedAt?: string;
  vlmModel?: string;
  seatModels?: { agent?: string; vlm?: string; subagent?: string };
  billableSpendUsd?: number;
  spendEstimated?: boolean;
  stepCount?: number;
  /** 測試結論(驗收標準;與報告封面同一個值)。 */
  verdict?: VerdictInfo;
  /** 送出任務的使用者。 */
  submittedBy?: string;
  // 以下欄位後端本來就有回(表格也在用),之前只是沒宣告;自由文字搜尋要比對它們。
  /** 執行時的案例名稱 / 版本快照(舊任務可能沒有)。 */
  caseName?: string;
  caseVersion?: string;
  /** 結論或錯誤訊息(報告優先,否則執行狀態訊息)。 */
  message?: string;
  /** 測試內容(案例任務敘述,已截斷)。 */
  task?: string;
  /** 實際跑在哪一台裝置。 */
  deviceModel?: string;
}

/** 需要選「控制遊戲(agent)」「子代理(subagent)」模型的後端。
 *  2026-10-20:web runner 原本只有單一 VLM 座位(同時判座標+決策),所以這裡不開放 web。
 *  現在 webExplorationRunner 已接上與 Device Farm 同一套 agentTeam.mjs
 *  (視覺 Agent 看圖列元件 → 決策 Agent 選動作 → 輔助 Agent 背景核對),故 web 一併開放。
 *  兩個席位留空時,runner 會自動退回原本的單一 VLM 行為。 */
const AGENT_SUBAGENT_BACKENDS = new Set(['web', 'emulator', 'devicefarm', 'attached']);
/** 需要選 VLM 模型(看畫面、判座標)的後端。未選決策 Agent 時,VLM 同時兼任決策。 */
const VLM_BACKENDS = new Set(['web', 'emulator', 'devicefarm', 'attached']);

interface ModelEntry {
  modelId: string;
  displayName: string;
  /** 有值 = 這個模型目前叫不動(原因為英文短句,來自後端實呼驗證);選項反灰。 */
  unavailable?: string;
  pricing?: { inputPerM: number; outputPerM: number; estimated?: boolean };
  /** 管理員在模型管理頁標為推薦(金勾勾)。 */
  recommended?: boolean;
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

/** 狀態篩選:測試結論(通過 / 有風險 / 失敗 / 受阻)+ 執行狀態(排隊、執行中、錯誤…)。值 = outcomeOf。 */
const STATES = [
  'queued',
  'running',
  'pass',
  'pass_risk',
  'fail',
  'blocked',
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
  archived?: boolean;
}

/**
 * 測試任務頁。
 *
 * 傳入 appId 時進入「嵌入模式」:同一份版面嵌在應用工作區的任務分頁裡,
 * 鎖定單一應用 —— 省掉頁標題、應用下拉與應用篩選,並多一個「測試版本」下拉
 * (多版本 App 可以挑舊版重跑)。其餘排版與這頁完全一致。
 */
/** 提交表單的區塊標題等文字。[繁中, English, 简中, 日本語, 한국어] */
const FORM_TEXT = {
  secWhat: ['測試什麼', 'What to test', '测试什么', '何をテストするか', '무엇을 테스트할지'],
  secWhere: ['在哪裡跑', 'Where to run', '在哪里跑', 'どこで実行するか', '어디서 실행할지'],
  secModels: ['AI 模型', 'AI models', 'AI 模型', 'AI モデル', 'AI 모델'],
  secLimits: ['進階:執行上限', 'Advanced: limits', '进阶:执行上限', '詳細:実行上限', '고급: 실행 한도'],
  noLimit: ['不限步數、不限預算', 'No step or budget limit', '不限步数、不限预算', 'ステップ・予算とも無制限', '스텝·예산 무제한'],
  kbChosen: ['已選 {n} 個', '{n} selected', '已选 {n} 个', '{n} 件選択中', '{n}개 선택됨'],
  kbNone: ['尚未選擇知識庫', 'No knowledge base selected', '尚未选择知识库', 'ナレッジベース未選択', '선택된 지식 베이스 없음'],
  kbRemove: ['點一下移除', 'Click to remove', '点一下移除', 'クリックで外す', '클릭하여 제거'],
  kbSearch: ['搜尋知識庫…(點一下加入)', 'Search knowledge bases… (click to add)', '搜索知识库…(点一下加入)', 'ナレッジベースを検索…(クリックで追加)', '지식 베이스 검색…(클릭하여 추가)'],
  kbMore: ['顯示其他 {n} 個', 'Show {n} more', '显示其他 {n} 个', 'ほか {n} 件を表示', '{n}개 더 보기'],
  kbLess: ['收合', 'Show less', '收起', '閉じる', '접기'],
} as const;
const FORM_LOC: Record<string, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };

export default function TasksPage({ appId: lockedApp }: { appId?: string } = {}) {
  const { t, locale } = useI18n();
  const ft = (k: keyof typeof FORM_TEXT): string => FORM_TEXT[k][FORM_LOC[locale] ?? 1] ?? FORM_TEXT[k][1];
  const embedded = Boolean(lockedApp);
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
  const [appId, setAppId] = useState(lockedApp ?? '');
  const [caseId, setCaseId] = useState('');
  // 知識庫挑選:搜尋字 + 是否展開全部(預設只列前 12 個可加入的)。
  const [kbQuery, setKbQuery] = useState('');
  const [kbShowAll, setKbShowAll] = useState(false);
  // 案例版本(空 = 使用中的版本)。caseVersions = null 表示載入中。
  const [caseVersion, setCaseVersion] = useState('');
  const [caseVersions, setCaseVersions] = useState<CaseVersionSummary[] | null>([]);
  const [activeCaseVersion, setActiveCaseVersion] = useState<string | undefined>();
  useEffect(() => {
    setCaseVersion('');
    setActiveCaseVersion(undefined);
    if (!appId || !caseId) { setCaseVersions([]); return; }
    let stale = false;
    setCaseVersions(null);
    apiGet<{ active?: string; items: CaseVersionSummary[] }>(`/cases/${encodeURIComponent(appId)}/${encodeURIComponent(caseId)}/versions`)
      .then((r) => { if (!stale) { setCaseVersions(r.items ?? []); setActiveCaseVersion(r.active); } })
      .catch(() => { if (!stale) setCaseVersions([]); });
    return () => { stale = true; };
  }, [appId, caseId]);
  // 要測哪一版(空 = 應用目前使用中的版本);只在嵌入模式且有多版本時出現。
  const [buildId, setBuildId] = useState('');
  const [backend, setBackend] = useState('web');
  const [runtimeId, setRuntimeId] = useState<RuntimeId>('web');
  // Android 容器 / Windows 的最長執行時數。
  const [maxHours, setMaxHours] = useState(6);
  // Windows 啟動時的畫面解析度(GameLift Streams 虛擬螢幕)。
  const [display, setDisplay] = useState<Display>({ width: 1920, height: 1080 });
  // 模擬器:Android 版本與螢幕尺寸(螢幕尺寸決定 App 走手機或平板版面)。
  const [androidVersion, setAndroidVersion] = useState('15');
  const [emuScreen, setEmuScreen] = useState({ width: 1080, height: 1920 });
  // Device Farm:挑手機還是平板(真機池兩種都有)。這一步會過濾下面的裝置清單。
  const [formFactor, setFormFactor] = useState<FormFactor>('PHONE');
  const [vlmModel, setVlmModel] = useState('');
  const [vlmModels, setVlmModels] = useState<ModelEntry[]>([]);
  const [agentModel, setAgentModel] = useState('');
  const [agentModels, setAgentModels] = useState<ModelEntry[]>([]);
  const [subagentModel, setSubagentModel] = useState('');
  const [subagentModels, setSubagentModels] = useState<ModelEntry[]>([]);
  // 步數/預算上限:空字串 = 無上限(不帶入提交,引擎/ runner 端不設閘口)。
  const [maxSteps, setMaxSteps] = useState('');
  // Device Farm 執行時長(段數):'1' 單段 / '2' / '4' / '0' 不限。
  const [maxSegments, setMaxSegments] = useState('1');
  const [budgetUsd, setBudgetUsd] = useState('');
  // Device Farm 裝置選擇:真機池清單 + 使用者所選裝置 ARN(空 = 自動派發)。
  // 流程刻意是「執行環境 → 機型態 → 過濾後的機型」:機型態先收斂清單,再挑機或交給自動派發。
  const [cloudDevices, setCloudDevices] = useState<CloudDevice[]>([]);
  const [deviceArn, setDeviceArn] = useState('');
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  // 機型態過濾後的清單。ANY = 不過濾;其餘比對每台的 formFactor。
  const filteredDevices = useMemo(
    () => (formFactor === 'ANY' ? cloudDevices : cloudDevices.filter((d) => (d.formFactor || 'PHONE') === formFactor)),
    [cloudDevices, formFactor],
  );
  // 換了機型態之後,原本選的那台可能已經不在清單裡 —— 必須清掉,
  // 不然會送出「機型態=平板、裝置=某支手機」這種自相矛盾的設定,而且畫面上看不出哪裡不對。
  useEffect(() => {
    if (deviceArn && !filteredDevices.some((d) => d.arn === deviceArn)) setDeviceArn('');
  }, [deviceArn, filteredDevices]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 自由文字搜尋:任務編號 / 案例 / 應用 / 裝置 / 訊息 / 送出者(見 taskSearch.ts)。
  // 其餘篩選器都是「從既有值挑一個」,唯獨「我知道這個 jobId,它在哪一列」沒有入口。
  const [query, setQuery] = useState<string>('');
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
    // 嵌入模式帶 ?app=:後端在截斷「之前」就篩,冷門應用才不會看起來沒有任務。
    const path = lockedApp
      ? `/tasks?app=${encodeURIComponent(lockedApp)}&limit=200`
      : '/tasks?limit=100';
    const res = await apiGet<ListResponse<TaskItem>>(path);
    setTasks(res.items);
    setLoading(false);
  }

  useEffect(() => {
    refetch().catch(() => setLoading(false));
    apiGet<ListResponse<AppRecord>>('/apps').then((r) => setApps(r.items)).catch(() => {});
    apiGet<ListResponse<CaseSummary>>('/cases')
      .then((r) => setCases(lockedApp ? r.items.filter((c) => c.app === lockedApp) : r.items))
      .catch(() => {});
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 嵌入模式:應用載入後套用它的預設執行環境與預設知識庫
  //(非嵌入模式這件事發生在使用者選應用的 onChange 裡)。
  const lockedAppRecord = lockedApp ? apps.find((a) => a.id === lockedApp) : undefined;
  useEffect(() => {
    if (!lockedAppRecord) return;
    const r = defaultRuntime(lockedAppRecord.platform);
    setRuntimeId(r.id);
    setBackend(r.backend);
    setSelectedKbIds(lockedAppRecord.defaultKnowledgeBaseIds ?? []);
  }, [lockedAppRecord]);

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
    query.trim() ||
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
        // 指定案例版本(空 = 使用中的版本)。
        ...(caseVersion ? { caseVersion } : {}),
        // 多版本 App:指定要測的版本(空 = 使用中的版本)。
        ...(buildId ? { buildId } : {}),
        ...(VLM_BACKENDS.has(backend) && vlmModel ? { vlmModel } : {}),
        ...(AGENT_SUBAGENT_BACKENDS.has(backend) && agentModel ? { agentModel } : {}),
        ...(AGENT_SUBAGENT_BACKENDS.has(backend) && subagentModel ? { subagentModel } : {}),
        ...(selectedKbIds.length > 0 ? { knowledgeBaseIds: selectedKbIds } : {}),
        // 空 = 無上限:僅在填了正數時帶入。
        ...(Number(maxSteps) > 0 ? { maxSteps: Number(maxSteps) } : {}),
        ...(Number(budgetUsd) > 0 ? { budgetUsd: Number(budgetUsd) } : {}),
        ...(backend === 'devicefarm' && maxSegments !== '1' ? { maxSegments: Number(maxSegments) } : {}),
        ...(backend === 'emulator' || backend === 'windows' ? { maxHours: effectiveHours(backend, maxHours) } : {}),
        ...(backend === 'windows' ? { display } : {}),
        // 模擬器:Android 版本 + 螢幕尺寸(= 手機/平板版面)。
        ...(backend === 'emulator' ? { androidVersion, display: emuScreen } : {}),
        // Device Farm:機型。沒有明選裝置時才有意義 —— 有 ARN 就已經決定是哪一台了。
        ...(backend === 'devicefarm' && !deviceArn ? { formFactor } : {}),
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

  // 勾選的任務依狀態分成「可刪除(已結束)」與「可取消(執行中/排隊)」—— 表格不再有每列的操作鈕。
  const stateById = new Map(tasks.map((x) => [x.jobId, x.state]));
  const selectedDone = [...selectedIds].filter((id) => TERMINAL.has(stateById.get(id) ?? ''));
  const selectedActive = [...selectedIds].filter((id) => stateById.has(id) && !TERMINAL.has(stateById.get(id)!));
  const [batchCancelling, setBatchCancelling] = useState(false);

  async function onBatchCancel() {
    if (selectedActive.length === 0) return;
    if (!window.confirm(t('tasks.batchCancelConfirm').replace('{n}', String(selectedActive.length)))) return;
    setBatchCancelling(true);
    const failed: string[] = [];
    try {
      for (const jobId of selectedActive) {
        try {
          await apiPost(`/tasks/${encodeURIComponent(jobId)}/cancel`, {});
        } catch {
          failed.push(jobId);
        }
      }
      setSelectedIds((prev) => new Set([...prev].filter((id) => !selectedActive.includes(id) || failed.includes(id))));
      if (failed.length) window.alert(t('tasks.batchCancelFailed').replace('{n}', String(failed.length)));
    } finally {
      await refetch().catch(() => {});
      setBatchCancelling(false);
    }
  }

  // 批次刪除(只刪已結束的):後端無批次端點,逐筆呼叫單筆刪除 API。限制同時 3 筆:長測試一筆就有數千個檔案,
  // 全部並行會讓 S3 節流、Lambda 逾時,造成部分任務沒刪乾淨。失敗的保留勾選並提示。
  async function onBatchDelete() {
    if (selectedDone.length === 0) return;
    if (!window.confirm(t('tasks.batchDeleteConfirm').replace('{n}', String(selectedDone.length)))) return;
    setBatchDeleting(true);
    const queue = [...selectedDone];
    const failed: string[] = [];
    try {
      const worker = async () => {
        for (let jobId = queue.shift(); jobId; jobId = queue.shift()) {
          try {
            await apiDelete(`/tasks/${encodeURIComponent(jobId)}`);
          } catch {
            failed.push(jobId);
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      // 刪掉的移出勾選;失敗的與未處理的執行中任務保留。
      setSelectedIds((prev) => new Set([...prev].filter((id) => !selectedDone.includes(id) || failed.includes(id))));
      if (failed.length) window.alert(t('tasks.batchDeleteFailed').replace('{n}', String(failed.length)));
    } finally {
      await refetch().catch(() => {});
      setBatchDeleting(false);
    }
  }

  const filtered = tasks.filter(
    (x) =>
      taskMatchesQuery(x, query, appById.get(x.appId)?.name) &&
      (!stateFilter || outcomeOf(x) === stateFilter) &&
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
    <section className={`listpage listpage--wide${embedded ? ' listpage--embed' : ''}`}>
      <header className="listpage__header tasks__header">
        {!embedded && <h1 className="listpage__title">{t('page.tasks.title')}</h1>}
        {/* 勾選後的批次動作放在「提交任務」旁邊:勾選是在表格裡做的,動作鈕要在同一個
            視線範圍內(放在篩選列末端時,篩選條件一多就會被推到別的位置)。 */}
        <div className="tasks__header-actions">
          {!showForm && (
            <button
              type="button"
              className="tasks__submit-btn"
              onClick={() => setShowForm(true)}
            >
              {t('tasks.submit')}
            </button>
          )}
          {selectedActive.length > 0 && (
            <button
              type="button"
              className="tasks__batch-cancel"
              onClick={onBatchCancel}
              disabled={batchCancelling}
            >
              {batchCancelling
                ? t('tasks.batchCancelling')
                : t('tasks.batchCancel').replace('{n}', String(selectedActive.length))}
            </button>
          )}
          {selectedDone.length > 0 && (
            <button
              type="button"
              className="tasks__batch-delete"
              onClick={onBatchDelete}
              disabled={batchDeleting}
            >
              {batchDeleting
                ? t('tasks.batchDeleting')
                : t('tasks.batchDelete').replace('{n}', String(selectedDone.length))}
            </button>
          )}
        </div>
      </header>

      {showForm && (
        <form ref={formRef} className="tasks__form tform" onSubmit={onSubmit}>
          {/* ① 測試什麼 */}
          <fieldset className="tform__sec">
            <legend className="tform__legend"><span className="tform__num">1</span>{ft('secWhat')}</legend>
            <div className="tform__grid tform__grid--3">
              {/* 嵌入工作區時應用已鎖定,不顯示這個下拉 */}
              {!embedded && (
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
                      // 執行後端由 App 平台決定(web→web 瀏覽器;原生→Device Farm 真機)。
                      if (app) {
                        const r = defaultRuntime(app.platform);
                        setRuntimeId(r.id);
                        setBackend(r.backend);
                        setMaxSegments('1');
                      }
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
              )}
              <label className="tasks__field tform__wide">
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
              {/* 案例版本:預設「使用中」的版本;可挑舊版本重跑(每個版本內容不可變)。 */}
              <label className="tasks__field">
                <span className="tasks__label">{t('tasks.caseVersion')}</span>
                <select
                  value={caseVersion}
                  onChange={(e) => setCaseVersion(e.target.value)}
                  disabled={!caseId || caseVersions === null}
                >
                  <option value="">
                    {!caseId
                      ? '—'
                      : caseVersions === null
                        ? t('tasks.caseVersionLoading')
                        : `${t('tasks.caseVersionActive')}${activeCaseVersion ? ` · ${activeCaseVersion}` : ''}`}
                  </option>
                  {(caseVersions ?? []).map((v) => (
                    <option key={v.version} value={v.version}>
                      {v.version}
                      {v.version === activeCaseVersion ? ` (${t('tasks.caseVersionInUse')})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              {/* 多版本 App:挑一版來測(預設使用中的版本)。版本管理在工作區的「版本」分頁。 */}
              {(lockedAppRecord?.builds?.length ?? 0) > 1 && (
                <label className="tasks__field">
                  <span className="tasks__label">{t('workspace.buildPick')}</span>
                  <select value={buildId} onChange={(e) => setBuildId(e.target.value)}>
                    <option value="">{t('workspace.buildUseActive')}</option>
                    {(lockedAppRecord?.builds ?? []).map((b) => (
                      <option key={b.artifactId} value={b.artifactId}>
                        {b.label}
                        {b.artifactId === lockedAppRecord?.artifactId
                          ? ` (${t('workspace.buildActive')})`
                          : ''}
                      </option>
                    ))}
                  </select>
                  <span className="tasks__field-hint">{t('workspace.buildPickHint')}</span>
                </label>
              )}
            </div>
          </fieldset>

          {/* ② 在哪裡跑 */}
          <fieldset className="tform__sec">
            <legend className="tform__legend"><span className="tform__num">2</span>{ft('secWhere')}</legend>
            {/* 一列排完這一步要決定的事(執行環境 → 機型態 → 機型 / Android 版本)。
                欄數由實際欄位數決定(auto-fit),所以 3 個欄位是 3 等欄、4 個是 4 等欄,
                不會出現「第 4 個自己掉到下一行」。 */}
            <div className="tform__grid tform__grid--row">
              <label className="tasks__field">
                <span className="tasks__label">{t('tasks.backend')}</span>
                {/* 全部執行環境都列出;不適用此 App 平台或建置中的停用。 */}
                <RuntimeSelect
                  platform={apps.find((a) => a.id === appId)?.platform}
                  value={runtimeId}
                  onChange={(r) => {
                    setRuntimeId(r.id);
                    setBackend(r.backend);
                    setMaxSegments(r.long ? (maxSegments === '1' ? '2' : maxSegments) : '1');
                  }}
                />
              </label>
              {/* 第 2 步:測試機型態。放在裝置之前,因為它要「過濾」下面那份清單 ——
                  先看到 90 台混在一起再找平板,是反過來的。 */}
              {backend === 'devicefarm' && (
                <label className="tasks__field">
                  <FormFactorSelect value={formFactor} onChange={setFormFactor} labelClass="tasks__label" hintClass="tasks__field-hint" />
                </label>
              )}
              {/* 第 3 步:過濾後的機型。自動派發 = 由系統在符合機型態的機器裡挑第一台可用。 */}
              {backend === 'devicefarm' && (
                <div className="tasks__field">
                  <span className="tasks__label">{t('tasks.device')}</span>
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
                  <span className="tasks__field-hint">
                    {deviceFilterHint(formFactor, filteredDevices.length, locale)}
                  </span>
                </div>
              )}
              {(backend === 'emulator' || backend === 'windows') && (
                <label className="tasks__field">
                  <HoursSelect backend={backend} value={maxHours} onChange={setMaxHours} labelClass="tasks__label" hintClass="tasks__field-hint" />
                </label>
              )}
              {backend === 'windows' && (
                <div className="tasks__field">
                  <DisplaySelect value={display} onChange={setDisplay} labelClass="tasks__label" hintClass="tasks__field-hint" />
                </div>
              )}
              {/* 模擬器:大量測系統穩定度時逐一換 Android 版本;平板版面靠螢幕尺寸。 */}
              {backend === 'emulator' && (
                <>
                  <label className="tasks__field">
                    <AndroidVersionSelect value={androidVersion} onChange={setAndroidVersion} labelClass="tasks__label" hintClass="tasks__field-hint" />
                  </label>
                  <label className="tasks__field">
                    <EmulatorScreenSelect value={emuScreen} onChange={setEmuScreen} labelClass="tasks__label" hintClass="tasks__field-hint" />
                  </label>
                </>
              )}

              {runtimeById(runtimeId)?.long && (
                <label className="tasks__field">
                  <span className="tasks__label">{t('tasks.runDuration')}</span>
                  <select value={maxSegments} onChange={(e) => setMaxSegments(e.target.value)}>
                    <option value="2">{t('tasks.runLong2')}</option>
                    <option value="4">{t('tasks.runLong4')}</option>
                    <option value="0">{t('tasks.runLongUnlimited')}</option>
                  </select>
                  <span className="tasks__field-hint">{t('tasks.runDurationHint')}</span>
                  {maxSegments !== '1' && <span className="tasks__field-hint" role="note">{t('tasks.runLongNote')}</span>}
                </label>
              )}
              {/* 所選環境的適用情境與限制:橫跨整排放在欄位底下,長句子才讀得順,
                  也不會把同一列的欄位撐開。 */}
              <RuntimeDetail value={runtimeId} className="tform__runtime-detail" hintClass="tasks__field-hint" />
            </div>
          </fieldset>
          {devicePickerOpen && (
            <DevicePicker
              devices={filteredDevices}
              value={deviceArn}
              onSelect={(d) => {
                setDeviceArn(d?.arn ?? '');
                setDevicePickerOpen(false);
              }}
              onClose={() => setDevicePickerOpen(false)}
            />
          )}

          {/* ③ AI 模型(每個角色一張卡) */}
          {(VLM_BACKENDS.has(backend) || AGENT_SUBAGENT_BACKENDS.has(backend)) && (
            <fieldset className="tform__sec">
              <legend className="tform__legend"><span className="tform__num">3</span>{ft('secModels')}</legend>
              <p className="tform__intro">
                {t(AGENT_SUBAGENT_BACKENDS.has(backend) ? 'tasks.modelsIntro' : 'tasks.modelsIntroWeb')}
              </p>
              <div className="tform__seats">
                {AGENT_SUBAGENT_BACKENDS.has(backend) && (
                  <label className="tasks__field tform__seat">
                    <span className="tform__seat-head"><span className="tform__seat-icon" aria-hidden="true">🎮</span>{t('tasks.modelAgent')}</span>
                    <span className="tasks__field-hint">{t('detail.roleAgentHint')}</span>
                    <select value={agentModel} onChange={(e) => setAgentModel(e.target.value)}>
                      {agentModels.map((m) => (
                        <option key={m.modelId} value={m.modelId} disabled={!!m.unavailable} title={m.unavailable ?? ''} style={recommendStyle(m)}>
                          {starLabel('agent', m, modelOptionLabel(m))}
                          {m.unavailable ? `(${t('tasks.modelUnavailable')})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {VLM_BACKENDS.has(backend) && (
                  <label className="tasks__field tform__seat">
                    <span className="tform__seat-head"><span className="tform__seat-icon" aria-hidden="true">👁</span>{t('tasks.modelVlm')}</span>
                    <span className="tasks__field-hint">
                      {backend === 'web' ? t('tasks.roleVlmWebHint') : t('detail.roleVlmHint')}
                    </span>
                    <select value={vlmModel} onChange={(e) => setVlmModel(e.target.value)}>
                      {vlmModels.map((m) => (
                        <option key={m.modelId} value={m.modelId} disabled={!!m.unavailable} title={m.unavailable ?? ''} style={recommendStyle(m)}>
                          {starLabel('vlm', m, modelOptionLabel(m))}
                          {m.unavailable ? `(${t('tasks.modelUnavailable')})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {AGENT_SUBAGENT_BACKENDS.has(backend) && (
                  <label className="tasks__field tform__seat">
                    <span className="tform__seat-head"><span className="tform__seat-icon" aria-hidden="true">🧩</span>{t('tasks.modelSubagent')}</span>
                    <span className="tasks__field-hint">{t('detail.roleSubagentHint')}</span>
                    <select value={subagentModel} onChange={(e) => setSubagentModel(e.target.value)}>
                      {subagentModels.map((m) => (
                        <option key={m.modelId} value={m.modelId} disabled={!!m.unavailable} title={m.unavailable ?? ''} style={recommendStyle(m)}>
                          {starLabel('subagent', m, modelOptionLabel(m))}
                          {m.unavailable ? `(${t('tasks.modelUnavailable')})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </fieldset>
          )}

          {/* ④ 知識庫:已選的放最上面(可移除),其餘用搜尋 + 點選加入 */}
          {kbs.length > 0 && (() => {
            const pool = kbs.filter((kb) => !kb.archived || selectedKbIds.includes(kb.id));
            const chosen = pool.filter((kb) => selectedKbIds.includes(kb.id));
            const query = kbQuery.trim().toLowerCase();
            const rest = pool.filter((kb) => !selectedKbIds.includes(kb.id) && (!query || kb.name.toLowerCase().includes(query)));
            const toggle = (id: string, on: boolean) =>
              setSelectedKbIds((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));
            return (
              <fieldset className="tform__sec">
                <legend className="tform__legend">
                  <span className="tform__num">{VLM_BACKENDS.has(backend) || AGENT_SUBAGENT_BACKENDS.has(backend) ? 4 : 3}</span>
                  {t('tasks.knowledgeBases')}
                  <span className="tform__count">{ft('kbChosen').replace('{n}', String(chosen.length))}</span>
                </legend>
                <p className="tform__intro">{t('tasks.knowledgeBasesHint')}</p>
                <div className="tform__chips" aria-label={t('tasks.knowledgeBases')}>
                  {chosen.length === 0 && <span className="tasks__field-hint">{ft('kbNone')}</span>}
                  {chosen.map((kb) => (
                    <button key={kb.id} type="button" className="tform__chip is-on" aria-pressed="true" title={ft('kbRemove')} onClick={() => toggle(kb.id, false)}>
                      <span>{kb.name}</span><span aria-hidden="true">✕</span>
                    </button>
                  ))}
                </div>
                <div className="tform__kb-add">
                  <input
                    type="search"
                    className="tform__kb-search"
                    value={kbQuery}
                    placeholder={ft('kbSearch')}
                    aria-label={ft('kbSearch')}
                    onChange={(e) => setKbQuery(e.target.value)}
                  />
                  <div className="tform__chips tform__chips--pool">
                    {(kbShowAll || query ? rest : rest.slice(0, 12)).map((kb) => (
                      <button key={kb.id} type="button" className="tform__chip" aria-pressed="false" onClick={() => toggle(kb.id, true)}>
                        <span aria-hidden="true">＋</span><span>{kb.name}</span>
                      </button>
                    ))}
                    {!query && rest.length > 12 && (
                      <button type="button" className="tform__more" onClick={() => setKbShowAll((v) => !v)}>
                        {kbShowAll ? ft('kbLess') : ft('kbMore').replace('{n}', String(rest.length - 12))}
                      </button>
                    )}
                  </div>
                </div>
              </fieldset>
            );
          })()}

          {/* ⑤ 進階:上限(預設不限,收合) */}
          <details className="tform__sec tform__adv">
            <summary className="tform__legend">
              <span className="tform__num">⚙</span>{ft('secLimits')}
              <span className="tform__count">
                {(Number(maxSteps) > 0 ? `${t('tasks.maxSteps')} ${maxSteps}` : '') +
                  (Number(budgetUsd) > 0 ? `${Number(maxSteps) > 0 ? ' · ' : ''}US$${budgetUsd}` : '') || ft('noLimit')}
              </span>
            </summary>
            <div className="tform__grid">
              <label className="tasks__field">
                <span className="tasks__label">{t('tasks.maxSteps')}</span>
                <input
                  type="number"
                  min="0"
                  inputMode="numeric"
                  placeholder={t('tasks.unlimited')}
                  value={maxSteps}
                  onChange={(e) => setMaxSteps(e.target.value)}
                />
                <span className="tasks__field-hint">{t('tasks.maxStepsHint')}</span>
              </label>
              <label className="tasks__field">
                <span className="tasks__label">{t('tasks.budgetUsd')}</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder={t('tasks.unlimited')}
                  value={budgetUsd}
                  onChange={(e) => setBudgetUsd(e.target.value)}
                />
                <span className="tasks__field-hint">{t('tasks.budgetUsdHint')}</span>
              </label>
            </div>
          </details>

          {error && (
            <p className="tasks__error" role="alert">
              {error}
            </p>
          )}
          <div className="tasks__actions tform__actions">
            <button
              type="button"
              className="tasks__cancel-btn"
              onClick={() => setShowForm(false)}
            >
              {t('tasks.cancel')}
            </button>
            <button type="submit" className="tasks__go" disabled={submitting || !caseId || (backend === 'windows' && displayError(display, 'en') !== null)}>
              {submitting ? t('tasks.submitting') : t('tasks.submitBtn')}
            </button>
          </div>
        </form>
      )}

      <div className="tasks__filter">
        {/* 自由文字搜尋放在最前面:它是唯一「我已經知道要找哪一筆」的入口,
            其餘篩選器都是從既有值裡挑。 */}
        <label className="tasks__filter-item tasks__filter-item--search">
          <span className="tasks__filter-label">{t('tasks.search')}</span>
          <input
            type="search"
            className="tasks__search-input"
            value={query}
            placeholder={t('tasks.searchPlaceholder')}
            aria-label={t('tasks.searchHint')}
            title={t('tasks.searchHint')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {/* 篩選欄順序對齊表格欄位:狀態 →(建立時間無篩選)→ 應用程式 → 環境 → 位置 →
            步數 → 花費 → 控制遊戲 → 分析畫面 → 子代理。 */}
        <label className="tasks__filter-item">
          <span className="tasks__filter-label">{t('tasks.filterState')}</span>
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="">{t('tasks.filterAll')}</option>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {t(outcomeKey(s))}
              </option>
            ))}
          </select>
        </label>
        {/* 嵌入工作區時清單已鎖定單一應用,這個篩選沒有意義 */}
        {!embedded && (
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
        )}
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
              format={(n) => usd4(n)}
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
              setQuery('');
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
