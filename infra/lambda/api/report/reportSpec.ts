/**
 * 知識庫的「報告規格」(客戶可設定,由知識庫引導報告內容)。
 *
 * 兩種來源(可並存,後者覆寫前者):
 *  1. 知識庫記錄的結構化欄位 `reportSpec`(知識庫頁的規格編輯器寫入,建議用這個)。
 *  2. Markdown 內的 ```playagent-report JSON 區塊(相容舊用法;注入 agent 前會被移除)。
 *
 * 格式(ReportSpecInput):
 * {
 *   "values":     { "expectedRtp": 96.5, "minBet": 100 },            // 規格值:AI 不得自行假設,只能由此提供
 *   "thresholds": { "rtpTolerancePp": 1.5, "minModuleCoverage": 50 },  // 覆寫放行/風險門檻(未填 = 平台預設)
 *   "modules":    [{ "id": "vip", "zh": "VIP 中心", "en": "VIP Center", "keywords": ["vip"], "core": false }],
 *   "observe":    [{ "key": "jackpot", "zh": "彩金池", "en": "Jackpot Pool", "hint": "彩金池金額", "type": "number" }],
 *   "scopes":     ["payment", "localization"],
 *   "exclude":    { "releaseRules": ["rtp_deviation"], "observe": ["bonus"] }  // 停用繼承自類型樣板的項目
 * }
 */
import type { ModuleDef, ObserveDef, ReportSpec, SpecExclude, TestScopeId } from './types.js';

const BLOCK_RE = /```playagent-report\s*\n([\s\S]*?)```/g;

export const SCOPES: readonly TestScopeId[] = [
  'functional', 'gameplay', 'mechanics', 'ui', 'ux', 'graphics', 'animation', 'audio', 'performance',
  'compatibility', 'network', 'multiplayer', 'localization', 'save_load', 'account', 'economy', 'payment',
  'ai_behavior', 'physics', 'controller', 'level',
];
const SAFE_ID = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
const EXCLUDE_KEYS = ['metrics', 'charts', 'riskRules', 'releaseRules', 'observe', 'modules', 'mechanics'] as const;
const MAX_ITEMS = 40;

/** 儲存在知識庫記錄上的規格(JSON 友善、前端編輯器直接讀寫)。 */
export interface ReportSpecInput {
  values?: Record<string, number>;
  thresholds?: Record<string, number>;
  modules?: Array<{ id: string; zh: string; en?: string; keywords?: string[]; core?: boolean }>;
  observe?: Array<{ key: string; zh: string; en?: string; hint?: string; type?: 'number' | 'string' | 'boolean' }>;
  scopes?: TestScopeId[];
  exclude?: Partial<Record<(typeof EXCLUDE_KEYS)[number], string[]>>;
}

export class SpecValidationError extends Error {}

export function emptySpec(): ReportSpec {
  return { values: {}, thresholds: {}, modules: [], observe: [], scopes: [], exclude: {}, sources: [] };
}

/** 移除 playagent-report 區塊(注入 agent 前用)。 */
export function stripReportSpec(markdown: string): string {
  return markdown.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function numMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!SAFE_ID.test(k)) continue;
    if (raw === null || raw === '' || raw === undefined) continue; // 空 = 未設定(用平台預設 / 不計算)
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function str(v: unknown, max = 80): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** 清洗任意輸入成合法 ReportSpecInput(丟棄不合法項目;不丟錯,除非整體型別錯)。 */
export function sanitizeSpecInput(raw: unknown): ReportSpecInput {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new SpecValidationError('reportSpec 必須是物件');
  const o = raw as Record<string, unknown>;
  const out: ReportSpecInput = {};
  const values = numMap(o['values']);
  if (Object.keys(values).length) out.values = values;
  const thresholds = numMap(o['thresholds']);
  if (Object.keys(thresholds).length) out.thresholds = thresholds;
  if (Array.isArray(o['modules'])) {
    const mods: NonNullable<ReportSpecInput['modules']> = [];
    for (const r of (o['modules'] as unknown[]).slice(0, MAX_ITEMS)) {
      const m = r as Record<string, unknown>;
      const id = str(m?.['id'], 40);
      if (!id || !SAFE_ID.test(id) || mods.some((x) => x.id === id)) continue;
      const zh = str(m['zh']) ?? id;
      const en = str(m['en']);
      const keywords = Array.isArray(m['keywords'])
        ? (m['keywords'] as unknown[]).map((k) => str(k, 40)?.toLowerCase()).filter((k): k is string => !!k).slice(0, 12)
        : typeof m['keywords'] === 'string'
          ? (m['keywords'] as string).split(/[,，、]/).map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 12)
          : [];
      mods.push({ id, zh, ...(en ? { en } : {}), keywords, ...(m['core'] === true ? { core: true } : {}) });
    }
    if (mods.length) out.modules = mods;
  }
  if (Array.isArray(o['observe'])) {
    const obs: NonNullable<ReportSpecInput['observe']> = [];
    for (const r of (o['observe'] as unknown[]).slice(0, MAX_ITEMS)) {
      const m = r as Record<string, unknown>;
      const key = str(m?.['key'], 40);
      if (!key || !SAFE_ID.test(key) || obs.some((x) => x.key === key)) continue;
      const t = m['type'];
      const en = str(m['en']);
      const hint = str(m['hint'], 120);
      obs.push({
        key,
        zh: str(m['zh']) ?? key,
        ...(en ? { en } : {}),
        ...(hint ? { hint } : {}),
        type: t === 'string' || t === 'boolean' ? t : 'number',
      });
    }
    if (obs.length) out.observe = obs;
  }
  if (Array.isArray(o['scopes'])) {
    const scopes = [...new Set((o['scopes'] as unknown[]).filter((s): s is TestScopeId => typeof s === 'string' && (SCOPES as readonly string[]).includes(s)))];
    if (scopes.length) out.scopes = scopes;
  }
  if (o['exclude'] && typeof o['exclude'] === 'object' && !Array.isArray(o['exclude'])) {
    const ex: NonNullable<ReportSpecInput['exclude']> = {};
    for (const k of EXCLUDE_KEYS) {
      const list = (o['exclude'] as Record<string, unknown>)[k];
      if (!Array.isArray(list)) continue;
      const ids = [...new Set(list.filter((x): x is string => typeof x === 'string' && SAFE_ID.test(x)))].slice(0, 200);
      if (ids.length) ex[k] = ids;
    }
    if (Object.keys(ex).length) out.exclude = ex;
  }
  return out;
}

/** ReportSpecInput → 引擎用的 ReportSpec。 */
export function specFromInput(input: ReportSpecInput, sourceId: string): ReportSpec {
  const clean = sanitizeSpecInput(input);
  const spec = emptySpec();
  Object.assign(spec.values, clean.values ?? {});
  Object.assign(spec.thresholds, clean.thresholds ?? {});
  spec.modules = (clean.modules ?? []).map((m): ModuleDef => ({
    id: m.id,
    label: { zh: m.zh, en: m.en ?? m.zh },
    keywords: m.keywords ?? [],
    ...(m.core ? { core: true } : {}),
  }));
  spec.observe = (clean.observe ?? []).map((o): ObserveDef => ({
    key: o.key,
    label: { zh: o.zh, en: o.en ?? o.zh },
    hint: o.hint ?? o.zh,
    type: o.type ?? 'number',
  }));
  spec.scopes = clean.scopes ?? [];
  spec.exclude = { ...(clean.exclude ?? {}) };
  const hasContent =
    Object.keys(spec.values).length || Object.keys(spec.thresholds).length || spec.modules.length ||
    spec.observe.length || spec.scopes.length || Object.keys(spec.exclude).length;
  if (hasContent) spec.sources.push(sourceId);
  return spec;
}

/** 解析單一 Markdown 中的所有規格區塊;格式錯誤的區塊略過(不擋報告)。 */
export function parseReportSpec(markdown: string, sourceId: string): ReportSpec {
  const specs: ReportSpec[] = [];
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(markdown)) !== null) {
    try {
      const parsed = JSON.parse(m[1] ?? '');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      specs.push(specFromInput(parsed as ReportSpecInput, sourceId));
    } catch {
      continue;
    }
  }
  return mergeSpecs(specs);
}

/** 一座知識庫的完整規格:Markdown 區塊(舊)+ 結構化欄位(新,優先)。 */
export function specFromKb(kb: { id: string; markdown?: string; reportSpec?: unknown }): ReportSpec {
  const fromMd = parseReportSpec(kb.markdown ?? '', kb.id);
  let fromField = emptySpec();
  try {
    if (kb.reportSpec) fromField = specFromInput(kb.reportSpec as ReportSpecInput, kb.id);
  } catch {
    /* 壞資料不擋報告 */
  }
  return mergeSpecs([fromMd, fromField]);
}

/** 合併多座知識庫的規格(後者覆寫前者的同名 value/threshold;清單類以 id 去重,後者覆寫)。 */
export function mergeSpecs(specs: ReportSpec[]): ReportSpec {
  const out = emptySpec();
  for (const s of specs) {
    Object.assign(out.values, s.values);
    Object.assign(out.thresholds, s.thresholds);
    for (const m of s.modules) out.modules = [...out.modules.filter((x) => x.id !== m.id), m];
    for (const o of s.observe) out.observe = [...out.observe.filter((x) => x.key !== o.key), o];
    out.scopes = [...new Set([...out.scopes, ...s.scopes])];
    for (const [k, ids] of Object.entries(s.exclude ?? {}) as Array<[keyof SpecExclude, string[]]>) {
      out.exclude[k] = [...new Set([...(out.exclude[k] ?? []), ...ids])];
    }
    for (const src of s.sources) if (!out.sources.includes(src)) out.sources.push(src);
  }
  return out;
}
