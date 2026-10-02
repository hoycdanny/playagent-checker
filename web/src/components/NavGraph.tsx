import './NavGraph.css';

interface NavNode {
  id: string;
  /** 畫面序號;後端目前產出的 navGraph.nodes 不含此欄位,一律當作可選,缺失時不顯示序號。 */
  step?: number;
  /** 畫面名稱;後端 report.json 實際寫入的欄位叫 name 不是 screen(見 explorationRunner.mjs
   *  的 Object.values(struct.pages).map(p => ({ id, name, screenshotKey })))—— 這裡同時接受
   *  兩種欄位名,呼叫端若直接把後端原始節點傳進來也不會因型別不符而在這裡壞掉。 */
  screen?: string;
  name?: string;
  screenshotUrl?: string;
}
/** 邊:同時接受前端格式 { from, to, action } 與後端 report.json 實際寫入的格式
 *  { fromPageId, toPageId, trigger: { label } }(見 explorationRunner.mjs struct.edges)。 */
interface NavEdge {
  from?: string;
  to?: string;
  action?: string;
  fromPageId?: string;
  toPageId?: string;
  trigger?: { label?: string };
}

/**
 * 導覽關係圖(SVG)—— AI 測試期間走過的畫面(節點)與動作轉移(邊)。
 * 畫面依 step 順序垂直排列,邊標動作。展現遊戲測試方案的「流程可視化」價值。
 */
export function NavGraph({ nodes, edges }: { nodes: NavNode[]; edges?: NavEdge[] }) {
  if (!nodes || nodes.length === 0) return null;

  const NODE_W = 150;
  const NODE_H = 44;
  const GAP_Y = 40;
  const rowH = NODE_H + GAP_Y;
  const width = 420;
  const height = nodes.length * rowH + 20;
  const cx = 90;

  const posOf = (id: string) => {
    const idx = nodes.findIndex((n) => n.id === id);
    return idx < 0 ? null : { x: cx, y: 20 + idx * rowH + NODE_H / 2 };
  };

  return (
    <div className="navgraph" role="img" aria-label="navigation graph">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ maxWidth: width }}>
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="var(--text-tertiary)" />
          </marker>
        </defs>
        {/* 邊 */}
        {(edges ?? []).map((e, i) => {
          const fromId = e.from ?? e.fromPageId;
          const toId = e.to ?? e.toPageId;
          const action = e.action ?? e.trigger?.label;
          const a = fromId ? posOf(fromId) : null;
          const b = toId ? posOf(toId) : null;
          if (!a || !b) return null;
          const midY = (a.y + b.y) / 2;
          return (
            <g key={i}>
              <line
                x1={a.x} y1={a.y + NODE_H / 2} x2={b.x} y2={b.y - NODE_H / 2}
                stroke="var(--text-tertiary)" strokeWidth="1.5" markerEnd="url(#arrow)"
              />
              {action && (
                <text x={a.x + 12} y={midY} className="navgraph__edge-label">{action}</text>
              )}
            </g>
          );
        })}
        {/* 節點 */}
        {nodes.map((n, i) => {
          const y = 20 + i * rowH;
          const label = n.screen ?? n.name ?? '';
          return (
            <g key={n.id}>
              <rect
                x={cx - NODE_W / 2} y={y} width={NODE_W} height={NODE_H} rx="8"
                className="navgraph__node"
              />
              {n.step !== undefined && (
                <text x={cx} y={y + 18} className="navgraph__node-step">#{n.step}</text>
              )}
              <text x={cx} y={y + 34} className="navgraph__node-screen">
                {label.length > 16 ? label.slice(0, 16) + '…' : label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
