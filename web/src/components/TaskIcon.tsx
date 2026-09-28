import type { ReactNode } from 'react';
import './TaskIcon.css';

/**
 * 任務列表用小圖示 + 即時 tooltip 說明。
 * - 圖示全為原創單色 SVG(吃 currentColor),非任何第三方商標/官方 logo。
 * - tooltip 用 CSS(hover/focus 顯示),比原生 title 更即時、位置可控,且說明「此圖示代表什麼」。
 * - 可鍵盤 focus(tabIndex=0)以利無障礙;aria-label 同步 tooltip 文字。
 */

/** 環境(backend)圖示集。 */
const BACKEND_MARK: Record<string, ReactNode> = {
  // 真機:手機外框 + Home 鍵
  devicefarm: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <line x1="10.5" y1="18.6" x2="13.5" y2="18.6" />
    </>
  ),
  // web / Lambda:無伺服器函數,以 λ 折線表示
  web: (
    <>
      <path d="M7 19c2.2 0 2.9-1.5 3.8-3.9L13 8" />
      <path d="M10 12l4.5 7" />
    </>
  ),
  emulator: (
    <>
      <rect x="3.5" y="4.5" width="17" height="11" rx="1.5" />
      <path d="M9 19.5h6M12 15.5v4" />
    </>
  ),
  windows: (
    <>
      <rect x="4" y="4.5" width="16" height="15" rx="1.5" />
      <path d="M4 9.5h16M12 9.5v10" />
    </>
  ),
  attached: (
    <>
      <rect x="8" y="3" width="9" height="14" rx="2" />
      <path d="M12.5 20v-3M4.5 20h16" />
    </>
  ),
};

/** 位置(locality)圖示集。 */
const LOCALITY_MARK: Record<string, ReactNode> = {
  cloud: <path d="M7 17.5h9a3.4 3.4 0 0 0 .3-6.8A4.9 4.9 0 0 0 6.7 9.6 3.4 3.4 0 0 0 7 17.5z" />,
  attached: (
    <>
      <rect x="4.5" y="5" width="15" height="9.5" rx="1.5" />
      <path d="M8.5 19h7M12 14.5v4.5" />
    </>
  ),
};

/** 狀態(state)圖示集。全為原創單色 SVG,吃 currentColor(顏色由外層 task-state--* 類別決定)。 */
const STATE_MARK: Record<string, ReactNode> = {
  // 排隊中:時鐘
  queued: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  // 執行中:旋轉箭頭(進行中)
  running: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v3.5h-3.5" />
    </>
  ),
  // 通過:打勾圓圈
  pass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8 12.2l2.6 2.6L16 9.4" />
    </>
  ),
  // 失敗:叉叉圓圈
  fail: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  // 錯誤:警示三角形 + 驚嘆號
  error: (
    <>
      <path d="M12 3.5 21 19H3z" />
      <path d="M12 10v4M12 16.5v.5" />
    </>
  ),
  // 已取消:禁止符號
  cancelled: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6.5 6.5l11 11" />
    </>
  ),
  // 超出預算:錢幣 + 驚嘆
  budget_exceeded: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5M12 15.5v.5" />
    </>
  ),
  // 逾時中斷:時鐘 + 斜線
  dead: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l2.5 1.8M6.5 6.5l11 11" />
    </>
  ),
};

export type TaskIconKind = 'backend' | 'locality' | 'state';

export interface TaskIconProps {
  kind: TaskIconKind;
  value: string;
  /** tooltip 與 aria-label 文字(說明此圖示代表什麼)。 */
  label: string;
  size?: number;
}

/** 依 kind/value 顯示對應原創 SVG 小圖示,hover/focus 顯示 label tooltip。 */
export default function TaskIcon({ kind, value, label, size = 18 }: TaskIconProps) {
  const set = kind === 'backend' ? BACKEND_MARK : kind === 'locality' ? LOCALITY_MARK : STATE_MARK;
  const fallback = kind === 'backend' ? 'web' : kind === 'locality' ? 'cloud' : 'queued';
  const content = set[value] ?? set[fallback];
  return (
    <span className="taskicon" tabIndex={0} aria-label={label}>
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {content}
      </svg>
      <span className="taskicon__tip" role="tooltip">
        {label}
      </span>
    </span>
  );
}
