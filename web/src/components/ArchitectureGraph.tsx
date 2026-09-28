import { useMemo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useI18n } from '../i18n/I18nProvider.tsx';
import {
  architectureDiagram,
  type ArchKind,
  type ArchStatus,
} from './architectureData.ts';
import './ArchitectureGraph.css';

/** 格線 → 像素:每欄寬、每列高、內距。調這幾個數就能整體縮放版面。 */
const COL_W = 176; // 欄距(決定分層群組水平位置)—— 不改,維持現有配置
const ROW_H = 132; // 列高加大:節點與上下、與分層框邊之間留足間距,不再擠/疊
const PAD_X = 24;
const PAD_Y = 48;
const NODE_W = 162; // 小框寬度加大(字多的框不被截)
const NODE_H = 84; // 節點高度,配合更大字級

/** 各服務種類的強調色(用 CSS 變數在明暗主題下都好看)。 */
const KIND_ACCENT: Record<ArchKind, string> = {
  edge: 'var(--arch-purple)',
  api: 'var(--arch-blue)',
  compute: 'var(--arch-orange)',
  msg: 'var(--arch-pink)',
  device: 'var(--arch-green)',
  ai: 'var(--arch-teal)',
  data: 'var(--arch-purple)',
  external: 'var(--arch-slate)',
};

const EDGE_COLOR = {
  flow: 'var(--arch-blue)',
  async: 'var(--arch-orange)',
  model: 'var(--arch-teal)',
  support: 'var(--arch-slate)',
} as const;

interface ArchNodeData extends Record<string, unknown> {
  title?: string;
  sub?: string;
  kind?: ArchKind;
  status?: ArchStatus;
  isGroup?: boolean;
  groupTitle?: string;
}

/** 群組背景節點(分層標題 + 淡框)。頂部放一個隱形 target handle,讓邊可以指向「整個群組框」。 */
function GroupNode({ data }: NodeProps) {
  const d = data as ArchNodeData;
  return (
    <div className="archn-group">
      <Handle id="t-topa" type="target" position={Position.Top} style={{ left: '18%' }} isConnectable={false} />
      <Handle id="t-topb" type="target" position={Position.Top} isConnectable={false} />
      <Handle id="t-leftb" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="t-rightb" type="target" position={Position.Right} isConnectable={false} />
      <Handle id="t-bottoma" type="target" position={Position.Bottom} style={{ left: '30%' }} isConnectable={false} />
      <Handle id="t-bottomb" type="target" position={Position.Bottom} isConnectable={false} />
      <Handle id="t-bottomc" type="target" position={Position.Bottom} style={{ left: '70%' }} isConnectable={false} />
      <span className="archn-group__title">{d.groupTitle}</span>
    </div>
  );
}

/**
 * 服務卡片節點。每一邊放「3 個 slot」的 handle(a/b/c,分別在 25%/50%/75%),source+target 各一組。
 * 從同一節點分叉出去的多條邊,各接不同 slot → 各自從不同出發點離開,不再擠在同一點重疊。
 * handle id 格式:`s-<side><slot>` / `t-<side><slot>`,例如 s-bottoma、t-topb。
 */
const SIDES = [
  { side: 'top', pos: Position.Top, axis: 'x' },
  { side: 'bottom', pos: Position.Bottom, axis: 'x' },
  { side: 'left', pos: Position.Left, axis: 'y' },
  { side: 'right', pos: Position.Right, axis: 'y' },
] as const;
const SLOTS = [
  ['a', '28%'],
  ['b', '50%'],
  ['c', '72%'],
] as const;

function ServiceNode({ data }: NodeProps) {
  const d = data as ArchNodeData;
  const accent = KIND_ACCENT[d.kind ?? 'external'];
  return (
    <div
      className={`archn${d.status ? ` archn--${d.status}` : ''}`}
      style={{ ['--accent' as string]: accent }}
    >
      {SIDES.map(({ side, pos, axis }) =>
        SLOTS.map(([slot, off]) => {
          const style = axis === 'x' ? { left: off } : { top: off };
          return (
            <span key={`${side}${slot}`}>
              <Handle id={`t-${side}${slot}`} type="target" position={pos} style={style} isConnectable={false} />
              <Handle id={`s-${side}${slot}`} type="source" position={pos} style={style} isConnectable={false} />
            </span>
          );
        }),
      )}
      <span className="archn__bar" />
      <div className="archn__body">
        <span className="archn__title">{d.title}</span>
        {d.sub && <span className="archn__sub">{d.sub}</span>}
      </div>
    </div>
  );
}

const nodeTypes = { service: ServiceNode, group: GroupNode };

function ArchInner() {
  const { locale } = useI18n();
  const diagram = useMemo(() => architectureDiagram(locale), [locale]);

  const { nodes, edges } = useMemo(() => {
    const px = (col: number) => PAD_X + col * COL_W;
    const py = (row: number) => PAD_Y + row * ROW_H;

    // 群組背景(先畫,z 在底層)。
    const groupNodes: Node[] = diagram.layers.map((ly) => ({
      id: `grp-${ly.id}`,
      type: 'group',
      // 大框左右各留 ~14px 內距,避免最右欄節點右緣頂到框邊。
      position: { x: px(ly.col) - 14, y: py(ly.row) - 30 },
      data: { isGroup: true, groupTitle: ly.title[locale === 'en' ? 'en' : 'zh-Hant'] } satisfies ArchNodeData,
      draggable: false,
      selectable: false,
      style: {
        width: ly.cols * COL_W + 16,
        height: ly.rows * ROW_H + 6,
        zIndex: 0,
      },
    }));

    const serviceNodes: Node[] = diagram.nodes.map((n) => ({
      id: n.id,
      type: 'service',
      position: { x: px(n.col), y: py(n.row) },
      data: {
        title: n.title,
        sub: n.sub?.[locale === 'en' ? 'en' : 'zh-Hant'],
        kind: n.kind,
        status: n.status,
      } satisfies ArchNodeData,
      draggable: false,
      style: { width: NODE_W, height: NODE_H, zIndex: 1 },
    }));

    const flowEdges: Edge[] = diagram.edges.map((e, i) => {
      const color = EDGE_COLOR[e.kind];
      const dashed = e.kind === 'async' || e.kind === 'support';
      const fromSide = e.fromSide ?? 'bottom';
      const toSide = e.toSide ?? 'top';
      const fromSlot = e.fromSlot ?? 'b';
      const toSlot = e.toSlot ?? 'b';
      return {
        id: `e${i}`,
        source: e.from,
        target: e.to,
        sourceHandle: `s-${fromSide}${fromSlot}`,
        targetHandle: `t-${toSide}${toSlot}`,
        type: 'smoothstep',
        pathOptions: { borderRadius: 12 },
        animated: true,
        label: e.label?.[locale === 'en' ? 'en' : 'zh-Hant'],
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        style: { stroke: color, strokeWidth: 1.8, ...(dashed ? { strokeDasharray: '6 4' } : {}) },
        labelStyle: { fill: 'var(--text-secondary)', fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: 'var(--surface-raised)', fillOpacity: 0.9 },
        labelBgPadding: [4, 2] as [number, number],
        zIndex: 2,
      };
    });

    return { nodes: [...groupNodes, ...serviceNodes], edges: flowEdges };
  }, [diagram, locale]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
      minZoom={0.3}
      maxZoom={1.6}
      nodesConnectable={false}
      nodesDraggable={false}
      proOptions={{ hideAttribution: true }}
      panOnScroll={false}
      zoomOnScroll={false}
      preventScrolling={false}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/** 使用說明頁的 AWS 架構圖:主題一致、可平移縮放、標註已驗證/未驗證。 */
export default function ArchitectureGraph() {
  const { locale } = useI18n();
  const diagram = architectureDiagram(locale);
  return (
    <figure className="archfig">
      <div className="archfig__canvas">
        <ReactFlowProvider>
          <ArchInner />
        </ReactFlowProvider>
      </div>
      <figcaption className="archfig__legend">
        <span className="archfig__cap">{diagram.caption}</span>
      </figcaption>
    </figure>
  );
}
