import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import type { GraphEditOp, Positions } from '../ScreenGraph.tsx';
import type { MemoryRoute } from './RoutesPanel.tsx';
import { distinctAliases } from './graphView.ts';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../../api/client.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { reportLang } from '../report/reportText.ts';
import {
  DeletedPanel,
  HintsPanel,
  PageDrawer,
  mt,
  useMemoryHints,
  type DeletedInfo,
} from './MemoryEditor.tsx';

const ScreenGraph = lazy(() =>
  import('../ScreenGraph.tsx').then((m) => ({ default: m.ScreenGraph })),
);

export interface MemPage {
  id: string;
  name: string;
  visitCount: number;
  screenshotRef: string;
  knownControlLabels?: string[];
  /** AI 對同一畫面用過的各種命名(已合併成同一節點)。 */
  aliases?: Record<string, number>;
  module?: string;
  transient?: boolean;
  /** 使用者在記憶地圖改過名(autoName = AI 原始命名)。 */
  renamed?: boolean;
  autoName?: string;
  /** 第一次在測試中出現的時間(記憶地圖依此由左到右排)。 */
  firstSeenAt?: string;
}
export interface MemEdge {
  fromPageId: string;
  toPageId: string;
  trigger?: { kind?: string; label?: string; target?: string };
  hitCount: number;
  missCount: number;
  /** 使用者在關係圖手動標註的路徑。 */
  manual?: boolean;
}
export interface MemOverview {
  structure: {
    pages: Record<string, MemPage>;
    edges: MemEdge[];
    rootPageId?: string | null;
    lastUpdatedAt: string | null;
  };
  stats: { pages: number; edges: number; controls: number; totalRuns: number };
  edits?: {
    renames?: Record<string, string>;
    deletedPages?: string[];
    deletedEdges?: string[];
    positions?: Positions;
    addedEdges?: MemEdge[];
    merges?: Record<string, string>;
    routes?: MemoryRoute[];
  };
  deleted?: DeletedInfo;
}

interface ScenarioStep { screen: string; action: string | null }
export interface ScenarioTemplate {
  id: string;
  title: string;
  targetScreen: string;
  steps: ScenarioStep[];
  task: string;
  yaml: string;
}

type ViewMode = 'grid' | 'graph';

/**
 * MemoryPanel —— 記憶地圖本體(統計、應用記憶、場景範本、樣片本/關係圖、編修抽屜)。
 *
 * 從 MemoryPage 抽出來,讓「記憶地圖」頁與「應用工作區」的記憶分頁共用同一份實作:
 * 兩邊唯一的差別是 appId 怎麼來(獨立頁用下拉選、工作區由路由鎖定),所以 appId 用 prop 傳入,
 * 這裡不碰 App 清單也不碰網址。
 */
export default function MemoryPanel({
  appId,
  onCleared,
}: {
  appId: string;
  /** 清空記憶後通知外層(例如工作區要更新統計)。 */
  onCleared?: () => void;
}) {
  const { t, locale } = useI18n();
  const lang = reportLang(locale);
  const navigate = useNavigate();
  const hintsApi = useMemoryHints(appId);

  const [overview, setOverview] = useState<MemOverview | null>(null);
  const [shots, setShots] = useState<Record<string, string>>({});
  const [view, setView] = useState<ViewMode>('grid');
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<ScenarioTemplate[]>([]);
  const [openPageId, setOpenPageId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    setOpenPageId(null);
  }, [appId]);

  useEffect(() => {
    if (!appId) return;
    // 由記憶地圖可達路徑生成的場景範本;無地圖則回空。
    apiGet<{ items: ScenarioTemplate[] }>(`/memory/templates?app=${encodeURIComponent(appId)}`)
      .then((r) => setTemplates(r.items ?? []))
      .catch(() => setTemplates([]));
  }, [appId]);

  // quiet = 編修後重抓:不顯示骨架、不重抓已有的截圖(避免畫面閃爍)。
  const loadOverview = useCallback((quiet = false) => {
    if (!appId) return;
    if (!quiet) {
      setLoading(true);
      setShots({});
    }
    apiGet<MemOverview>(`/memory?app=${encodeURIComponent(appId)}`)
      .then(async (o) => {
        setOverview(o);
        if (quiet) return;
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
      .catch(() => { if (!quiet) setOverview(null); })
      .finally(() => { if (!quiet) setLoading(false); });
  }, [appId]);
  const refreshQuiet = useCallback(() => loadOverview(true), [loadOverview]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  function useTemplate(tpl: ScenarioTemplate) {
    if (!appId) return;
    // 帶著範本 YAML 與 app 跳到測試案例頁,開啟「範本感知 AI 編修」流程。
    // 用 base64 編碼避免 hash router 對特殊字元/換行的處理問題。
    const enc = btoa(encodeURIComponent(tpl.yaml));
    navigate(`/cases?tpl=${enc}&app=${encodeURIComponent(appId)}&name=${encodeURIComponent(tpl.title)}`);
  }

  // 清空記憶:把此 App(雲端)累積的記憶地圖清掉,讓 agent 重新學習(避免被舊/錯的記憶「弄笨」)。
  async function onClearMemory() {
    if (!appId) return;
    if (!window.confirm(t('memory.clearConfirm'))) return;
    setClearing(true);
    try {
      await apiPost('/memory/clear', { app: appId, locality: 'cloud' });
      loadOverview();
      setTemplates([]);
      onCleared?.();
    } catch {
      /* 忽略;失敗時保留現況 */
    } finally {
      setClearing(false);
    }
  }

  const pages = useMemo(() => (overview ? Object.values(overview.structure.pages) : []), [overview]);
  // 穩定參考:關係圖以這些陣列重算排版,父層其他狀態變動時不該把拖曳中的圖重置。
  const pagesWithShots = useMemo(
    () => pages.map((p) => ({ ...p, screenshotUrl: shots[p.id] })).sort((a, b) => b.visitCount - a.visitCount),
    [pages, shots],
  );
  const edges = useMemo(() => overview?.structure.edges ?? [], [overview]);
  const onGraphEdit = useCallback(async (op: GraphEditOp) => {
    await apiPost('/memory/edit', { app: appId, ...op });
    loadOverview(true);
  }, [appId, loadOverview]);
  const maxVisits = Math.max(1, ...pages.map((p) => p.visitCount));
  const stats = overview?.stats;
  const pageOptions = [...pages]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ id: p.id, name: p.name }));
  const pageName = (id: string) => overview?.structure.pages[id]?.name ?? id;
  const openPage = openPageId ? pagesWithShots.find((p) => p.id === openPageId) : undefined;
  const hintCount = (p: MemPage) => {
    const names = new Set([p.name, p.autoName, ...Object.keys(p.aliases ?? {})].filter(Boolean));
    return hintsApi.hints.filter(
      (h) => h.enabled && (h.pageId === p.id || (!h.pageId && h.screen && names.has(h.screen))),
    ).length;
  };

  return (
    <div className="memory">
      {stats && (
        <div className="memory__vitals">
          <div className="memory__vital"><b>{stats.pages}</b><span>{t('memory.statPages')}</span></div>
          <div className="memory__vital"><b>{stats.edges}</b><span>{t('memory.statEdges')}</span></div>
          <div className="memory__vital"><b>{stats.controls}</b><span>{t('memory.statControls')}</span></div>
          <div className="memory__vital"><b>{stats.totalRuns}</b><span>{t('memory.statRuns')}</span></div>
          {pages.length > 0 && (
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
      )}

      {/* 應用記憶:使用者教 AI 的經驗(即時指令勾「記住」或手動新增),每次測試注入 prompt */}
      {appId && <HintsPanel lang={lang} api={hintsApi} pages={pageOptions} />}

      {/* 場景範本:由記憶地圖可達路徑生成,供一鍵建立測試案例 */}
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
                <button type="button" className="memory__tpl-btn" onClick={() => useTemplate(tpl)}>
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
          <div className="memory__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={view === 'grid'}
              className={`memory__tab ${view === 'grid' ? 'memory__tab--active' : ''}`}
              onClick={() => setView('grid')}>{t('memory.tabGrid')}</button>
            <button type="button" role="tab" aria-selected={view === 'graph'}
              className={`memory__tab ${view === 'graph' ? 'memory__tab--active' : ''}`}
              onClick={() => setView('graph')}>{t('memory.tabGraph')}</button>
          </div>

          {view === 'grid' ? (
            <>
              <p className="memory__hint">{mt('gridHint', lang)}</p>
              <div className="memory__grid">
                {pagesWithShots.map((p) => {
                  const nHints = hintCount(p);
                  const aliasNames = distinctAliases(p);
                  return (
                    <figure key={p.id} className="memory__card">
                      <button
                        type="button"
                        className="memory__card-btn"
                        onClick={() => setOpenPageId(p.id)}
                        aria-haspopup="dialog"
                        aria-label={`${mt('edit', lang)}: ${p.name}`}
                      >
                        <div
                          className="memory__card-heat"
                          style={{ width: `${Math.max(8, (p.visitCount / maxVisits) * 100)}%` }}
                        />
                        <div className="memory__card-thumb">
                          {p.screenshotUrl
                            ? <img src={p.screenshotUrl} alt="" loading="lazy" />
                            : <div className="memory__card-noimg" />}
                        </div>
                        <figcaption>
                          <span className="memory__card-name">{p.name}</span>
                          <span className="memory__card-meta">{p.visitCount} {t('memory.visits')}</span>
                          {aliasNames.length > 0 && (
                            <span className="memory__card-meta" title={Object.keys(p.aliases ?? {}).join('、')}>
                              {t('memory.graphAliases')}: {aliasNames.slice(0, 3).join('、')}
                            </span>
                          )}
                          {nHints > 0 && <span className="memory__card-tag">💡 {nHints} · {mt('pageNotes', lang)}</span>}
                        </figcaption>
                      </button>
                    </figure>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <p className="memory__hint">{t('memory.graphHint')}</p>
              <Suspense fallback={<div className="listpage__skeleton" aria-hidden="true"><div className="listpage__skeleton-row" /></div>}>
                <ScreenGraph
                  pages={pagesWithShots}
                  edges={edges}
                  rootPageId={overview?.structure.rootPageId ?? null}
                  {...(overview?.edits?.positions ? { positions: overview.edits.positions } : {})}
                  {...(appId ? { onEdit: onGraphEdit, onOpenPage: setOpenPageId } : {})}
                  {...(overview?.edits?.routes ? { routes: overview.edits.routes } : {})}
                />
              </Suspense>
            </>
          )}
        </>
      )}

      {/* 已刪除的畫面/路徑(可還原) */}
      {appId && overview?.deleted && (
        <DeletedPanel lang={lang} appId={appId} deleted={overview.deleted} onEdited={refreshQuiet} />
      )}

      {/* 單一畫面編修抽屜 */}
      {appId && openPage && (
        <PageDrawer
          lang={lang}
          appId={appId}
          page={openPage}
          edges={edges}
          pageName={pageName}
          api={hintsApi}
          onClose={() => setOpenPageId(null)}
          onEdited={refreshQuiet}
        />
      )}
    </div>
  );
}
