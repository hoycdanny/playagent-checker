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
}
export function edgeKey(e: EdgeLike): string;
export function applyEdits<T>(struct: T, edits: EditsLike | null | undefined, opts?: { renames?: boolean }): T;
export function sameScreen(a: string | undefined, b: string | undefined): boolean;
export function hintsPromptSection(hints: HintLike[], pageName?: (id: string) => string, maxChars?: number): string;
export function screenHintsFor<T extends HintLike>(hints: T[], ctx?: { screen?: string; pageId?: string }): T[];
export function operatorTurnNote(newCmds: Array<{ id: string; text: string }>, activeCmds: Array<{ id: string; text: string }>): string;
export function commandIdsFromKeys(keys: string[], prefix: string): string[];
export const POINT_ONLY_TEXT: string;
export function validPoint(p: unknown): { x: number; y: number } | null;

/** runner 端:S3 指令通道(cmds = AWS SDK Command 建構子)。 */
export interface OperatorCmd { id: string; text: string; hintId?: string; point?: { x: number; y: number } }
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
