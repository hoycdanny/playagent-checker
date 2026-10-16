import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BaseEdge,
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
  type EdgeProps,
  type Connection,
  type OnBeforeDelete,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import '@xyflow/react/dist/style.css';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { reportLang, type RLang } from './report/reportText.ts';
import { deleteEdgeOp, mt } from './memory/MemoryEditor.tsx';
import { RoutesPanel, addBranch, addStep, rt, type MemoryRoute, type RoutePick } from './memory/RoutesPanel.tsx';
import {
  discoveryOrder,
  distinctAliases,
  edgeCaption,
  hideLoadingScreens,
  isAutoEdge,
  moduleLabel,
  screenLabels,
} from './memory/graphView.ts';
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

interface MemPage {
  id: string;
  name: string;
  visitCount: number;
  screenshotUrl?: string;
  aliases?: Record<string, number>;
  module?: string;
  transient?: boolean;
  renamed?: boolean;
  firstSeenAt?: string;
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
  via?: string[];
}

/** 記憶關係圖的編修指令(送 POST /memory/edit)。 */
export type GraphEditOp = Record<string, unknown> & { op: string };
export type Positions = Record<string, { x: number; y: number }>;

interface ScreenNodeData extends Record<string, unknown> {
  name: string;
  /** 用來區分同名畫面的描述(空字串 = 不需要)。 */
  subtitle: string;
  /** 依第一次發現排的順序(1 起算)。 */
  order: number;
  visitCount: number;
  heat: number;
  screenshotUrl?: string;
  aliases: string[];
  module?: string;
  moduleLabel: string;
  isRoot: boolean;
  transient: boolean;
  loadingLabel: string;
  visitsLabel: string;
  aliasesLabel: string;
  rootLabel: string;
  dropTarget?: boolean;
  dropLabel?: string;
  /** 顯示中的路線經過這個畫面的步驟編號(支線畫面為「支」)。 */
  routeBadges?: string[];
  picking?: boolean;
  /** 下方工作區正打開這個畫面。 */
  focused?: boolean;
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
  const drop = (d.dropTarget ? ' sg-node--drop' : '') + (d.picking ? ' sg-node--picking' : '') + (d.routeBadges?.length ? ' sg-node--onroute' : '') + (d.focused ? ' sg-node--focused' : '');
  // 載入/過場畫面也是獨立節點(各自載入不同東西),一樣顯示截圖,只用虛線框 + 「載入」標籤區分。
  const transientCls = d.transient ? ' sg-node--loading' : '';
  const fullName = d.subtitle ? `${d.name} · ${d.subtitle}` : d.name;
  const title = [fullName, ...(d.aliases.length ? [`${d.aliasesLabel}: ${d.aliases.join('、')}`] : []), d.module ? `${d.moduleLabel} (${d.module})` : '']
    .filter(Boolean)
    .join('\n');
  return (
    <div className={`sg-node ${d.isRoot ? 'sg-node--root' : ''}${transientCls}${drop}`} title={title}>
      <Handle type="target" position={Position.Left} />
      <div className="sg-node__heat" style={{ width: `${Math.max(8, d.heat * 100)}%` }} />
      <div className="sg-node__thumb">
        {d.screenshotUrl ? <img src={d.screenshotUrl} alt={fullName} loading="lazy" draggable={false} /> : <div className="sg-node__noimg" />}
        <span className="sg-node__order" aria-hidden="true">{d.order}</span>
        {d.isRoot && <span className="sg-node__root">{d.rootLabel}</span>}
        {d.transient && <span className="sg-node__loading">{d.loadingLabel}</span>}
        <RouteBadges list={d.routeBadges} />
        {d.dropTarget && <span className="sg-node__droplabel">{d.dropLabel}</span>}
      </div>
      <div className="sg-node__name">{d.name}</div>
      {d.subtitle && <div className="sg-node__sub">{d.subtitle}</div>}
      <div className="sg-node__meta">
        <span>{d.visitsLabel.replace('{n}', String(d.visitCount))}</span>
        {d.module && <span className="sg-node__module">{d.moduleLabel}</span>}
        {d.aliases.length > 0 && <span className="sg-node__alias">+{d.aliases.length} {d.aliasesLabel}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { screen: ScreenFlowNode };

interface BackEdgeData extends FlowEdgeData { lane: number; laneY: number }

/** 折線 → 圓角路徑。 */
function roundedPath(points: Array<[number, number]>, r = 10): string {
  let d = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]!;
    const [cx, cy] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    const k1 = Math.min(r, Math.hypot(cx - px, cy - py) / 2);
    const k2 = Math.min(r, Math.hypot(nx - cx, ny - cy) / 2);
    const a = [cx - Math.sign(cx - px) * k1, cy - Math.sign(cy - py) * k1];
    const b = [cx + Math.sign(nx - cx) * k2, cy + Math.sign(ny - cy) * k2];
    d += ` L ${a[0]} ${a[1]} Q ${cx} ${cy} ${b[0]} ${b[1]}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L ${last[0]} ${last[1]}`;
}

/**
 * 往回走的線:從來源右側出來 → 沿欄與欄之間的空隙往下 → 走整張圖最下方的「返回車道」→
 * 從目標左側進入。垂直段只走在欄間空隙、水平段在所有卡片下方,不會穿過任何畫面。
 */
function BackEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius, data }: EdgeProps) {
  const d = data as BackEdgeData;
  const gap = 18 + d.lane * 10;
  const outX = sourceX + gap;
  const inX = targetX - gap;
  const path = roundedPath([[sourceX, sourceY], [outX, sourceY], [outX, d.laneY], [inX, d.laneY], [inX, targetY], [targetX, targetY]]);
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      style={style}
      label={label}
      labelX={(outX + inX) / 2}
      labelY={d.laneY}
      labelStyle={labelStyle}
      labelShowBg
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
    />
  );
}

interface RoutedEdgeData extends FlowEdgeData { points: Array<{ x: number; y: number }> }

/** 跨好幾欄的往前線:照排版引擎算好的避讓點走(繞過中間的卡片),轉折處平滑。 */
function RoutedEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius, data }: EdgeProps) {
  const inner = (data as RoutedEdgeData).points.slice(1, -1);
  const pts = [{ x: sourceX, y: sourceY }, ...inner, { x: targetX, y: targetY }];
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  const first = mid(pts[0]!, pts[1]!);
  d += ` L ${first.x} ${first.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const m = mid(pts[i]!, pts[i + 1]!);
    d += ` Q ${pts[i]!.x} ${pts[i]!.y} ${m.x} ${m.y}`;
  }
  d += ` L ${targetX} ${targetY}`;
  const at = inner[Math.floor(inner.length / 2)] ?? mid(pts[0]!, pts[pts.length - 1]!);
  return (
    <BaseEdge
      id={id}
      path={d}
      markerEnd={markerEnd}
      style={style}
      label={label}
      labelX={at.x}
      labelY={at.y}
      labelStyle={labelStyle}
      labelShowBg
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
    />
  );
}

const edgeTypes = { back: BackEdge, routed: RoutedEdge };

interface LayoutLabels { visits: string; aliases: string; root: string; manual: string; loading: string }

/**
 * 排版:依「第一次發現」的順序由左到右(只有往前走的線參與 dagre 分層,主流程排成一條線);
 * 有手動位置的節點用手動位置。往回走的線(目標在來源左邊)從兩張卡片下方繞回,不再看起來像自己連自己。
 * 同一對節點、同一方向的多條邊合併成一條(標籤列出各動作;刪除時刪掉底下全部)。
 */
function layout(
  pages: MemPage[],
  mapEdges: MemEdge[],
  rootId: string | null,
  labels: LayoutLabels,
  positions: Positions,
  lang: RLang,
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 140 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(pages.map((p) => p.id));
  const maxVisits = Math.max(1, ...pages.map((p) => p.visitCount));
  // dagre 依加入順序排同一層的上下位置:照發現順序加入,圖才穩定、好對照。
  const order = discoveryOrder(pages, mapEdges, rootId);
  const sortedPages = [...pages].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  for (const p of sortedPages) g.setNode(p.id, { width: NODE_W, height: NODE_H });

  // 合併同方向平行邊。
  const grouped = new Map<string, MemEdge[]>();
  for (const e of mapEdges) {
    if (e.fromPageId === e.toPageId || !ids.has(e.fromPageId) || !ids.has(e.toPageId)) continue;
    const k = `${e.fromPageId}>${e.toPageId}`;
    grouped.set(k, [...(grouped.get(k) ?? []), e]);
  }
  // 只有「往前走」(來源比目標先被發現)的線參與分層;權重 = 成功次數,讓主要流程成為主幹。
  for (const list of grouped.values()) {
    const e = list[0]!;
    if ((order.get(e.fromPageId) ?? 0) >= (order.get(e.toPageId) ?? 0)) continue;
    g.setEdge(e.fromPageId, e.toPageId, { weight: list.reduce((a, x) => a + x.hitCount, 0) + (list.some((x) => x.manual) ? 1 : 0) });
  }
  dagre.layout(g);

  const names = screenLabels(pages, (m) => moduleLabel(m, lang));
  const posOf = new Map<string, { x: number; y: number }>();
  const nodes: Node[] = sortedPages.map((p) => {
    const pos = g.node(p.id);
    const saved = positions[p.id];
    const position = saved
      ? { x: saved.x, y: saved.y }
      : { x: Math.round((pos?.x ?? 0) - NODE_W / 2), y: Math.round((pos?.y ?? 0) - NODE_H / 2) };
    posOf.set(p.id, position);
    const label = names.get(p.id) ?? { title: p.name, subtitle: '' };
    return {
      id: p.id,
      type: 'screen',
      position,
      data: {
        name: label.title,
        subtitle: label.subtitle,
        order: (order.get(p.id) ?? 0) + 1,
        visitCount: p.visitCount,
        heat: p.visitCount / maxVisits,
        screenshotUrl: p.screenshotUrl,
        aliases: distinctAliases(p),
        module: p.module,
        moduleLabel: p.module ? moduleLabel(p.module, lang) : '',
        isRoot: p.id === rootId,
        transient: Boolean(p.transient),
        loadingLabel: labels.loading,
        visitsLabel: labels.visits,
        aliasesLabel: labels.aliases,
        rootLabel: labels.root,
      } satisfies ScreenNodeData,
    };
  });

  const maxHit = Math.max(1, ...mapEdges.map((e) => e.hitCount));
  // 返回車道:所有卡片最下緣再往下;每條回頭線一條車道,不互相重疊。
  const bottom = Math.max(0, ...[...posOf.values()].map((p) => p.y + NODE_H));
  let backIndex = 0;
  const edges: Edge[] = [...grouped.entries()].map(([k, list]) => {
    const hit = list.reduce((a, x) => a + x.hitCount, 0);
    const miss = list.reduce((a, x) => a + x.missCount, 0);
    const manual = list.some((x) => x.manual);
    const allAuto = list.every(isAutoEdge);
    const unreliable = !manual && miss > hit;
    const color = manual ? MANUAL : unreliable ? WARN : allAuto ? AUTO : ACCENT;
    const from = list[0]!.fromPageId;
    const to = list[0]!.toPageId;
    // 往回走:目標畫在來源左邊(或幾乎同一欄)。
    const back = (posOf.get(to)?.x ?? 0) < (posOf.get(from)?.x ?? 0) + NODE_W / 2;
    const caption = `${back ? '↩ ' : ''}${manual ? `${labels.manual} · ` : ''}${edgeCaption(list, lang)}`;
    const width = manual ? 2.5 : 1 + (hit / maxHit) * 3;
    const edge: Edge = {
      id: `e:${k}`,
      source: from,
      target: to,
      label: caption,
      data: { list } satisfies FlowEdgeData,
      deletable: !list.every((x) => x.synthetic),
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: {
        stroke: color,
        strokeWidth: back ? Math.max(1, width - 1) : width,
        ...(allAuto && !manual ? { strokeDasharray: '5 4' } : {}),
        ...(back ? { opacity: 0.7 } : {}),
      },
      labelStyle: { fill: manual ? MANUAL : 'var(--text-secondary)', fontSize: 11, fontWeight: manual ? 600 : 400 },
      labelBgStyle: { fill: 'var(--surface)' },
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 4,
    };
    if (!back) {
      // 跨欄的線(排版引擎有中繼點)且兩端都是自動排的位置:照避讓點走,不穿過中間的卡片。
      const points = (g.edge(from, to) as { points?: Array<{ x: number; y: number }> } | undefined)?.points;
      if (points && points.length > 3 && !positions[from] && !positions[to]) {
        return { ...edge, type: 'routed', data: { list, points } satisfies RoutedEdgeData };
      }
      return edge;
    }
    const lane = backIndex++;
    return { ...edge, type: 'back', data: { list, lane, laneY: bottom + 44 + lane * 26 } satisfies BackEdgeData };
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
  /** 目前在下方工作區打開的畫面(圖上加外框標示)。 */
  focusedPageId?: string;
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

function ScreenGraphInner({ pages, edges, rootPageId = null, positions = NO_POSITIONS, onEdit, onOpenPage, routes = NO_ROUTES, focusedPageId }: ScreenGraphProps) {
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

  const { visiblePages, visibleEdges, keptLoading } = useMemo(() => {
    // 人工標註的路徑一律顯示(不受最少次數 / 不可靠篩選影響)。
    let es = edges.filter((e) => e.manual || e.hitCount >= minHits);
    if (hideUnreliable) es = es.filter((e) => e.manual || e.missCount <= e.hitCount);
    if (!hideTransient) return { visiblePages: pages, visibleEdges: es, keptLoading: 0 };
    // 隱藏載入畫面:只在能確定前後關係時才把「A → 載入 → B」接成「A → B」,不產生假路徑。
    const r = hideLoadingScreens(pages, es);
    return { visiblePages: r.pages, visibleEdges: r.edges, keptLoading: r.keptLoading };
  }, [pages, edges, hideTransient, hideUnreliable, minHits]);

  const labels: LayoutLabels = {
    visits: t('memory.graphVisits'),
    aliases: t('memory.graphAliases'),
    root: t('memory.graphRoot'),
    manual: mt('manualEdge', lang),
    loading: mt('loadingTag', lang),
  };
  const laid = useMemo(
    () => layout(visiblePages, visibleEdges, rootPageId, labels, positions, lang),
    // labels 由 t / lang 衍生,語系切換時 t 會變
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visiblePages, visibleEdges, rootPageId, t, positions, lang],
  );

  // ── 操作路線:編輯中的草稿 / 在圖上顯示的路線 ──
  const [draft, setDraft] = useState<MemoryRoute | null>(null);
  const [pick, setPick] = useState<RoutePick | null>(null);
  const [shownId, setShownId] = useState<string | null>(null);
  const shownRoute = draft ?? routes.find((r) => r.id === shownId) ?? null;
  const picking = Boolean(draft && pick);
  const base = useMemo(() => {
    const b = overlayRoute(laid, shownRoute, picking, lang === 'zh' ? '支' : 'B');
    if (!focusedPageId) return b;
    return { ...b, nodes: b.nodes.map((n) => (n.id === focusedPageId ? { ...n, data: { ...n.data, focused: true } } : n)) };
  }, [laid, shownRoute, picking, lang, focusedPageId]);

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
        {shownRoute && (
          <span className="sg-legend">
            <span className="sg-legend__line" style={{ background: ROUTE }} /> {rt('title', lang)}
            <span className="sg-legend__line sg-legend__line--branch" /> {rt('addBranch', lang).replace('+ ', '')}
          </span>
        )}
      </div>
      {hideTransient && keptLoading > 0 && (
        <p className="sg-note" role="status">{gt('keptLoading', lang).replace('{n}', String(keptLoading))}</p>
      )}
      <GraphGuide lang={lang} />
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
          edgeTypes={edgeTypes}
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

/** 「怎麼看這張圖」的文字(zh / en)。 */
const GUIDE: Record<string, [string, string]> = {
  title: ['怎麼看這張圖', 'How to read this map'],
  intro: [
    '每張卡片是 AI 在測試中看過的一個畫面;線代表「在這個畫面做了什麼之後,到了哪個畫面」。所有線都來自實際測試記錄。',
    'Each card is a screen the AI saw during testing; a line means "after doing this here, the game went there". Every line comes from real test runs.',
  ],
  cardsTitle: ['畫面卡片', 'Screen cards'],
  order: ['截圖右下角數字 = 第一次發現的順序,畫面大致由左到右照這個順序排', 'Number at the bottom-right of the screenshot = order in which the screen was first found; cards run left to right in that order'],
  root: ['「起點」= 遊戲開啟後的第一個畫面', '"Start" = the first screen after the game opens'],
  heat: ['上方粉紅條越長 = 到過這個畫面的次數越多', 'Longer pink bar on top = visited more often'],
  loading: ['虛線框 +「載入」= 載入/過場畫面', 'Dashed border + "Loading" = loading or transition screen'],
  sub: ['名稱下的灰字 = 用來區分同名畫面的描述(例如「轉軸畫面 · EXTRA BET 彈窗」)', 'Grey text under a name tells same-named screens apart (e.g. "Reels · EXTRA BET popup")'],
  module: ['小標籤 = 遊戲模組(轉軸、彈窗、登入…)', 'Small tag = game module (reels, popup, login…)'],
  alias: ['「+N 別名」= AI 對同一畫面用過的其他說法,滑鼠移到卡片上可看全部', '"+N aliases" = other names the AI used for the same screen; hover the card to see them'],
  linesTitle: ['連線', 'Lines'],
  action: ['粉紅實線 = AI 做了操作(點擊、滑動、重新啟動…)後畫面切換', 'Solid pink = the AI did something (tap, swipe, relaunch…) and the screen changed'],
  auto: ['灰色虛線 = 畫面自己切換(載入完成、動畫結束),不是 AI 點出來的', 'Dashed grey = the screen changed by itself (loading finished, animation ended)'],
  unreliable: ['黃線 = 常失敗:做了這個操作但畫面沒反應的次數比成功多', 'Yellow = unreliable: the action had no effect more often than it worked'],
  manual: ['藍線 = 測試人員手動標註的路徑', 'Blue = path marked by a tester'],
  back: ['↩ 沿整張圖最下方走回去的淡色線 = 往回走(返回、重新啟動、回到先前的畫面)', '↩ Faded line along the bottom of the map = going back (back key, relaunch, return to an earlier screen)'],
  counts: ['線越粗 = 走過越多次;「N 次」= 成功次數,「無效 N 次」= 做了但畫面沒變', 'Thicker = used more; ×N = successes, ✗N = attempts with no effect'],
  via: ['「經載入」= 隱藏了中間的載入畫面', '"via loading" = loading screens in between are hidden'],
  keptLoading: [
    '有 {n} 個載入畫面同時接到好幾條流程,隱藏後無法確定誰接誰,為避免畫出錯誤路線仍保留顯示。',
    '{n} loading screen(s) connect several flows and stay visible, because hiding them would draw paths that never happened.',
  ],
};
function gt(key: keyof typeof GUIDE, lang: RLang): string {
  return GUIDE[key]![lang === 'zh' ? 0 : 1];
}

/** 圖例 + 看圖說明(預設展開;收合狀態記在本機)。 */
function GraphGuide({ lang }: { lang: RLang }) {
  const [open, setOpen] = useState(() => {
    // 預設收合:關係圖要在最上面一眼看到;需要時再展開說明。
    try { return localStorage.getItem('pa.memoryGuide') === 'open'; } catch { return false; }
  });
  const toggle = (next: boolean) => {
    setOpen(next);
    try { localStorage.setItem('pa.memoryGuide', next ? 'open' : 'closed'); } catch { /* 無痕模式 */ }
  };
  const line = (cls: string, color?: string) => <span className={`sg-guide__line ${cls}`} style={color ? { background: color } : undefined} aria-hidden="true" />;
  return (
    <details className="sg-guide" open={open} onToggle={(e) => toggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{gt('title', lang)}</summary>
      <p className="sg-guide__intro">{gt('intro', lang)}</p>
      <div className="sg-guide__cols">
        <section>
          <h4>{gt('cardsTitle', lang)}</h4>
          <ul>
            <li><span className="sg-guide__badge sg-guide__badge--order" aria-hidden="true">1</span>{gt('order', lang)}</li>
            <li><span className="sg-guide__badge sg-guide__badge--root" aria-hidden="true">{lang === 'zh' ? '起點' : 'Start'}</span>{gt('root', lang)}</li>
            <li>{line('sg-guide__line--heat')}{gt('heat', lang)}</li>
            <li><span className="sg-guide__box" aria-hidden="true" />{gt('loading', lang)}</li>
            <li>{gt('sub', lang)}</li>
            <li>{gt('module', lang)}</li>
            <li>{gt('alias', lang)}</li>
          </ul>
        </section>
        <section>
          <h4>{gt('linesTitle', lang)}</h4>
          <ul>
            <li>{line('', ACCENT)}{gt('action', lang)}</li>
            <li>{line('sg-guide__line--dash')}{gt('auto', lang)}</li>
            <li>{line('', WARN)}{gt('unreliable', lang)}</li>
            <li>{line('', MANUAL)}{gt('manual', lang)}</li>
            <li>{line('sg-guide__line--back', ACCENT)}{gt('back', lang)}</li>
            <li>{gt('counts', lang)}</li>
            <li>{gt('via', lang)}</li>
          </ul>
        </section>
      </div>
    </details>
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
