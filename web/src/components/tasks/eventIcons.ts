/**
 * 任務詳情共用的 icon / 顏色對照(時間軸、這一刻、執行軌跡一致)。
 * 顏色 = 誰決定這一步:紫 決策 Agent、藍 視覺、黃 照記憶、粉 測試人員;綠 = 記憶、紫羅蘭 = 腳本。
 */
import type { FeedKind } from './feed.ts';
import type { InfoIconName } from './InfoIcon.tsx';

export const DECIDER_ICON: Record<string, InfoIconName> = { agent: 'compass', vision: 'eye', reflex: 'bolt', operator: 'hand' };
export const SEAT_ICON: Record<string, InfoIconName> = { vlm: 'eye', agent: 'compass', subagent: 'tool' };
export const KIND_ICON: Record<FeedKind, InfoIconName> = { step: 'compass', ai: 'sparkle', memory: 'db', script: 'script', log: 'term', sound: 'volume', operator: 'msg' };
const MEMORY_ICON: Record<string, InfoIconName> = { reflex: 'bolt', new: 'sparkle', diverged: 'alert', no_effect: 'alert', hint: 'pin', route: 'route' };
const OTHER_ICON: Record<string, InfoIconName> = { goal: 'target', gesture: 'hand' };

/** 一筆事件的 icon(類別 + 類型)。 */
export function eventIcon(kind: FeedKind, sub: string): InfoIconName {
  if (kind === 'step') return DECIDER_ICON[sub] ?? 'compass';
  if (kind === 'ai') return SEAT_ICON[sub] ?? 'sparkle';
  if (kind === 'memory') return MEMORY_ICON[sub] ?? 'db';
  return OTHER_ICON[sub] ?? KIND_ICON[kind];
}

/**
 * 一筆事件的色調(CSS class `tone-…`):
 * agent / vision / reflex / operator / memory / warn / script / ai / log-E / log-W / log / sound。
 */
export function eventHue(kind: FeedKind, sub: string): string {
  if (kind === 'step') return DECIDER_ICON[sub] ? sub : 'agent';
  if (kind === 'ai') return sub === 'agent' ? 'agent' : sub === 'subagent' ? 'sound' : 'vision';
  if (kind === 'memory') return sub === 'reflex' ? 'reflex' : sub === 'diverged' || sub === 'no_effect' ? 'warn' : 'memory';
  if (kind === 'log') return sub === 'E' || sub === 'F' || sub === 'A' ? 'log-E' : sub === 'W' ? 'log-W' : 'log';
  if (kind === 'operator') return 'operator';
  return kind;
}

/** 記憶標籤的 icon(memoryChips 的 tone / 順序對應)。 */
export const MEMORY_CHIP_ICON: Record<string, InfoIconName> = { hit: 'db', info: 'db', warn: 'alert', new: 'sparkle' };
