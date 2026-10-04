import { useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import '@xyflow/react/dist/style.css';
import { useI18n } from '../i18n/I18nProvider.tsx';
import './ScreenGraph.css';

const ACCENT = '#ff2d95';
const WARN = '#d29922';
const AUTO = '#8a919e';
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
}

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
}

/** 節點:截圖縮圖 + 熱度 + 名稱 + 別名數 + 到訪次數;載入/過場節點縮成小膠囊。 */
function ScreenFlowNode({ data }: NodeProps) {
  const d = data as ScreenNodeData;
  if (d.transient) {
    return (
      <div className="sg-node sg-node--transient" title={d.aliases.join('、')}>
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
    <div className={`sg-node ${d.isRoot ? 'sg-node--root' : ''}`} title={title}>
      <Handle type="target" position={Position.Left} />
      <div className="sg-node__heat" style={{ width: `${Math.max(8, d.heat * 100)}%` }} />
      <div className="sg-node__thumb">
        {d.screenshotUrl ? <img src={d.screenshotUrl} alt={d.name} loading="lazy" /> : <div className="sg-node__noimg" />}
        {d.isRoot && <span className="sg-node__root">{d.rootLabel}</span>}
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

interface LayoutLabels { visits: string; aliases: string; root: string; auto: string }

/** dagre 分層佈局(LR)。同一對節點間的多條邊合併成一條(標籤列出各觸發)。 */
function layout(pages: MemPage[], mapEdges: MemEdge[], rootId: string | null, labels: LayoutLabels): { nodes: Node[]; edges: Edge[] } {
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
    g.setEdge(e.fromPageId, e.toPageId, { weight: list.reduce((a, x) => a + x.hitCount, 0) });
  }
  dagre.layout(g);

  const nodes: Node[] = pages.map((p) => {
    const pos = g.node(p.id);
    const w = p.transient ? TRANSIENT_W : NODE_W;
    const h = p.transient ? TRANSIENT_H : NODE_H;
    const aliases = Object.keys(p.aliases ?? {}).filter((n) => n !== p.name);
    return {
      id: p.id,
      type: 'screen',
      position: { x: (pos?.x ?? 0) - w / 2, y: (pos?.y ?? 0) - h / 2 },
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
  const edges: Edge[] = [...grouped.values()].map((list, i) => {
    const hit = list.reduce((a, x) => a + x.hitCount, 0);
    const miss = list.reduce((a, x) => a + x.missCount, 0);
    const allAuto = list.every((x) => (x.trigger?.kind ?? x.trigger?.label) === 'auto');
    const unreliable = miss > hit;
    const color = unreliable ? WARN : allAuto ? AUTO : ACCENT;
    const label = list
      .map((x) => (x.trigger?.kind === 'auto' || x.trigger?.label === 'auto' ? labels.auto : x.trigger?.label || x.trigger?.kind || ''))
      .filter(Boolean)
      .slice(0, 3)
      .join(' / ');
    return {
      id: `e${i}`,
      source: list[0]!.fromPageId,
      target: list[0]!.toPageId,
      label: `${label} ×${hit}${miss ? ` (✗${miss})` : ''}`,
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: 1 + (hit / maxHit) * 3, ...(allAuto ? { strokeDasharray: '5 4' } : {}) },
      labelStyle: { fill: 'var(--text-secondary)', fontSize: 11 },
      labelBgStyle: { fill: 'var(--surface)' },
    };
  });

  return { nodes, edges };
}

export function ScreenGraph({ pages, edges, rootPageId = null }: { pages: MemPage[]; edges: MemEdge[]; rootPageId?: string | null }) {
  const { t } = useI18n();
  const [hideTransient, setHideTransient] = useState(false);
  const [hideUnreliable, setHideUnreliable] = useState(false);
  const [minHits, setMinHits] = useState(1);

  const { visiblePages, visibleEdges } = useMemo(() => {
    let es = edges.filter((e) => e.hitCount >= minHits);
    if (hideUnreliable) es = es.filter((e) => e.missCount <= e.hitCount);
    let ps = pages;
    if (hideTransient) {
      // 隱藏載入節點時,把「A → 載入中 → B」接成「A → B」,流程不斷線。
      const tr = new Set(pages.filter((p) => p.transient).map((p) => p.id));
      const bridged: MemEdge[] = [];
      for (const inE of es.filter((e) => tr.has(e.toPageId) && !tr.has(e.fromPageId))) {
        for (const outE of es.filter((e) => e.fromPageId === inE.toPageId && !tr.has(e.toPageId))) {
          bridged.push({ fromPageId: inE.fromPageId, toPageId: outE.toPageId, trigger: inE.trigger, hitCount: Math.min(inE.hitCount, outE.hitCount), missCount: inE.missCount });
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
  };
  const { nodes, edges: flowEdges } = useMemo(
    () => layout(visiblePages, visibleEdges, rootPageId, labels),
    // labels 由 t 衍生,語系切換時 t 會變
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visiblePages, visibleEdges, rootPageId, t],
  );
  if (pages.length === 0) return null;
  const maxHit = Math.max(1, ...edges.map((e) => e.hitCount));

  return (
    <>
      <div className="sg-toolbar">
        <label><input type="checkbox" checked={hideTransient} onChange={(e) => setHideTransient(e.target.checked)} /> {t('memory.graphHideTransient')}</label>
        <label><input type="checkbox" checked={hideUnreliable} onChange={(e) => setHideUnreliable(e.target.checked)} /> {t('memory.graphHideUnreliable')}</label>
        <label>
          {t('memory.graphMinHits')}
          <input type="number" min={1} max={maxHit} value={minHits} onChange={(e) => setMinHits(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <span className="sg-legend">
          <span className="sg-legend__line" style={{ background: ACCENT }} /> {t('memory.graphLegendAction')}
          <span className="sg-legend__line sg-legend__line--dash" /> {t('memory.graphAuto')}
          <span className="sg-legend__line" style={{ background: WARN }} /> {t('memory.graphLegendUnreliable')}
        </span>
      </div>
      <div className="sg-canvas">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
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
        </ReactFlowProvider>
      </div>
    </>
  );
}
