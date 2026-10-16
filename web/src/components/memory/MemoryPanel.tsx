import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphEditOp, Positions } from '../ScreenGraph.tsx';
import type { MemoryRoute } from './RoutesPanel.tsx';
import { distinctAliases } from './graphView.ts';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../../api/client.ts';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { reportLang, type RLang } from '../report/reportText.ts';
import {
  DeletedPanel,
  HintsPanel,
  mt,
  useMemoryHints,
  type DeletedInfo,
} from './MemoryEditor.tsx';
import { ScreenStudio } from './ScreenStudio.tsx';
import type { MemOp, OpEdit, SelfOp } from './memoryScript.ts';
import './ScreenStudio.css';

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
  /** 畫面指紋(匯出 Appium 腳本時用來確認在對的畫面)。 */
  pHash?: string;
  pHashes?: string[];
  /** 同一畫面上的操作(例如 SPIN)。 */
  selfOps?: SelfOp[];
}
export interface MemEdge {
  fromPageId: string;
  toPageId: string;
  trigger?: { kind?: string; label?: string; target?: string };
  hitCount: number;
  missCount: number;
  /** 使用者在關係圖手動標註的路徑。 */
  manual?: boolean;
  /** 最近一次造成這個轉場的操作(記憶腳本,座標 0~1)。 */
  op?: MemOp;
}
export interface MemOverview {
  structure: {
    pages: Record<string, MemPage>;
    edges: MemEdge[];
    rootPageId?: string | null;
    appName?: string;
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
    /** 使用者對記憶操作的修正 / 確認 / 停用。 */
    opEdits?: Record<string, OpEdit>;
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

const L = {
  mapTitle: ['畫面關係圖', 'Screen map'],
  pickHint: ['👆 點上面任一個畫面,這裡會打開它的腳本、操作位置與說明。', '👆 Click any screen above to open its script, action positions and details here.'],
  more: ['其他記憶設定(應用記憶、場景範本、已刪除)', 'More memory settings (app memory, scenario templates, deleted)'],
} as const;
const lt = (k: keyof typeof L, lang: RLang) => L[k][lang === 'zh' ? 0 : 1];

/**
 * MemoryPanel —— 記憶地圖本體。
 *
 * 版面(由上到下):
 *   1. 畫面關係圖(或畫面清單)+ 統計
 *   2. 點了某個畫面 → 下方展開「畫面工作區」(ScreenStudio):大張截圖 + 腳本 / 操作編修 / Appium 程式碼 / 說明
 *   3. 其他記憶設定(應用記憶、場景範本、已刪除)收在最下面
 *
 * 「記憶地圖」頁與「應用工作區」的記憶分頁共用同一份實作,appId 由外層傳入。
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
  const [view, setView] = useState<ViewMode>('graph');
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<ScenarioTemplate[]>([]);
  const [openPageId, setOpenPageId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const mapRef = useRef<HTMLElement>(null);
  const studioRef = useRef<HTMLDivElement>(null);

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
      setOpenPageId(null);
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
  const pageMap = useMemo(() => overview?.structure.pages ?? {}, [overview]);
  const opEdits = useMemo(() => overview?.edits?.opEdits ?? {}, [overview]);
  const onGraphEdit = useCallback(async (op: GraphEditOp) => {
    await apiPost('/memory/edit', { app: appId, ...op });
    loadOverview(true);
  }, [appId, loadOverview]);
  const maxVisits = Math.max(1, ...pages.map((p) => p.visitCount));
  const stats = overview?.stats;
  const pageOptions = [...pages]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ id: p.id, name: p.name }));
  const hintCount = (p: MemPage) => {
    const names = new Set([p.name, p.autoName, ...Object.keys(p.aliases ?? {})].filter(Boolean));
    return hintsApi.hints.filter(
      (h) => h.enabled && (h.pageId === p.id || (!h.pageId && h.screen && names.has(h.screen))),
    ).length;
  };

  // 點畫面 → 打開下方工作區並捲過去;被刪掉的畫面自動關閉。
  const openPage = useCallback((id: string) => {
    setOpenPageId(id);
    requestAnimationFrame(() => studioRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, []);
  const openExists = openPageId ? Boolean(pageMap[openPageId]) : false;
  useEffect(() => {
    if (openPageId && overview && !openExists) setOpenPageId(null);
  }, [openPageId, overview, openExists]);

  return (
    <div className="memory memory--v2">
      {loading ? (
        <div className="listpage__skeleton" aria-hidden="true"><div className="listpage__skeleton-row" /></div>
      ) : pages.length === 0 ? (
        <div className="listpage__empty"><p>{t('page.memory.empty')}</p></div>
      ) : (
        <>
          {/* 1. 關係圖(最上面) */}
          <section ref={mapRef} className="memmap" aria-labelledby="memmap-title">
            <div className="memmap__head">
              <h2 id="memmap-title" className="memmap__title">{lt('mapTitle', lang)}</h2>
              {stats && (
                <span className="memmap__stats">
                  <span><b>{stats.pages}</b> {t('memory.statPages')}</span>
                  <span><b>{stats.edges}</b> {t('memory.statEdges')}</span>
                  <span><b>{stats.controls}</b> {t('memory.statControls')}</span>
                  <span><b>{stats.totalRuns}</b> {t('memory.statRuns')}</span>
                </span>
              )}
              <span className="memmap__spacer" />
              <div className="memory__tabs" role="tablist">
                <button type="button" role="tab" aria-selected={view === 'graph'}
                  className={`memory__tab ${view === 'graph' ? 'memory__tab--active' : ''}`}
                  onClick={() => setView('graph')}>{t('memory.tabGraph')}</button>
                <button type="button" role="tab" aria-selected={view === 'grid'}
                  className={`memory__tab ${view === 'grid' ? 'memory__tab--active' : ''}`}
                  onClick={() => setView('grid')}>{t('memory.tabGrid')}</button>
              </div>
              <button
                type="button"
                className="memory__clear-btn"
                onClick={onClearMemory}
                disabled={clearing}
                title={t('memory.clearHint')}
              >
                {clearing ? t('memory.clearing') : t('memory.clear')}
              </button>
            </div>

            {view === 'graph' ? (
              <Suspense fallback={<div className="listpage__skeleton" aria-hidden="true"><div className="listpage__skeleton-row" /></div>}>
                <ScreenGraph
                  pages={pagesWithShots}
                  edges={edges}
                  rootPageId={overview?.structure.rootPageId ?? null}
                  {...(overview?.edits?.positions ? { positions: overview.edits.positions } : {})}
                  {...(appId ? { onEdit: onGraphEdit, onOpenPage: openPage } : {})}
                  {...(overview?.edits?.routes ? { routes: overview.edits.routes } : {})}
                  {...(openPageId ? { focusedPageId: openPageId } : {})}
                />
              </Suspense>
            ) : (
              <div className="memory__grid">
                {pagesWithShots.map((p) => {
                  const nHints = hintCount(p);
                  const aliasNames = distinctAliases(p);
                  return (
                    <figure key={p.id} className={`memory__card${openPageId === p.id ? ' is-selected' : ''}`}>
                      <button
                        type="button"
                        className="memory__card-btn"
                        onClick={() => openPage(p.id)}
                        aria-pressed={openPageId === p.id}
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
            )}
          </section>

          {/* 2. 選到的畫面:腳本 / 操作 / Appium 程式碼 / 說明 */}
          <div ref={studioRef} className="memmap__studio-anchor">
            {appId && openPageId && openExists ? (
              <ScreenStudio
                key={openPageId}
                lang={lang}
                appId={appId}
                {...(overview?.structure.appName ? { appName: overview.structure.appName } : {})}
                pageId={openPageId}
                pages={pageMap}
                edges={edges}
                rootPageId={overview?.structure.rootPageId ?? null}
                opEdits={opEdits}
                shots={shots}
                hintsApi={hintsApi}
                onEdited={refreshQuiet}
                onOpenPage={openPage}
                onClose={() => setOpenPageId(null)}
                onBackToMap={() => mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              />
            ) : (
              <p className="memmap__pick">{lt('pickHint', lang)}</p>
            )}
          </div>
        </>
      )}

      {/* 3. 其他記憶設定 */}
      {appId && (
        <details className="memmap__more" open={pages.length === 0}>
          <summary>{lt('more', lang)}</summary>
          <HintsPanel lang={lang} api={hintsApi} pages={pageOptions} />
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
          {overview?.deleted && (
            <DeletedPanel lang={lang} appId={appId} deleted={overview.deleted} onEdited={refreshQuiet} />
          )}
        </details>
      )}
    </div>
  );
}
