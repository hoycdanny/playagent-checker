import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  type Connection,
  type OnBeforeDelete,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import '@xyflow/react/dist/style.css';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { reportLang, type RLang } from './report/reportText.ts';
import { deleteEdgeOp, mt } from './memory/MemoryEditor.tsx';
import { RoutesPanel, addBranch, addStep, rt, type MemoryRoute, type RoutePick } from './memory/RoutesPanel.tsx';
import './ScreenGraph.css';

const ACCENT = '#ff2d95';
const WARN = '#d29922';
const AUTO = '#8a919e';
const MANUAL = '#3fb6ff';
const ROUTE = '#a371f7';
const BRANCH = '#f0883e';
const NO_ROUTES: MemoryRoute[] = [];
const NODE_W = 160;
const THUMB_H = 110;
const NODE_H = THUMB_H + 60;
const TRANSIENT_W = 120;
const TRANSIENT_H = 44;

interface MemPage {
  id: string;
  name: string;
  visitCount: number;
  screenshotUrl?: string;
  aliases?: Record<string, number>;
  module?: string;
  transient?: boolean;
}
interface MemEdge {
  fromPageId: string;
  toPageId: string;
  trigger?: { kind?: string; label?: string; target?: string };
  hitCount: number;
  missCount: number;
  manual?: boolean;
  /** 隱藏載入節點時接起來的虛擬邊(不能刪)。 */
  synthetic?: boolean;
}

/** 記憶關係圖的編修指令(送 POST /memory/edit)。 */
export type GraphEditOp = Record<string, unknown> & { op: string };
export type Positions = Record<string, { x: number; y: number }>;

interface ScreenNodeData extends Record<string, unknown> {
  name: string;
  visitCount: number;
  heat: number;
  screenshotUrl?: string;
  aliases: string[];
  module?: string;
  isRoot: boolean;
  transient: boolean;
  visitsLabel: string;
  aliasesLabel: string;
  rootLabel: string;
  dropTarget?: boolean;
  dropLabel?: string;
  /** 顯示中的路線經過這個畫面的步驟編號(支線畫面為「支」)。 */
  routeBadges?: string[];
  picking?: boolean;
}

/** 節點上的路線步驟徽章。 */
function RouteBadges({ list }: { list?: string[] | undefined }) {
  if (!list?.length) return null;
  return (
    <span className="sg-route-badges" aria-hidden="true">
      {list.slice(0, 4).map((b, i) => <span key={i} className={`sg-route-badge${/^\d+$/.test(b) ? '' : ' sg-route-badge--branch'}`}>{b}</span>)}
    </span>
  );
}
interface FlowEdgeData extends Record<string, unknown> {
  list: MemEdge[];
}

/** 節點:截圖縮圖 + 熱度 + 名稱 + 別名數 + 到訪次數;載入/過場節點縮成小膠囊。 */
function ScreenFlowNode({ data }: NodeProps) {
  const d = data as ScreenNodeData;
  const drop = (d.dropTarget ? ' sg-node--drop' : '') + (d.picking ? ' sg-node--picking' : '') + (d.routeBadges?.length ? ' sg-node--onroute' : '');
  if (d.transient) {
    return (
      <div className={`sg-node sg-node--transient${drop}`} title={d.aliases.join('、')}>
        <RouteBadges list={d.routeBadges} />
        <Handle type="target" position={Position.Left} />
        <span>{d.name}</span>
        <small>{d.visitCount}</small>
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }
  const title = [d.name, ...(d.aliases.length ? [`${d.aliasesLabel}: ${d.aliases.join('、')}`] : []), d.module ? `module: ${d.module}` : '']
    .filter(Boolean)
    .join('\n');
  return (
    <div className={`sg-node ${d.isRoot ? 'sg-node--root' : ''}${drop}`} title={title}>
      <Handle type="target" position={Position.Left} />
      <div className="sg-node__heat" style={{ width: `${Math.max(8, d.heat * 100)}%` }} />
      <div className="sg-node__thumb">
        {d.screenshotUrl ? <img src={d.screenshotUrl} alt={d.name} loading="lazy" draggable={false} /> : <div className="sg-node__noimg" />}
        {d.isRoot && <span className="sg-node__root">{d.rootLabel}</span>}
        <RouteBadges list={d.routeBadges} />
        {d.dropTarget && <span className="sg-node__droplabel">{d.dropLabel}</span>}
      </div>
      <div className="sg-node__name">{d.name}</div>
      <div className="sg-node__meta">
        <span>{d.visitsLabel.replace('{n}', String(d.visitCount))}</span>
        {d.aliases.length > 0 && <span className="sg-node__alias">+{d.aliases.length} {d.aliasesLabel}</span>}
        {d.module && <span className="sg-node__module">{d.module}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { screen: ScreenFlowNode };

interface LayoutLabels { visits: string; aliases: string; root: string; auto: string; manual: string }

/**
 * dagre 分層佈局(LR);有手動位置的節點用手動位置。
 * 同一對節點間的多條邊合併成一條(標籤列出各觸發;刪除時刪掉底下全部)。
 */
function layout(
  pages: MemPage[],
  mapEdges: MemEdge[],
  rootId: string | null,
  labels: LayoutLabels,
  positions: Positions,
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(pages.map((p) => p.id));
  const maxVisits = Math.max(1, ...pages.map((p) => p.visitCount));
  for (const p of pages) g.setNode(p.id, p.transient ? { width: TRANSIENT_W, height: TRANSIENT_H } : { width: NODE_W, height: NODE_H });

  // 合併同方向平行邊。
  const grouped = new Map<string, MemEdge[]>();
  for (const e of mapEdges) {
    if (e.fromPageId === e.toPageId || !ids.has(e.fromPageId) || !ids.has(e.toPageId)) continue;
    const k = `${e.fromPageId}>${e.toPageId}`;
    grouped.set(k, [...(grouped.get(k) ?? []), e]);
  }
  // 依可靠度(hit 多者)權重排位,讓主要流程成為主幹。
  for (const list of grouped.values()) {
    const e = list[0]!;
    g.setEdge(e.fromPageId, e.toPageId, { weight: list.reduce((a, x) => a + x.hitCount, 0) + (list.some((x) => x.manual) ? 1 : 0) });
  }
  dagre.layout(g);

  const nodes: Node[] = pages.map((p) => {
    const pos = g.node(p.id);
    const w = p.transient ? TRANSIENT_W : NODE_W;
    const h = p.transient ? TRANSIENT_H : NODE_H;
    const aliases = Object.keys(p.aliases ?? {}).filter((n) => n !== p.name);
    const saved = positions[p.id];
    return {
      id: p.id,
      type: 'screen',
      position: saved ? { x: saved.x, y: saved.y } : { x: Math.round((pos?.x ?? 0) - w / 2), y: Math.round((pos?.y ?? 0) - h / 2) },
      data: {
        name: p.name,
        visitCount: p.visitCount,
        heat: p.visitCount / maxVisits,
        screenshotUrl: p.screenshotUrl,
        aliases,
        module: p.module,
        isRoot: p.id === rootId,
        transient: Boolean(p.transient),
        visitsLabel: labels.visits,
        aliasesLabel: labels.aliases,
        rootLabel: labels.root,
      } satisfies ScreenNodeData,
    };
  });

  const maxHit = Math.max(1, ...mapEdges.map((e) => e.hitCount));
  const edges: Edge[] = [...grouped.entries()].map(([k, list]) => {
    const hit = list.reduce((a, x) => a + x.hitCount, 0);
    const miss = list.reduce((a, x) => a + x.missCount, 0);
    const manual = list.some((x) => x.manual);
    const allAuto = list.every((x) => (x.trigger?.kind ?? x.trigger?.label) === 'auto');
    const unreliable = !manual && miss > hit;
    const color = manual ? MANUAL : unreliable ? WARN : allAuto ? AUTO : ACCENT;
    const label = list
      .map((x) => (x.trigger?.kind === 'auto' || x.trigger?.label === 'auto' ? labels.auto : x.trigger?.label || x.trigger?.kind || ''))
      .filter(Boolean)
      .slice(0, 3)
      .join(' / ');
    const counts = hit || miss ? ` ×${hit}${miss ? ` (✗${miss})` : ''}` : '';
    return {
      id: `e:${k}`,
      source: list[0]!.fromPageId,
      target: list[0]!.toPageId,
      label: `${manual ? `${labels.manual} · ` : ''}${label}${counts}`,
      data: { list } satisfies FlowEdgeData,
      deletable: !list.every((x) => x.synthetic),
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: manual ? 2.5 : 1 + (hit / maxHit) * 3, ...(allAuto && !manual ? { strokeDasharray: '5 4' } : {}) },
      labelStyle: { fill: manual ? MANUAL : 'var(--text-secondary)', fontSize: 11, fontWeight: manual ? 600 : 400 },
      labelBgStyle: { fill: 'var(--surface)' },
    };
  });

  return { nodes, edges };
}

/** 把顯示中的路線疊到圖上:節點加步驟編號、步驟之間畫紫色編號線、支線畫橘色岔路。 */
function overlayRoute(
  base: { nodes: Node[]; edges: Edge[] },
  route: MemoryRoute | null,
  picking: boolean,
  branchLabel: string,
): { nodes: Node[]; edges: Edge[] } {
  if (!route && !picking) return base;
  const ids = new Set(base.nodes.map((n) => n.id));
  const badges = new Map<string, string[]>();
  const push = (id: string, b: string) => badges.set(id, [...(badges.get(id) ?? []), b]);
  const extra: Edge[] = [];
  const mk = (id: string, source: string, target: string, label: string, color: string, dashed: boolean): Edge => ({
    id, source, target, label,
    selectable: false, deletable: false, focusable: false, animated: true, zIndex: 1000,
    markerEnd: { type: MarkerType.ArrowClosed, color },
    style: { stroke: color, strokeWidth: 3, ...(dashed ? { strokeDasharray: '6 4' } : {}) },
    labelStyle: { fill: color, fontSize: 12, fontWeight: 700 },
    labelBgStyle: { fill: 'var(--surface)' },
  });
  if (route) {
    route.steps.forEach((s, i) => {
      push(s.pageId, String(i + 1));
      const next = route.steps[i + 1];
      if (next && next.pageId !== s.pageId && ids.has(s.pageId) && ids.has(next.pageId)) {
        extra.push(mk(`route:${s.id}`, s.pageId, next.pageId, `${i + 1} → ${i + 2}`, ROUTE, false));
      }
    });
    const no = new Map(route.steps.map((s, i) => [s.id, i + 1]));
    for (const b of route.branches) {
      const from = route.steps.find((s) => s.id === b.fromStepId);
      const back = route.steps.find((s) => s.id === b.returnStepId) ?? from;
      if (!from || !back) continue;
      push(b.pageId, branchLabel);
      if (ids.has(from.pageId) && ids.has(b.pageId) && from.pageId !== b.pageId) {
        extra.push(mk(`branch:${b.id}:in`, from.pageId, b.pageId, `${branchLabel} @${no.get(from.id)}`, BRANCH, true));
      }
      if (ids.has(back.pageId) && ids.has(b.pageId) && back.pageId !== b.pageId) {
        extra.push(mk(`branch:${b.id}:out`, b.pageId, back.pageId, `↩ ${no.get(back.id)}`, BRANCH, true));
      }
    }
  }
  return {
    nodes: base.nodes.map((n) => {
      const list = badges.get(n.id);
      if (!list && !picking) return n;
      return { ...n, data: { ...n.data, ...(list ? { routeBadges: list } : {}), picking } };
    }),
    // 路線線條疊在最上層;原本的路徑淡化,路線一眼看得出來。
    // 原本的標籤會和路線標籤疊在一起,顯示路線時先隱藏。
    edges: [...base.edges.map((e) => (route ? { ...e, label: undefined, style: { ...e.style, opacity: 0.3 } } : e)), ...extra],
  };
}

export interface ScreenGraphProps {
  pages: MemPage[];
  edges: MemEdge[];
  rootPageId?: string | null;
  /** 已儲存的手動位置(edits.json positions)。 */
  positions?: Positions;
  /** 提供時圖面可編輯:送出編修指令後由外層重新載入。 */
  onEdit?: (op: GraphEditOp) => Promise<void>;
  /** 點畫面 → 開編修抽屜。 */
  onOpenPage?: (pageId: string) => void;
  /** 已存的操作路線(edits.json routes)。 */
  routes?: MemoryRoute[];
}

export function ScreenGraph(props: ScreenGraphProps) {
  if (props.pages.length === 0) return null;
  return (
    <ReactFlowProvider>
      <ScreenGraphInner {...props} />
    </ReactFlowProvider>
  );
}

const NO_POSITIONS: Positions = {};

function ScreenGraphInner({ pages, edges, rootPageId = null, positions = NO_POSITIONS, onEdit, onOpenPage, routes = NO_ROUTES }: ScreenGraphProps) {
  const { t, locale } = useI18n();
  const lang: RLang = reportLang(locale);
  const editable = Boolean(onEdit);
  const [hideTransient, setHideTransient] = useState(false);
  const [hideUnreliable, setHideUnreliable] = useState(false);
  const [minHits, setMinHits] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connect, setConnect] = useState<{ from: string; to: string } | null>(null);
  const { getNodes } = useReactFlow();

  const { visiblePages, visibleEdges } = useMemo(() => {
    // 人工標註的路徑一律顯示(不受最少次數 / 不可靠篩選影響)。
    let es = edges.filter((e) => e.manual || e.hitCount >= minHits);
    if (hideUnreliable) es = es.filter((e) => e.manual || e.missCount <= e.hitCount);
    let ps = pages;
    if (hideTransient) {
      // 隱藏載入節點時,把「A → 載入中 → B」接成「A → B」,流程不斷線。
      const tr = new Set(pages.filter((p) => p.transient).map((p) => p.id));
      const bridged: MemEdge[] = [];
      for (const inE of es.filter((e) => tr.has(e.toPageId) && !tr.has(e.fromPageId))) {
        for (const outE of es.filter((e) => e.fromPageId === inE.toPageId && !tr.has(e.toPageId))) {
          bridged.push({ fromPageId: inE.fromPageId, toPageId: outE.toPageId, trigger: inE.trigger, hitCount: Math.min(inE.hitCount, outE.hitCount), missCount: inE.missCount, synthetic: true });
        }
      }
      es = [...es.filter((e) => !tr.has(e.fromPageId) && !tr.has(e.toPageId)), ...bridged];
      ps = pages.filter((p) => !p.transient);
    }
    return { visiblePages: ps, visibleEdges: es };
  }, [pages, edges, hideTransient, hideUnreliable, minHits]);

  const labels: LayoutLabels = {
    visits: t('memory.graphVisits'),
    aliases: t('memory.graphAliases'),
    root: t('memory.graphRoot'),
    auto: t('memory.graphAuto'),
    manual: mt('manualEdge', lang),
  };
  const laid = useMemo(
    () => layout(visiblePages, visibleEdges, rootPageId, labels, positions),
    // labels 由 t / lang 衍生,語系切換時 t 會變
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visiblePages, visibleEdges, rootPageId, t, positions],
  );

  // ── 操作路線:編輯中的草稿 / 在圖上顯示的路線 ──
  const [draft, setDraft] = useState<MemoryRoute | null>(null);
  const [pick, setPick] = useState<RoutePick | null>(null);
  const [shownId, setShownId] = useState<string | null>(null);
  const shownRoute = draft ?? routes.find((r) => r.id === shownId) ?? null;
  const picking = Boolean(draft && pick);
  const base = useMemo(
    () => overlayRoute(laid, shownRoute, picking, lang === 'zh' ? '支' : 'B'),
    [laid, shownRoute, picking, lang],
  );

  // 受控狀態(拖曳、選取);資料重新載入時同步,保留選取。
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(base.nodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>(base.edges);
  useEffect(() => {
    setNodes((prev) => {
      const sel = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return base.nodes.map((n) => (sel.has(n.id) ? { ...n, selected: true } : n));
    });
    setFlowEdges(base.edges);
  }, [base, setNodes, setFlowEdges]);

  const run = useCallback(async (ops: GraphEditOp[]): Promise<boolean> => {
    if (!onEdit || ops.length === 0) return false;
    setBusy(true);
    setError('');
    try {
      for (const op of ops) await onEdit(op);
      return true;
    } catch (err) {
      setError(`${mt('failed', lang)}${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }, [onEdit, lang]);

  // 路線編輯中點畫面 = 加一步 / 加支線;否則開編修抽屜。
  const onNodeClick = useCallback((pageId: string) => {
    if (draft && pick) {
      if (pick.kind === 'branch') {
        setDraft(addBranch(draft, pick.fromStepId, pageId));
        setPick({ kind: 'step' });
      } else {
        setDraft(addStep(draft, pageId));
      }
      return;
    }
    onOpenPage?.(pageId);
  }, [draft, pick, onOpenPage]);
  const closeDraft = useCallback(() => { setDraft(null); setPick(null); }, []);
  const saveRoute = useCallback(async (r: MemoryRoute) => {
    if (await run([{ op: 'saveRoute', route: r }])) { setShownId(r.id); closeDraft(); }
  }, [run, closeDraft]);
  const deleteRoute = useCallback(async (r: MemoryRoute) => {
    if (await run([{ op: 'deleteRoute', routeId: r.id }]) && shownId === r.id) setShownId(null);
  }, [run, shownId]);
  const toggleRoute = useCallback(async (r: MemoryRoute) => {
    await run([{ op: 'saveRoute', route: { ...r, enabled: !r.enabled } }]);
  }, [run]);

  // ── 拖曳:存位置 / 放到另一個畫面上 = 合併 ──
  const dragStart = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // 放到哪個畫面上:被拖曳節點的中心點落在另一個節點的範圍內(用拖曳中的即時位置,不靠內部快取)。
  const overTarget = useCallback((node: Node) => {
    const cx = node.position.x + (node.measured?.width ?? NODE_W) / 2;
    const cy = node.position.y + (node.measured?.height ?? NODE_H) / 2;
    const hit = getNodes().find((n) => {
      if (n.id === node.id) return false;
      const w = n.measured?.width ?? NODE_W;
      const h = n.measured?.height ?? NODE_H;
      return cx >= n.position.x && cx <= n.position.x + w && cy >= n.position.y && cy <= n.position.y + h;
    });
    return hit?.id ?? null;
  }, [getNodes]);

  useEffect(() => {
    setNodes((prev) => prev.map((n) => {
      const want = n.id === dropTarget;
      if (Boolean((n.data as ScreenNodeData).dropTarget) === want) return n;
      return { ...n, data: { ...n.data, dropTarget: want, dropLabel: mt('mergeDrop', lang) } };
    }));
  }, [dropTarget, setNodes, lang]);

  const onNodeDragStart = useCallback((_: unknown, _node: Node, dragged: Node[]) => {
    dragStart.current = new Map(dragged.map((n) => [n.id, { ...n.position }]));
  }, []);
  const onNodeDrag = useCallback((_: unknown, node: Node, dragged: Node[]) => {
    if (!editable || dragged.length !== 1) return;
    setDropTarget(overTarget(node));
  }, [editable, overTarget]);
  const onNodeDragStop = useCallback(async (_: unknown, node: Node, dragged: Node[]) => {
    setDropTarget(null);
    if (!editable) return;
    const into = dragged.length === 1 ? overTarget(node) : null;
    if (into) {
      const name = (id: string) => pages.find((p) => p.id === id)?.name ?? id;
      const msg = mt('mergeConfirm', lang).replaceAll('{from}', name(node.id)).replaceAll('{to}', name(into));
      // 先放回原位(合併成功後節點會消失;取消則維持原位)。
      const back = dragStart.current.get(node.id);
      if (back) setNodes((prev) => prev.map((n) => (n.id === node.id ? { ...n, position: back } : n)));
      if (window.confirm(msg)) await run([{ op: 'mergePage', pageId: node.id, intoPageId: into }]);
      return;
    }
    const moved = dragged.filter((n) => {
      const s = dragStart.current.get(n.id);
      return !s || Math.abs(s.x - n.position.x) > 1 || Math.abs(s.y - n.position.y) > 1;
    });
    if (!moved.length) return;
    // 第一次手動排列時把整張圖的目前位置一起存下來(之後新增路徑/畫面時其他節點才不會跳動)。
    const all: Positions = {};
    for (const n of nodes) if (!positions[n.id]) all[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    for (const n of moved) all[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    await run([{ op: 'moveMany', positions: all }]);
  }, [editable, overTarget, pages, lang, setNodes, run, nodes, positions]);

  // ── 拉線新增路徑 ──
  const onConnect = useCallback((c: Connection) => {
    if (!editable || !c.source || !c.target || c.source === c.target) return;
    setConnect({ from: c.source, to: c.target });
  }, [editable]);

  // ── Delete 鍵刪除選取的畫面 / 路徑(由伺服器結果重繪,這裡回 false 不在本地先刪)──
  const onBeforeDelete: OnBeforeDelete<Node, Edge> = useCallback(async ({ nodes: dn, edges: de }) => {
    if (!editable) return false;
    const pageIds = new Set(dn.map((n) => n.id));
    // 刪畫面時其相連路徑會一起消失,不必另外刪。
    const edgeOps = de
      .filter((e) => !pageIds.has(e.source) && !pageIds.has(e.target))
      .flatMap((e) => ((e.data as FlowEdgeData | undefined)?.list ?? []).filter((x) => !x.synthetic).map((x) => deleteEdgeOp(x)));
    const total = pageIds.size + de.filter((e) => !pageIds.has(e.source) && !pageIds.has(e.target)).length;
    if (!total) return false;
    if (!window.confirm(mt('delSelConfirm', lang).replace('{n}', String(total)))) return false;
    await run([...[...pageIds].map((pageId) => ({ op: 'deletePage', pageId })), ...edgeOps]);
    return false;
  }, [editable, lang, run]);

  const onRelayout = useCallback(async () => {
    if (!window.confirm(mt('relayoutConfirm', lang))) return;
    await run([{ op: 'resetLayout' }]);
  }, [lang, run]);

  const maxHit = Math.max(1, ...edges.map((e) => e.hitCount));
  const nameOf = (id: string) => pages.find((p) => p.id === id)?.name ?? id;

  return (
    <>
      <div className="sg-toolbar">
        <label><input type="checkbox" checked={hideTransient} onChange={(e) => setHideTransient(e.target.checked)} /> {t('memory.graphHideTransient')}</label>
        <label><input type="checkbox" checked={hideUnreliable} onChange={(e) => setHideUnreliable(e.target.checked)} /> {t('memory.graphHideUnreliable')}</label>
        <label>
          {t('memory.graphMinHits')}
          <input type="number" min={1} max={maxHit} value={minHits} onChange={(e) => setMinHits(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        {editable && (
          <button type="button" className="sg-btn" onClick={() => void onRelayout()} disabled={busy || Object.keys(positions).length === 0}>
            {mt('relayout', lang)}
          </button>
        )}
        {busy && <span className="sg-busy" role="status">{mt('saving', lang)}</span>}
        <span className="sg-legend">
          <span className="sg-legend__line" style={{ background: ACCENT }} /> {t('memory.graphLegendAction')}
          <span className="sg-legend__line sg-legend__line--dash" /> {t('memory.graphAuto')}
          <span className="sg-legend__line" style={{ background: WARN }} /> {t('memory.graphLegendUnreliable')}
          {editable && <><span className="sg-legend__line" style={{ background: MANUAL }} /> {mt('manualEdge', lang)}</>}
          {shownRoute && <><span className="sg-legend__line" style={{ background: ROUTE }} /> {rt('title', lang)}<span className="sg-legend__line sg-legend__line--branch" /> {rt('addBranch', lang).replace('+ ', '')}</>}
        </span>
      </div>
      {editable && (
        <RoutesPanel
          lang={lang}
          routes={routes}
          draft={draft}
          pick={pick}
          shownId={shownId}
          busy={busy}
          pageName={(id) => pages.find((p) => p.id === id)?.name ?? ''}
          onDraft={setDraft}
          onPick={setPick}
          onShow={setShownId}
          onSave={saveRoute}
          onCancel={closeDraft}
          onDelete={deleteRoute}
          onToggle={toggleRoute}
        />
      )}
      {editable && !draft && <p className="sg-edit-hint">{mt('graphEditHint', lang)}</p>}
      {error && <p className="sg-error" role="alert">{error}</p>}
      <div className={`sg-canvas${busy ? ' sg-canvas--busy' : ''}`}>
        <ReactFlow
          nodes={nodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={(e, n, ns) => void onNodeDragStop(e, n, ns)}
          onNodeClick={(_, n) => onNodeClick(n.id)}
          onConnect={onConnect}
          onBeforeDelete={onBeforeDelete}
          nodesConnectable={editable}
          deleteKeyCode={editable ? ['Delete', 'Backspace'] : null}
          onlyRenderVisibleElements
          fitView
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
        {connect && (
          <AddEdgeDialog
            lang={lang}
            fromName={nameOf(connect.from)}
            toName={nameOf(connect.to)}
            busy={busy}
            onCancel={() => setConnect(null)}
            onSubmit={async (kind, target) => {
              await run([{ op: 'addEdge', fromPageId: connect.from, toPageId: connect.to, kind, target }]);
              setConnect(null);
            }}
          />
        )}
      </div>
    </>
  );
}

const KINDS = [
  ['tap', 'kindTap'],
  ['swipe', 'kindSwipe'],
  ['back', 'kindBack'],
  ['auto', 'kindAuto'],
] as const;

/** 拉線後的小對話框:選怎麼過去(tap/swipe/back/auto)+ 操作的元件。 */
function AddEdgeDialog({
  lang, fromName, toName, busy, onCancel, onSubmit,
}: {
  lang: RLang;
  fromName: string;
  toName: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (kind: string, target: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<string>('tap');
  const [target, setTarget] = useState('');
  const firstRef = useRef<HTMLSelectElement>(null);
  useEffect(() => { firstRef.current?.focus(); }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSubmit(kind, kind === 'auto' ? '' : target.trim());
  };
  return (
    <div className="sg-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <form
        className="sg-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sg-dialog-title"
        onSubmit={submit}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      >
        <h3 id="sg-dialog-title">{mt('addEdgeTitle', lang)}</h3>
        <p className="sg-dialog__route">「{fromName}」 → 「{toName}」</p>
        <label className="sg-dialog__field">
          <span>{mt('addEdgeKind', lang)}</span>
          <select ref={firstRef} value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map(([k, label]) => <option key={k} value={k}>{mt(label, lang)}</option>)}
          </select>
        </label>
        {kind !== 'auto' && (
          <label className="sg-dialog__field">
            <span>{mt('addEdgeTarget', lang)}</span>
            <input value={target} maxLength={40} placeholder={mt('addEdgeTargetPh', lang)} onChange={(e) => setTarget(e.target.value)} />
          </label>
        )}
        <p className="sg-dialog__hint">{mt('addEdgeHint', lang)}</p>
        <div className="sg-dialog__actions">
          <button type="button" className="sg-btn" onClick={onCancel} disabled={busy}>{mt('cancel', lang)}</button>
          <button type="submit" className="sg-btn sg-btn--primary" disabled={busy}>{busy ? mt('saving', lang) : mt('add', lang)}</button>
        </div>
      </form>
    </div>
  );
}
