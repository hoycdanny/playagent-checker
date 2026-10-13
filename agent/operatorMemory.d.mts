/** 型別宣告:agent/operatorMemory.mjs(infra Lambda 也會引用)。 */
export interface EdgeLike {
  fromPageId: string;
  toPageId: string;
  trigger?: { kind?: string; target?: string; label?: string };
}
export interface HintLike {
  id?: string;
  text: string;
  pageId?: string;
  screen?: string;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}
export interface EditsLike {
  renames?: Record<string, string>;
  deletedPages?: string[];
  deletedEdges?: string[];
  positions?: Record<string, { x: number; y: number }>;
  addedEdges?: EdgeLike[];
  merges?: Record<string, string>;
  routes?: RouteLike[];
}
export function edgeKey(e: EdgeLike): string;
/** renames:false = 不套改名;addedEdges:false = 不加入手動路徑(runner 用,避免寫回 structure.json)。 */
export function applyEdits<T>(struct: T, edits: EditsLike | null | undefined, opts?: { renames?: boolean; addedEdges?: boolean }): T;
export function sameScreen(a: string | undefined, b: string | undefined): boolean;
export interface RouteLike {
  id: string;
  name: string;
  enabled?: boolean;
  steps: Array<{ id: string; pageId: string; action?: string }>;
  branches?: Array<{ id: string; fromStepId: string; pageId: string; action?: string; returnStepId?: string }>;
}
export function routesPromptSection(routes: RouteLike[] | undefined, pageName?: (id: string) => string, maxChars?: number): string;
export function routeTurnNote(routes: RouteLike[] | undefined, pageId: string | null | undefined, pageName?: (id: string) => string): string;
export function hintsPromptSection(hints: HintLike[], pageName?: (id: string) => string, maxChars?: number): string;
export function screenHintsFor<T extends HintLike>(hints: T[], ctx?: { screen?: string; pageId?: string }): T[];
export function operatorTurnNote(newCmds: Array<{ id: string; text: string }>, activeCmds: Array<{ id: string; text: string }>): string;
export function commandIdsFromKeys(keys: string[], prefix: string): string[];
export const POINT_ONLY_TEXT: string;
export const DRAG_ONLY_TEXT: string;
export const DRAG_MS_MIN: number;
export const DRAG_MS_MAX: number;
export const DRAG_MS_DEFAULT: number;
export const DRAG_PRESS_MS: number;
export function validPoint(p: unknown): { x: number; y: number } | null;
export function validDragMs(v: unknown): number;
/** 手勢 → 截圖空間動作:有 to → swipe(拖曳);只有 point → tap;沒有手勢 → null。 */
export function operatorGestureCmd(
  c: { point?: { x: number; y: number }; to?: { x: number; y: number }; dragMs?: number } | null | undefined,
  cw: number,
  ch: number,
):
  | { action: 'tap'; x: number; y: number; operatorTap: true }
  | { action: 'swipe'; x: number; y: number; x2: number; y2: number; durationMs: number; pressMs: number; endHoldMs: number; operatorTap: true; operatorDrag: true }
  | null;

/** runner 端:S3 指令通道(cmds = AWS SDK Command 建構子)。 */
export interface OperatorCmd {
  id: string;
  text: string;
  hintId?: string;
  point?: { x: number; y: number };
  /** 拖曳終點(有就代表「從 point 拖到 to」)。 */
  to?: { x: number; y: number };
  dragMs?: number;
}
export interface S3CommandCtors {
  ListObjectsV2Command?: new (input: any) => any;
  GetObjectCommand: new (input: any) => any;
  PutObjectCommand?: new (input: any) => any;
}
export function createOperatorChannel(opts: {
  s3: { send: (cmd: any) => Promise<any> };
  bucket: string;
  jobPrefix: string;
  cmds: S3CommandCtors;
}): {
  active: OperatorCmd[];
  poll(): Promise<OperatorCmd[]>;
  ack(cmd: OperatorCmd, info: Record<string, unknown>): Promise<void>;
};
export function loadAppMemory(opts: {
  s3: { send: (cmd: any) => Promise<any> };
  bucket: string;
  memPrefix: string;
  cmds: S3CommandCtors;
}): Promise<{ hints: (HintLike & Record<string, unknown>)[]; edits: EditsLike | null }>;
