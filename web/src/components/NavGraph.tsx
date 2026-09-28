import './NavGraph.css';

interface NavNode {
  id: string;
  step: number;
  screen: string;
  screenshotUrl?: string;
}
interface NavEdge {
  from: string;
  to: string;
  action: string;
}

/**
 * 導覽關係圖(SVG)—— AI 測試期間走過的畫面(節點)與動作轉移(邊)。
 * 畫面依 step 順序垂直排列,邊標動作。展現遊戲測試方案的「流程可視化」價值。
 */
export function NavGraph({ nodes, edges }: { nodes: NavNode[]; edges: NavEdge[] }) {
  if (nodes.length === 0) return null;

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
        {edges.map((e, i) => {
          const a = posOf(e.from);
          const b = posOf(e.to);
          if (!a || !b) return null;
          const midY = (a.y + b.y) / 2;
          return (
            <g key={i}>
              <line
                x1={a.x} y1={a.y + NODE_H / 2} x2={b.x} y2={b.y - NODE_H / 2}
                stroke="var(--text-tertiary)" strokeWidth="1.5" markerEnd="url(#arrow)"
              />
              {e.action && (
                <text x={a.x + 12} y={midY} className="navgraph__edge-label">{e.action}</text>
              )}
            </g>
          );
        })}
        {/* 節點 */}
        {nodes.map((n, i) => {
          const y = 20 + i * rowH;
          return (
            <g key={n.id}>
              <rect
                x={cx - NODE_W / 2} y={y} width={NODE_W} height={NODE_H} rx="8"
                className="navgraph__node"
              />
              <text x={cx} y={y + 18} className="navgraph__node-step">#{n.step}</text>
              <text x={cx} y={y + 34} className="navgraph__node-screen">
                {n.screen.length > 16 ? n.screen.slice(0, 16) + '…' : n.screen}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
