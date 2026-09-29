import type { ReactNode } from 'react';
import type { MessageKey } from '../i18n/messages.ts';

/**
 * 遊戲類型(genre)的內嵌 SVG 圖示集。
 * - 單色、吃 `currentColor`,可隨字級/主題縮放與變色。
 * - key 與後端 APP_GENRES 一致;label 走 i18n(genre.*)。
 * - 刻意用簡單線條(stroke)風格,小尺寸也清楚。
 */

/** 前端已知的遊戲類型 key(需與後端 APP_GENRES 對齊)。 */
export const GENRES = [
  'action',
  'adventure',
  'action_adventure',
  'rpg',
  'mmorpg',
  'strategy',
  'simulation',
  'shooter',
  'fighting',
  'platformer',
  'puzzle',
  'racing',
  'sports',
  'card',
  'board',
  'rhythm',
  'survival',
  'survivor',
  'roguelike',
  'battle_royale',
  'sandbox',
  'idle',
  'tower_defense',
  'moba',
  'slot',
  'casino',
  'bingo',
  'casual',
  'hyper_casual',
  'educational',
  'other',
] as const;

export type Genre = (typeof GENRES)[number];

/** genre key → i18n 標籤 key。 */
export function genreLabelKey(genre: Genre): MessageKey {
  return `genre.${genre}` as MessageKey;
}

/** 每個 genre 的 SVG path/內容(24×24 viewBox,線條為主)。 */
const PATHS: Record<Genre, ReactNode> = {
  // 動作:爆炸星芒
  action: (
    <path d="M12 2l2.4 5.6L20 6l-3 5 3 5-5.6-1.6L12 22l-2.4-6.6L4 16l3-5-3-5 5.6 1.6z" />
  ),
  // 冒險:羅盤
  adventure: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-2 4-4 2 2-4z" />
    </>
  ),
  // 動作冒險:劍 + 盾
  action_adventure: (
    <>
      <path d="M4 4l8 8" />
      <path d="M12 12l-2 2 2 2 2-2z" />
      <path d="M18 3c1 3 1 6 0 9-2-1-3-4-3-6z" />
    </>
  ),
  // RPG:魔法帽 / 星
  rpg: (
    <>
      <path d="M12 3l3 9H9z" />
      <path d="M7 12h10l-1 3H8z" />
      <path d="M6 18h12" />
    </>
  ),
  // MMORPG:多人(三個節點連線)
  mmorpg: (
    <>
      <circle cx="6" cy="8" r="2" />
      <circle cx="18" cy="8" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M7.5 9.5l3.5 6M16.5 9.5l-3.5 6M8 8h8" />
    </>
  ),
  // 策略:棋子(西洋棋馬簡化)
  strategy: (
    <>
      <path d="M8 20h8" />
      <path d="M9 20c0-4 1-6 3-8 1-1 1-2-1-3-2 1-3 3-4 3l1-4 5-1c3 1 4 5 4 9" />
    </>
  ),
  // 模擬:齒輪
  simulation: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
    </>
  ),
  // 射擊:準星
  shooter: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),
  // 格鬥:拳頭
  fighting: (
    <>
      <path d="M6 11V8a1.5 1.5 0 013 0v2" />
      <path d="M9 10V7a1.5 1.5 0 013 0v3" />
      <path d="M12 10V8a1.5 1.5 0 013 0v3" />
      <path d="M15 11c1-1 3-1 3 1v2a5 5 0 01-5 5H10a4 4 0 01-4-4v-3" />
    </>
  ),
  // 平台跳躍:階梯 + 角色點
  platformer: (
    <>
      <path d="M3 20h5v-4h5v-4h5V8" />
      <circle cx="6" cy="13" r="1.5" />
    </>
  ),
  // 益智/消除:拼圖片
  puzzle: (
    <path d="M10 4h4v2a2 2 0 004 0V4h2v4h-2a2 2 0 000 4h2v4h-4v-2a2 2 0 00-4 0v2H6v-4h2a2 2 0 000-4H6V4z" />
  ),
  // 競速:方格旗
  racing: (
    <>
      <path d="M5 3v18" />
      <path d="M7 5h4v4H7zM11 9h4v4h-4zM15 5h4v4h-4zM7 9h0M11 5h4V5" />
      <path d="M7 5h4v4H7zM15 5h4v4h-4zM11 9h4v4h-4z" />
    </>
  ),
  // 運動:球
  sports: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v18M3 12h18M6 6c3 2 9 2 12 0M6 18c3-2 9-2 12 0" />
    </>
  ),
  // 卡牌:兩張疊牌
  card: (
    <>
      <rect x="7" y="5" width="9" height="13" rx="1.5" />
      <path d="M10 3h7a1.5 1.5 0 011.5 1.5V15" />
    </>
  ),
  // 桌遊:骰子
  board: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <circle cx="9" cy="9" r="1" />
      <circle cx="15" cy="9" r="1" />
      <circle cx="9" cy="15" r="1" />
      <circle cx="15" cy="15" r="1" />
    </>
  ),
  // 節奏/音樂:音符
  rhythm: (
    <>
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="16" r="2" />
      <path d="M9 18V6l10-2v12" />
    </>
  ),
  // 生存:營火
  survival: (
    <>
      <path d="M12 3c2 3 4 4 4 8a4 4 0 01-8 0c0-2 1-3 2-4 0 1 1 2 2 2 1-2-1-4 0-6z" />
      <path d="M6 21l12 0M8 18l8 3M16 18l-8 3" />
    </>
  ),
  // 倖存者/割草:鐮刀劃過(移動即戰鬥)
  survivor: (
    <>
      <path d="M4 20c6 0 12-4 15-11" />
      <path d="M19 9a5 5 0 00-9-2" />
      <circle cx="6" cy="18" r="1.5" />
    </>
  ),
  // Roguelike:地城入口(拱門 + 骷髏點)
  roguelike: (
    <>
      <path d="M5 21V10a7 7 0 0114 0v11" />
      <path d="M9 21v-5a3 3 0 016 0v5" />
      <circle cx="12" cy="9" r="0.5" />
    </>
  ),
  // 大逃殺:落傘圈
  battle_royale: (
    <>
      <path d="M4 10a8 8 0 0116 0" />
      <path d="M4 10l8 5 8-5M12 15v5" />
      <path d="M9 20h6" />
    </>
  ),
  // 沙盒/開放世界:方塊(積木)
  sandbox: (
    <>
      <path d="M12 3l8 4-8 4-8-4z" />
      <path d="M4 7v8l8 4V11z" />
      <path d="M20 7v8l-8 4V11z" />
    </>
  ),
  // 放置/掛機:時鐘 + 累加
  idle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  // 塔防:城塔
  tower_defense: (
    <>
      <path d="M6 21V9l2-2 2 2 2-2 2 2 2-2 2 2v12z" />
      <path d="M6 9h12" />
      <path d="M10 21v-4h4v4" />
    </>
  ),
  // MOBA:三線交會
  moba: (
    <>
      <path d="M4 20L20 4" />
      <path d="M4 20h6M4 20v-6M20 4h-6M20 4v6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  // 拉霸/Slot:老虎機
  slot: (
    <>
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <path d="M8 6V4h8v2M9 10v4M12 10v4M15 10v4" />
      <path d="M20 9h2v4h-2" />
    </>
  ),
  // 賭場/Casino:撲克花色(黑桃)
  casino: (
    <>
      <path d="M12 3c3 4 7 6 7 10a4 4 0 01-6 3c0 2 1 3 2 4H9c1-1 2-2 2-4a4 4 0 01-6-3c0-4 4-6 7-10z" />
    </>
  ),
  // 賓果:網格 + 球
  bingo: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 9h16M4 15h16M9 4v16M15 4v16" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),
  // 休閒:笑臉
  casual: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 10h.01M15 10h.01M8.5 14a4 4 0 007 0" />
    </>
  ),
  // 超休閒:單指點擊
  hyper_casual: (
    <>
      <circle cx="12" cy="8" r="3" />
      <path d="M12 11v7M9 14h6" />
    </>
  ),
  // 教育:學士帽
  educational: (
    <>
      <path d="M3 9l9-4 9 4-9 4z" />
      <path d="M7 11v4c0 1 2.5 2 5 2s5-1 5-2v-4" />
      <path d="M21 9v5" />
    </>
  ),
  // 其他:標籤
  other: (
    <>
      <path d="M4 4h8l8 8-8 8-8-8z" />
      <circle cx="8" cy="8" r="1.2" />
    </>
  ),
};

export interface GenreIconProps {
  genre: Genre;
  /** 尺寸(px),預設 18。 */
  size?: number;
  className?: string;
}

/** 依 genre 顯示對應 SVG 圖示。未知 genre 退回 other。 */
export default function GenreIcon({ genre, size = 18, className }: GenreIconProps) {
  const content = PATHS[genre] ?? PATHS.other;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {content}
    </svg>
  );
}
