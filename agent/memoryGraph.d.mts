/** 型別宣告:agent/memoryGraph.mjs(infra Lambda 也會引用)。 */
export interface GraphPage {
  id: string;
  name: string;
  canonical?: string;
  module?: string;
  transient?: boolean;
  pHash: string;
  pHashes?: string[];
  aliases?: Record<string, number>;
  screenshotRef: string;
  knownControlLabels: string[];
  visitCount: number;
  hitCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}
export interface GraphEdge {
  fromPageId: string;
  toPageId: string;
  trigger: { kind: string; label?: string; target?: string };
  hitCount: number;
  missCount: number;
}
export interface GraphStructure {
  schemaVersion: number;
  appName: string;
  rootPageId: string | null;
  pages: Record<string, GraphPage>;
  edges: GraphEdge[];
  lastUpdatedAt: string | null;
}
export declare const GRAPH_SCHEMA_VERSION: number;
export declare const TRANSIENT_NAME: string;
export declare function hamming(a: string, b: string): number;
export declare function canonicalName(name: string | undefined | null): string;
export declare function isPlaceholderName(name: string | undefined | null): boolean;
export declare function emptyStructure(appName?: string): GraphStructure;
export declare function upsertPage(
  struct: GraphStructure,
  frame: { name?: string; pHash?: string | null; module?: string; at?: string },
): { pageId: string; isNew: boolean };
export declare function recordTransition(
  struct: GraphStructure,
  fromId: string | null,
  toId: string | null,
  opts?: { action?: string; target?: string },
): void;
export declare function recordMiss(struct: GraphStructure, pageId: string, opts?: { action?: string; target?: string }): void;
export declare function compactStructure(input: unknown): GraphStructure;
export declare function summarizeForAgent(struct: unknown, maxChars?: number): string;
