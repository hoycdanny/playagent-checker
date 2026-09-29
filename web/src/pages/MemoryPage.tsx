import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost, type ListResponse } from '../api/client.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import GenreIcon, { genreLabelKey, type Genre } from '../components/GenreIcon.tsx';
import './ListPage.css';
import './MemoryPage.css';

const ScreenGraph = lazy(() =>
  import('../components/ScreenGraph.tsx').then((m) => ({ default: m.ScreenGraph })),
);

interface AppRecord { id: string; name: string; genre?: Genre; platform?: string }
interface MemPage {
  id: string;
  name: string;
  visitCount: number;
  screenshotRef: string;
  knownControlLabels?: string[];
}
interface MemEdge {
  fromPageId: string;
  toPageId: string;
  trigger?: { label?: string };
  hitCount: number;
  missCount: number;
}
interface MemOverview {
  structure: { pages: Record<string, MemPage>; edges: MemEdge[]; lastUpdatedAt: string | null };
  stats: { pages: number; edges: number; controls: number; totalRuns: number };
}

interface ScenarioStep { screen: string; action: string | null }
interface ScenarioTemplate {
  id: string;
  title: string;
  targetScreen: string;
  steps: ScenarioStep[];
  task: string;
  yaml: string;
}

type ViewMode = 'grid' | 'graph';

export default function MemoryPage() {
  const { t } = useI18n();
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [appId, setAppId] = useState('');
  const [overview, setOverview] = useState<MemOverview | null>(null);
  const [shots, setShots] = useState<Record<string, string>>({});
  const [view, setView] = useState<ViewMode>('grid');
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<ScenarioTemplate[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    apiGet<ListResponse<AppRecord>>('/apps')
      .then((r) => {
        setApps(r.items);
        if (r.items[0]) setAppId(r.items[0].id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!appId) return;
    // 抓由記憶地圖生成的場景範本(步驟 4)。無地圖則回空。
    apiGet<{ items: ScenarioTemplate[] }>(`/memory/templates?app=${encodeURIComponent(appId)}`)
      .then((r) => setTemplates(r.items ?? []))
      .catch(() => setTemplates([]));
  }, [appId]);

  function useTemplate(tpl: ScenarioTemplate) {
    if (!appId) return;
    // 帶著範本 YAML 與 app 跳到測試案例頁,開啟「範本感知 AI 編修」流程(步驟 5)。
    // 用 base64 編碼避免 hash router 對特殊字元/換行的處理問題。
    const enc = btoa(encodeURIComponent(tpl.yaml));
    navigate(`/cases?tpl=${enc}&app=${encodeURIComponent(appId)}&name=${encodeURIComponent(tpl.title)}`);
  }

  const [clearing, setClearing] = useState(false);

  const loadOverview = useCallback(() => {
    if (!appId) return;
    setLoading(true);
    setShots({});
    apiGet<MemOverview>(`/memory?app=${encodeURIComponent(appId)}`)
      .then(async (o) => {
        setOverview(o);
        // 為每個 page 取截圖 presigned URL(並行,少量)。
        const pages = Object.values(o.structure.pages);
        const entries = await Promise.all(
          pages.map(async (p) => {
            try {
              const { url } = await apiGet<{ url: string }>(
                `/memory/screenshot?app=${encodeURIComponent(appId)}&page=${encodeURIComponent(p.id)}`,
              );
              return [p.id, url] as const;
            } catch {
              return [p.id, ''] as const;
            }
          }),
        );
        setShots(Object.fromEntries(entries.filter(([, u]) => u)));
      })
      .catch(() => setOverview(null))
      .finally(() => setLoading(false));
  }, [appId]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  // 清空記憶:把此 App(雲端)累積的記憶地圖清掉,讓 agent 重新學習(避免被舊/錯的記憶「弄笨」)。
  async function onClearMemory() {
    if (!appId) return;
    if (!window.confirm(t('memory.clearConfirm'))) return;
    setClearing(true);
    try {
      await apiPost('/memory/clear', { app: appId, locality: 'cloud' });
      loadOverview();
      setTemplates([]);
    } catch {
      /* 忽略;失敗時保留現況 */
    } finally {
      setClearing(false);
    }
  }

  const selectedApp = apps.find((a) => a.id === appId);
  const pages = overview ? Object.values(overview.structure.pages) : [];
  const pagesWithShots = pages
    .map((p) => ({ ...p, screenshotUrl: shots[p.id] }))
    .sort((a, b) => b.visitCount - a.visitCount);
  const edges = overview?.structure.edges ?? [];
  const maxVisits = Math.max(1, ...pages.map((p) => p.visitCount));
  const stats = overview?.stats;

  return (
    <section className="listpage listpage--wide memory">
      <header className="listpage__header">
        <h1 className="listpage__title">{t('page.memory.title')}</h1>
        <div className="memory__app-picker">
          {selectedApp?.genre && (
            <span className="memory__app-genre" aria-label={t(genreLabelKey(selectedApp.genre))}>
              <GenreIcon genre={selectedApp.genre} size={18} />
            </span>
          )}
          <label className="memory__app">
            <span className="visually-hidden">{t('memory.selectApp')}</span>
            <select value={appId} onChange={(e) => setAppId(e.target.value)}>
              {apps.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          {appId && pages.length > 0 && (
            <button
              type="button"
              className="memory__clear-btn"
              onClick={onClearMemory}
              disabled={clearing}
              title={t('memory.clearHint')}
            >
              {clearing ? t('memory.clearing') : t('memory.clear')}
            </button>
          )}
        </div>
      </header>

      {/* 統計列 */}
      {stats && (
        <div className="memory__vitals">
          <div className="memory__vital"><b>{stats.pages}</b><span>{t('memory.statPages')}</span></div>
          <div className="memory__vital"><b>{stats.edges}</b><span>{t('memory.statEdges')}</span></div>
          <div className="memory__vital"><b>{stats.controls}</b><span>{t('memory.statControls')}</span></div>
          <div className="memory__vital"><b>{stats.totalRuns}</b><span>{t('memory.statRuns')}</span></div>
        </div>
      )}

      {/* 場景範本:由記憶地圖可達路徑生成,供一鍵建立測試案例(步驟 4) */}
      {templates.length > 0 && (
        <section className="memory__templates">
          <div className="memory__templates-head">
            <h2 className="memory__templates-title">{t('memory.templatesTitle')}</h2>
            <span className="memory__templates-hint">{t('memory.templatesHint')}</span>
          </div>
          <ul className="memory__tpl-list">
            {templates.map((tpl) => (
              <li key={tpl.id} className="memory__tpl-card">
                <div className="memory__tpl-body">
                  <span className="memory__tpl-title">{tpl.title}</span>
                  <span className="memory__tpl-path">
                    {tpl.steps.map((s) => s.screen).join(' → ')}
                  </span>
                </div>
                <button
                  type="button"
                  className="memory__tpl-btn"
                  onClick={() => useTemplate(tpl)}
                >
                  {t('memory.tplUse')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {loading ? (
        <div className="listpage__skeleton" aria-hidden="true"><div className="listpage__skeleton-row" /></div>
      ) : pages.length === 0 ? (
        <div className="listpage__empty"><p>{t('page.memory.empty')}</p></div>
      ) : (
        <>
          {/* 樣片本 / 關係圖 切換 */}
          <div className="memory__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={view === 'grid'}
              className={`memory__tab ${view === 'grid' ? 'memory__tab--active' : ''}`}
              onClick={() => setView('grid')}>{t('memory.tabGrid')}</button>
            <button type="button" role="tab" aria-selected={view === 'graph'}
              className={`memory__tab ${view === 'graph' ? 'memory__tab--active' : ''}`}
              onClick={() => setView('graph')}>{t('memory.tabGraph')}</button>
          </div>

          {view === 'grid' ? (
            <div className="memory__grid">
              {pagesWithShots.map((p) => (
                <figure key={p.id} className="memory__card">
                  <div className="memory__card-heat" style={{ width: `${Math.max(8, (p.visitCount / maxVisits) * 100)}%` }} />
                  <div className="memory__card-thumb">
                    {p.screenshotUrl ? <img src={p.screenshotUrl} alt={p.name} loading="lazy" /> : <div className="memory__card-noimg" />}
                  </div>
                  <figcaption>
                    <span className="memory__card-name">{p.name}</span>
                    <span className="memory__card-meta">{p.visitCount} {t('memory.visits')}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <>
              <p className="memory__hint">{t('memory.graphHint')}</p>
              <Suspense fallback={<div className="listpage__skeleton" aria-hidden="true"><div className="listpage__skeleton-row" /></div>}>
                <ScreenGraph pages={pagesWithShots} edges={edges} />
              </Suspense>
            </>
          )}
        </>
      )}
    </section>
  );
}
