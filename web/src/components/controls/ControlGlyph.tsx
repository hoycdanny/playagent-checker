import type { ReactNode } from 'react';

/**
 * 操作行為示意圖:畫在 160×90 的「橫向手機螢幕」座標系裡,每個操作只畫自己的區域,
 * 因此多個操作可以疊在同一支手機上組成「操作預覽」(左手搖桿 + 右手技能一眼可見)。
 */

const ACCENT = 'var(--brand)';
const SOFT = 'color-mix(in srgb, var(--brand) 18%, transparent)';

function Finger({ x, y, label }: { x: number; y: number; label?: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={5.5} fill="var(--status-error)" opacity={0.9} />
      {label && (
        <text x={x} y={y + 2.4} textAnchor="middle" fontSize={6.5} fontWeight={700} fill="#fff">
          {label}
        </text>
      )}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2, dashed }: { x1: number; y1: number; x2: number; y2: number; dashed?: boolean }) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const h = 5;
  const p1 = `${x2 - h * Math.cos(a - 0.5)},${y2 - h * Math.sin(a - 0.5)}`;
  const p2 = `${x2 - h * Math.cos(a + 0.5)},${y2 - h * Math.sin(a + 0.5)}`;
  return (
    <g stroke={ACCENT} strokeWidth={1.8} fill="none" strokeLinecap="round">
      <line x1={x1} y1={y1} x2={x2} y2={y2} strokeDasharray={dashed ? '3 3' : undefined} />
      <polyline points={`${p1} ${x2},${y2} ${p2}`} />
    </g>
  );
}

const GLYPHS: Record<string, ReactNode> = {
  tap: (
    <g>
      <rect x={58} y={58} width={44} height={14} rx={7} fill={SOFT} stroke={ACCENT} strokeWidth={1.4} />
      <text x={80} y={68} textAnchor="middle" fontSize={7} fontWeight={700} fill={ACCENT}>SPIN</text>
      <circle cx={80} cy={65} r={11} fill="none" stroke={ACCENT} strokeWidth={1} opacity={0.5} />
      <Finger x={86} y={70} label="1" />
    </g>
  ),
  hold: (
    <g>
      <circle cx={80} cy={45} r={13} fill={SOFT} />
      <circle cx={80} cy={45} r={13} fill="none" stroke={ACCENT} strokeWidth={2.4} strokeDasharray="60 30" transform="rotate(-90 80 45)" />
      <text x={80} y={29} textAnchor="middle" fontSize={6.5} fill={ACCENT}>⏱</text>
      <Finger x={80} y={45} />
    </g>
  ),
  swipe: (
    <g>
      <Arrow x1={52} y1={45} x2={108} y2={45} />
      <Finger x={52} y={45} />
    </g>
  ),
  drag: (
    <g>
      <rect x={34} y={52} width={16} height={16} rx={3} fill={SOFT} stroke={ACCENT} strokeWidth={1.2} />
      <rect x={110} y={22} width={18} height={18} rx={3} fill="none" stroke={ACCENT} strokeWidth={1.2} strokeDasharray="3 2" />
      <Arrow x1={44} y1={56} x2={112} y2={34} dashed />
      <Finger x={42} y={60} />
    </g>
  ),
  joystick_center: (
    <g>
      <circle cx={80} cy={70} r={13} fill={SOFT} stroke={ACCENT} strokeWidth={1.4} />
      <circle cx={86} cy={64} r={5} fill={ACCENT} opacity={0.6} />
      <Arrow x1={80} y1={70} x2={92} y2={58} />
      <Finger x={86} y={64} />
    </g>
  ),
  joystick_left: (
    <g>
      <circle cx={28} cy={64} r={14} fill={SOFT} stroke={ACCENT} strokeWidth={1.4} />
      <circle cx={34} cy={58} r={5} fill={ACCENT} opacity={0.6} />
      <Arrow x1={28} y1={64} x2={40} y2={52} />
      <Finger x={34} y={58} label="L" />
    </g>
  ),
  skill_right: (
    <g>
      <circle cx={136} cy={68} r={9} fill={SOFT} stroke={ACCENT} strokeWidth={1.4} />
      <circle cx={118} cy={74} r={5} fill="none" stroke={ACCENT} strokeWidth={1.2} />
      <circle cx={122} cy={58} r={5} fill="none" stroke={ACCENT} strokeWidth={1.2} />
      <circle cx={138} cy={50} r={5} fill="none" stroke={ACCENT} strokeWidth={1.2} />
      <Finger x={136} y={68} label="R" />
    </g>
  ),
  aim_right: (
    <g>
      <g stroke={ACCENT} strokeWidth={1.2} fill="none">
        <circle cx={112} cy={32} r={7} />
        <line x1={112} y1={22} x2={112} y2={42} />
        <line x1={102} y1={32} x2={122} y2={32} />
      </g>
      <Arrow x1={118} y1={52} x2={104} y2={40} dashed />
      <Finger x={118} y={52} label="R" />
    </g>
  ),
  steer: (
    <g>
      <rect x={10} y={56} width={18} height={20} rx={4} fill={SOFT} stroke={ACCENT} strokeWidth={1.2} />
      <rect x={32} y={56} width={18} height={20} rx={4} fill={SOFT} stroke={ACCENT} strokeWidth={1.2} />
      <text x={19} y={69} textAnchor="middle" fontSize={9} fill={ACCENT}>◀</text>
      <text x={41} y={69} textAnchor="middle" fontSize={9} fill={ACCENT}>▶</text>
      <Finger x={22} y={70} label="L" />
    </g>
  ),
  pedals: (
    <g>
      <rect x={114} y={50} width={14} height={26} rx={3} fill={SOFT} stroke={ACCENT} strokeWidth={1.2} />
      <rect x={132} y={56} width={18} height={20} rx={3} fill={SOFT} stroke={ACCENT} strokeWidth={1.2} />
      <text x={141} y={50} textAnchor="middle" fontSize={7} fontWeight={700} fill={ACCENT}>N₂O</text>
      <Finger x={141} y={68} label="R" />
    </g>
  ),
  pinch: (
    <g>
      <Arrow x1={74} y1={50} x2={56} y2={32} />
      <Arrow x1={86} y1={40} x2={104} y2={58} />
      <Finger x={72} y={48} label="1" />
      <Finger x={88} y={42} label="2" />
    </g>
  ),
  rhythm: (
    <g>
      {[44, 68, 92, 116].map((x) => (
        <line key={x} x1={x} y1={8} x2={x} y2={80} stroke={ACCENT} strokeWidth={0.8} opacity={0.5} />
      ))}
      <line x1={34} y1={70} x2={126} y2={70} stroke={ACCENT} strokeWidth={1.6} />
      <rect x={38} y={30} width={12} height={5} rx={2} fill={ACCENT} />
      <rect x={86} y={50} width={12} height={5} rx={2} fill={ACCENT} />
      <rect x={110} y={14} width={12} height={22} rx={2} fill={SOFT} stroke={ACCENT} strokeWidth={1} />
      <Finger x={92} y={70} />
    </g>
  ),
  keyboard: (
    <g>
      <rect x={10} y={48} width={104} height={36} rx={3} fill={SOFT} stroke={ACCENT} strokeWidth={1.2} />
      {[0, 1].map((row) =>
        Array.from({ length: 8 }, (_, i) => (
          <rect
            key={`${row}-${i}`}
            x={14 + i * 12}
            y={52 + row * 9}
            width={10}
            height={7}
            rx={1.2}
            fill={(row === 1 && (i === 1 || i === 2)) ? ACCENT : 'var(--surface)'}
            stroke={ACCENT}
            strokeWidth={0.6}
          />
        )),
      )}
      <rect x={30} y={71} width={50} height={8} rx={1.2} fill="var(--surface)" stroke={ACCENT} strokeWidth={0.6} />
      {/* 方向鍵 */}
      <rect x={93} y={63} width={8} height={7} rx={1} fill={ACCENT} />
      <rect x={84} y={72} width={8} height={7} rx={1} fill="var(--surface)" stroke={ACCENT} strokeWidth={0.6} />
      <rect x={93} y={72} width={8} height={7} rx={1} fill="var(--surface)" stroke={ACCENT} strokeWidth={0.6} />
      <rect x={102} y={72} width={8} height={7} rx={1} fill="var(--surface)" stroke={ACCENT} strokeWidth={0.6} />
      <text x={62} y={40} textAnchor="middle" fontSize={8} fontWeight={700} fill={ACCENT}>↑ ↓ ← → Z X</text>
    </g>
  ),
  mouse: (
    <g>
      <rect x={128} y={46} width={22} height={36} rx={11} fill={SOFT} stroke={ACCENT} strokeWidth={1.2} />
      <line x1={128} y1={60} x2={150} y2={60} stroke={ACCENT} strokeWidth={1} />
      <line x1={139} y1={46} x2={139} y2={60} stroke={ACCENT} strokeWidth={1} />
      <path d="M139 46 A11 11 0 0 0 128 57 L128 60 L139 60 Z" fill={ACCENT} opacity={0.55} />
      <rect x={137.5} y={50} width={3} height={7} rx={1.5} fill="var(--surface)" stroke={ACCENT} strokeWidth={0.6} />
      <polygon points="118,12 118,32 123,27 127,35 130,33.5 126,26 133,26" fill={ACCENT} stroke="var(--surface)" strokeWidth={0.8} />
    </g>
  ),
};

/** 手機外框 + 選定操作的疊圖。size = 寬度 px。 */
export function ControlGlyph({
  ids,
  size = 96,
  title,
  frame = 'phone',
}: {
  ids: string[];
  size?: number;
  title?: string;
  /** phone = 橫向手機外框;screen = 螢幕外框(網頁 / PC)。 */
  frame?: 'phone' | 'screen';
}) {
  const outerRx = frame === 'screen' ? 3 : 12;
  const innerRx = frame === 'screen' ? 1 : 6;
  return (
    <svg
      viewBox="-6 -6 172 102"
      width={size}
      height={(size * 102) / 172}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <rect x={-4} y={-4} width={168} height={98} rx={outerRx} fill="var(--surface-raised)" stroke="var(--border-strong, #999)" strokeWidth={2} />
      <rect x={0} y={0} width={160} height={90} rx={innerRx} fill="var(--surface)" stroke="var(--border)" strokeWidth={0.8} />
      {ids.map((id) => (
        <g key={id}>{GLYPHS[id] ?? null}</g>
      ))}
    </svg>
  );
}
