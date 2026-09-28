import { useMemo } from 'react';
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
import './ScreenGraph.css';

const ACCENT = '#ff2d95';
const NODE_W = 150;
const THUMB_H = 120;
const NODE_H = THUMB_H + 48;

interface MemPage {
  id: string;
  name: string;
  visitCount: number;
  screenshotUrl?: string;
}
interface MemEdge {
  fromPageId: string;
  toPageId: string;
  trigger?: { label?: string };
  hitCount: number;
  missCount: number;
}

interface ScreenNodeData extends Record<string, unknown> {
  name: string;
  visitCount: number;
  heat: number;
  screenshotUrl?: string;
}

/** 節點:真實截圖縮圖 + 熱度量尺 + 名稱 + 到訪次數。 */
function ScreenFlowNode({ data }: NodeProps) {
  const d = data as ScreenNodeData;
  return (
    <div className="sg-node">
      <Handle type="target" position={Position.Left} />
      <div className="sg-node__heat" style={{ width: `${Math.max(8, d.heat * 100)}%` }} />
      <div className="sg-node__thumb">
        {d.screenshotUrl ? (
          <img src={d.screenshotUrl} alt={d.name} loading="lazy" />
        ) : (
          <div className="sg-node__noimg" />
        )}
      </div>
      <div className="sg-node__name" title={d.name}>{d.name}</div>
      <div className="sg-node__visits">{d.visitCount} 次</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { screen: ScreenFlowNode };

/** dagre 分層佈局(LR),回傳帶座標的 React Flow nodes/edges。 */
function layout(pages: MemPage[], mapEdges: MemEdge[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 96 });
  g.setDefaultEdgeLabel(() => ({}));

  const maxVisits = Math.max(1, ...pages.map((p) => p.visitCount));
  for (const p of pages) g.setNode(p.id, { width: NODE_W, height: NODE_H });
  for (const e of mapEdges) {
    if (e.fromPageId === e.toPageId) continue; // 自環不參與排位
    if (g.hasNode(e.fromPageId) && g.hasNode(e.toPageId)) g.setEdge(e.fromPageId, e.toPageId);
  }
  dagre.layout(g);

  const nodes: Node[] = pages.map((p) => {
    const pos = g.node(p.id);
    return {
      id: p.id,
      type: 'screen',
      position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
      data: {
        name: p.name,
        visitCount: p.visitCount,
        heat: p.visitCount / maxVisits,
        screenshotUrl: p.screenshotUrl,
      } satisfies ScreenNodeData,
    };
  });

  const edges: Edge[] = mapEdges.map((e, i) => {
    const unreliable = e.missCount > e.hitCount;
    return {
      id: `e${i}`,
      source: e.fromPageId,
      target: e.toPageId,
      label: e.trigger?.label || undefined,
      markerEnd: { type: MarkerType.ArrowClosed, color: unreliable ? '#d29922' : ACCENT },
      style: { stroke: unreliable ? '#d29922' : ACCENT, strokeWidth: 1.5 },
      labelStyle: { fill: 'var(--text-secondary)', fontSize: 11 },
      labelBgStyle: { fill: 'var(--surface)' },
    };
  });

  return { nodes, edges };
}

export function ScreenGraph({ pages, edges }: { pages: MemPage[]; edges: MemEdge[] }) {
  const { nodes, edges: flowEdges } = useMemo(() => layout(pages, edges), [pages, edges]);
  if (pages.length === 0) return null;

  return (
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
  );
}
