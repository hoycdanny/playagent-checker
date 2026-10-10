import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiGet, apiPut, apiDelete, ApiError, type ListResponse } from '../api/client.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import type { MessageKey } from '../i18n/messages.ts';
import GenreIcon, { genreLabelKey, type Genre } from '../components/GenreIcon.tsx';
import MemoryPanel from '../components/memory/MemoryPanel.tsx';
import BuildsPanel, { type AppBuild } from '../components/apps/BuildsPanel.tsx';
import { CredentialsPanel } from '../components/credentials/CredentialsPanel.tsx';
// 案例/任務/報告分頁直接用獨立頁面的元件(傳 appId 進入嵌入模式),
// 這樣工作區與主頁面的排版是「同一份」,不會各自長歪。
import CasesPage from './CasesPage.tsx';
import TasksPage from './TasksPage.tsx';
import ReportsPage from './ReportsPage.tsx';
import './ListPage.css';
import './TasksPage.css';
import './MemoryPage.css';
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
  /** 使用中的版本(產物 id)。 */
  artifactId?: string;
  /** 已上傳的版本清單(新到舊)。 */
  builds?: AppBuild[];
  defaultKnowledgeBaseIds?: string[];
}
interface CaseSummary {
  id: string;
  app: string;
  name: string;
  /** 目前使用中的版本號。 */
  version?: string;
}
interface TaskItem {
  jobId: string;
  backend: string;
  locality: string;
  appId: string;
  caseId: string;
  state: string;
  createdAt: string;
  caseName?: string;
  caseVersion?: string;
  finishedAt?: string;
  stepCount?: number;
  billableSpendUsd?: number;
  message?: string;
  deviceModel?: string;
  /** 這次測的是哪一版(多版本 App)。 */
  artifactLabel?: string;
  artifactVersion?: string;
}

const TERMINAL = new Set(['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']);
const PASS_STATES = new Set(['pass']);

type Tab = 'overview' | 'builds' | 'cases' | 'tasks' | 'reports' | 'memory' | 'knowledge' | 'credentials';

const TABS: { key: Tab; labelKey: MessageKey }[] = [
  { key: 'overview', labelKey: 'workspace.tabOverview' },
  { key: 'builds', labelKey: 'workspace.tabBuilds' },
  { key: 'cases', labelKey: 'workspace.tabCases' },
  { key: 'tasks', labelKey: 'workspace.tabTasks' },
  { key: 'reports', labelKey: 'workspace.tabReports' },
  { key: 'memory', labelKey: 'workspace.tabMemory' },
  { key: 'knowledge', labelKey: 'workspace.tabKnowledge' },
  { key: 'credentials', labelKey: 'workspace.tabCredentials' },
];
const TAB_KEYS = new Set<string>(TABS.map((x) => x.key));

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
  const navigate = useNavigate();

  const [app, setApp] = useState<AppRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [memStats, setMemStats] = useState<{ pages: number; edges: number } | null>(null);
  // 知識庫清單(知識分頁的綁定選項)。
  const [kbs, setKbs] = useState<{ id: string; name: string; archived?: boolean }[]>([]);
  // 分頁放在網址(?tab=)—— 重新整理、分享連結、瀏覽器上一頁都會回到同一個分頁。
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab') ?? '';
  const tab: Tab = (TAB_KEYS.has(rawTab) ? rawTab : 'overview') as Tab;
  function setTab(next: Tab) {
    const p = new URLSearchParams(searchParams);
    if (next === 'overview') p.delete('tab'); else p.set('tab', next);
    setSearchParams(p, { replace: true });
  }
  // 知識分頁:這個 App 的預設知識庫(存回 App 記錄的 defaultKnowledgeBaseIds)。
  const [defaultKbIds, setDefaultKbIds] = useState<string[]>([]);
  const [kbSaving, setKbSaving] = useState(false);
  const [kbSaved, setKbSaved] = useState(false);

  function loadApp() {
    apiGet<AppRecord>(`/apps/${encodeURIComponent(appId)}`)
      .then((a) => {
        setApp(a);
        setDefaultKbIds(a.defaultKnowledgeBaseIds ?? []);
      })
      .catch(() => setNotFound(true));
  }
  function loadCases() {
    apiGet<ListResponse<CaseSummary>>(`/cases?app=${encodeURIComponent(appId)}`)
      .then((r) => setCases(r.items))
      .catch(() => {});
  }
  function loadTasks() {
    apiGet<ListResponse<TaskItem>>(`/tasks?app=${encodeURIComponent(appId)}&limit=200`)
      .then((r) => setTasks(r.items))
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
    apiGet<ListResponse<{ id: string; name: string; archived?: boolean }>>('/knowledge-bases')
      .then((r) => setKbs(r.items))
      .catch(() => {});
    // 模型清單、真機池、送出表單等都在嵌入的「測試任務」元件裡自己載入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // 回到總覽時重抓任務:在「測試任務 / 報告」分頁刪除或新增後,總覽的近期任務與統計才會同步。
  useEffect(() => {
    if (appId && tab === 'overview') loadTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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

  /**
   * 刪除整個工作區(應用 + 底下所有資料)。要求輸入名稱確認;
   * 資料多時後端一次做不完(回 done:false),這裡接著再呼叫直到刪完,然後回應用清單。
   */
  async function onDeleteApp() {
    if (!app) return;
    const typed = window.prompt(t('apps.deleteConfirm').replace('{name}', app.name));
    if (typed === null) return;
    if (typed.trim() !== app.name.trim()) {
      window.alert(t('apps.deleteNameMismatch'));
      return;
    }
    setDeleting(true);
    try {
      for (let i = 0; i < 20; i++) {
        const res = await apiDelete<{ done?: boolean }>(`/apps/${encodeURIComponent(appId)}`);
        if (res.done !== false) break;
      }
      navigate('/apps');
    } catch (err) {
      const running = err instanceof ApiError && err.status === 409 ? err.message.match(/\d+/)?.[0] : undefined;
      window.alert(
        running
          ? t('apps.deleteRunning').replace('{n}', running)
          : t('apps.deleteFailed').replace('{msg}', err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setDeleting(false);
    }
  }

  async function onSaveDefaultKbs() {
    setKbSaving(true);
    setKbSaved(false);
    try {
      const next = await apiPut<AppRecord>(`/apps/${encodeURIComponent(appId)}`, {
        defaultKnowledgeBaseIds: defaultKbIds,
      });
      setApp(next);
      // 綁定改了,之後送出任務的預選也跟著改(不動使用者在表單裡的當次選擇)。
      setKbSaved(true);
    } catch {
      /* 忽略;失敗時維持畫面上的勾選 */
    } finally {
      setKbSaving(false);
    }
  }

  if (notFound) {
    return (
      <section className="listpage listpage--wide">
        <Link to="/apps" className="ws__back">← {t('workspace.back')}</Link>
        <div className="listpage__empty">
          <p>{t('workspace.notFound')}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="listpage listpage--wide ws">
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
        {/* 編輯 / 刪除這個應用:從應用管理的卡片移到這裡,卡片只留「進入工作區」。 */}
        <div className="ws__identity-actions">
          <Link to={`/apps?edit=${encodeURIComponent(appId)}`} className="ws__secondary ws__link-btn">
            {t('apps.edit')}
          </Link>
          <button type="button" className="ws__remove" disabled={deleting} onClick={() => void onDeleteApp()}>
            {t('apps.delete')}
          </button>
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
            {/* 記憶地圖規模:看得出 AI 對這個 App 已經認識多少畫面 */}
            <button type="button" className="ws__stat" onClick={() => setTab('memory')}>
              <b>{memStats ? memStats.pages : '—'}</b>
              <span>{t('memory.statPages')}</span>
            </button>
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
          {/* 與獨立「測試案例」頁共用同一個元件,只是鎖定本 App:排版完全一致。 */}
          <CasesPage appId={appId} />
        </div>
      )}

      {/* 測試任務(與獨立頁共用同一個元件,鎖定本 App) */}
      {tab === 'tasks' && (
        <div className="ws__panel">
          <TasksPage appId={appId} />
        </div>
      )}

      {/* 測試報告(與獨立頁共用同一個元件,鎖定本 App) */}
      {tab === 'reports' && (
        <div className="ws__panel">
          <ReportsPage appId={appId} />
        </div>
      )}

      {/* 記憶地圖(與 /memory 同一份實作;樣片本、關係圖、應用記憶、場景範本都在) */}
      {tab === 'memory' && (
        <div className="ws__panel">
          <MemoryPanel appId={appId} onCleared={() => setMemStats({ pages: 0, edges: 0 })} />
        </div>
      )}

      {/* 版本(多個 APK/IPA/EXE;選一版來測) */}
      {tab === 'builds' && (
        <div className="ws__panel">
          <BuildsPanel
            appId={appId}
            platform={app?.platform ?? 'android'}
            builds={app?.builds ?? []}
            activeArtifactId={app?.artifactId}
            tasks={tasks}
            onChanged={(next) => setApp(next as AppRecord)}
          />
        </div>
      )}

      {/* 知識綁定(知識庫是跨租戶共用資源,這裡只設定「這個 App 預設帶哪幾座」) */}
      {tab === 'knowledge' && (
        <div className="ws__panel">
          <p className="ws__muted">{t('workspace.kbBindDesc')}</p>
          {kbs.length === 0 ? (
            <div className="listpage__empty"><p>{t('workspace.kbNone')}</p></div>
          ) : (
            <>
              <ul className="ws__kb-list">
                {kbs.filter((k) => !k.archived).map((k) => (
                  <li key={k.id}>
                    <label className="ws__check">
                      <input
                        type="checkbox"
                        checked={defaultKbIds.includes(k.id)}
                        onChange={(e) => setDefaultKbIds(
                          e.target.checked
                            ? [...defaultKbIds, k.id]
                            : defaultKbIds.filter((x) => x !== k.id),
                        )}
                      />
                      <span>{k.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="ws__kb-actions">
                <button type="button" className="ws__primary" disabled={kbSaving} onClick={onSaveDefaultKbs}>
                  {kbSaving ? t('workspace.credSaving') : t('workspace.kbSave')}
                </button>
                <Link className="ws__secondary ws__link-btn" to="/knowledge">{t('workspace.kbManage')}</Link>
              </div>
              {kbSaved && <p className="ws__muted" role="status">{t('workspace.kbSaved')}</p>}
            </>
          )}
        </div>
      )}

      {/* 測試憑證(本 App;key-value 存 Secrets Manager,值不回顯) */}
      {tab === 'credentials' && <CredentialsPanel appId={appId} />}
    </section>
  );
}
