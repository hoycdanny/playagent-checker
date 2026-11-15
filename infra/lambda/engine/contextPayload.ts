import type { Locality } from '../api/knowledge.js';

/** zh-Hant 或未設定 = 既有行為,不寫入 context.json。 */
export function contextLocale(locale?: string): string | undefined {
  return locale && locale !== 'zh-Hant' ? locale : undefined;
}

/** context.json 內容(純函式);locale 只在非 zh-Hant 時帶入,其餘與舊版逐位元相同。 */
export function buildContextPayload(p: {
  appId: string;
  locality: Locality;
  hasKnowledge: boolean;
  hasMemory: boolean;
  hasKnowledgeBases: boolean;
  hasKbReferences: boolean;
  credentialKeys: string[];
  knowledgeBaseIds: string[];
  context: string;
  evidence?: unknown;
  controls?: unknown;
  scripted?: boolean;
  vlmCoordSystem: string;
  locale?: string;
  assembledAt: string;
}): Record<string, unknown> {
  const outLocale = contextLocale(p.locale);
  return {
    appId: p.appId,
    locality: p.locality,
    hasKnowledge: p.hasKnowledge,
    hasMemory: p.hasMemory,
    hasKnowledgeBases: p.hasKnowledgeBases,
    hasKbReferences: p.hasKbReferences,
    credentialKeys: p.credentialKeys,
    knowledgeBaseIds: p.knowledgeBaseIds,
    context: p.context,
    ...(p.evidence ? { evidence: p.evidence } : {}),
    ...(p.controls ? { controls: p.controls } : {}),
    ...(p.scripted ? { scripted: true } : {}),
    vlmCoordSystem: p.vlmCoordSystem,
    ...(outLocale ? { locale: outLocale } : {}),
    assembledAt: p.assembledAt,
  };
}
