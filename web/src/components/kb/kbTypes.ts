/** 知識庫前端型別(對齊後端 knowledgeBases.ts / report/profiles.ts TemplateDescriptor / report/reportSpec.ts)。 */
import type { Genre } from '../GenreIcon.tsx';

export interface L10n {
  zh: string;
  en: string;
}

export type KbKind = 'category' | 'scenario';

/** 類型樣板描述(內建知識庫附帶;global 樣板另由列表 API 回傳)。 */
export interface TemplateDescriptor {
  id: string;
  version: string;
  label: L10n;
  modules: Array<{ id: string; label: L10n; keywords: string[]; core: boolean }>;
  mechanics: Array<{ id: string; label: L10n }>;
  observe: Array<{ key: string; label: L10n; hint: string; type: string }>;
  metrics: Array<{ id: string; label: L10n; unit: string; source: string; group: string }>;
  charts: Array<{ id: string; title: L10n; type: string }>;
  riskRules: Array<{ id: string; title: L10n; level: string; metric: string; op: string; value: number | null; thresholdKey?: string }>;
  releaseRules: Array<{ id: string; reason: L10n; outcome: string; metric: string; op: string; value: number | null; thresholdKey?: string }>;
  specValues: Array<{ key: string; label: L10n; unit: string; hint: L10n }>;
  thresholds: Array<{ key: string; label: L10n; unit: string; default: number }>;
  sections: string[];
  scopes: string[];
}

export type ExcludeKey = 'metrics' | 'charts' | 'riskRules' | 'releaseRules' | 'observe' | 'modules' | 'mechanics';

/** 知識庫上儲存的報告規格(結構化)。 */
export interface ReportSpecInput {
  values?: Record<string, number>;
  thresholds?: Record<string, number>;
  modules?: Array<{ id: string; zh: string; en?: string; keywords?: string[]; core?: boolean }>;
  observe?: Array<{ key: string; zh: string; en?: string; hint?: string; type?: 'number' | 'string' | 'boolean' }>;
  scopes?: string[];
  exclude?: Partial<Record<ExcludeKey, string[]>>;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  kind: KbKind;
  genre?: Genre;
  markdown: string;
  builtin?: boolean;
  bedrockKbId?: string;
  version?: string;
  revision?: number;
  archived?: boolean;
  clonedFrom?: { id: string; name: string; version?: string; revision?: number };
  reportProfile?: TemplateDescriptor;
  reportSpec?: ReportSpecInput;
  /** 目前租戶的使用數(列表 API 附上)。 */
  usage?: { apps: number; jobs: number };
  createdAt: string;
  updatedAt?: string;
}

export interface KbUsage {
  apps: Array<{ appId: string; name: string }>;
  jobs: Array<{ jobId: string; appId?: string; createdAt?: string; state?: string }>;
  otherTenants: { apps: number; jobs: number };
  total: number;
}

export interface KbListResponse {
  items: KnowledgeBase[];
  globalTemplate?: TemplateDescriptor;
}

export const SCOPES = [
  'functional', 'gameplay', 'mechanics', 'ui', 'ux', 'graphics', 'animation', 'audio', 'performance',
  'compatibility', 'network', 'multiplayer', 'localization', 'save_load', 'account', 'economy', 'payment',
  'ai_behavior', 'physics', 'controller', 'level',
] as const;
