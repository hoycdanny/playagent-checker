import { describe, expect, it } from 'vitest';
import { buildContextPayload } from '../lambda/engine/contextPayload.js';

const base = {
  appId: 'a',
  locality: 'cloud' as const,
  hasKnowledge: false,
  hasMemory: false,
  hasKnowledgeBases: false,
  hasKbReferences: false,
  credentialKeys: [],
  knowledgeBaseIds: [],
  context: '',
  vlmCoordSystem: 'pixel',
  assembledAt: '2025-01-01T00:00:00.000Z',
};

describe('buildContextPayload locale', () => {
  it.each(['ja', 'ko', 'en', 'zh-Hans'])('includes %s', (locale) => {
    expect(buildContextPayload({ ...base, locale })['locale']).toBe(locale);
  });

  it('omits zh-Hant and absent locale', () => {
    expect('locale' in buildContextPayload({ ...base, locale: 'zh-Hant' })).toBe(false);
    expect('locale' in buildContextPayload(base)).toBe(false);
  });

  it('keeps the legacy payload identical without a locale', () => {
    expect(Object.keys(buildContextPayload(base))).toEqual([
      'appId', 'locality', 'hasKnowledge', 'hasMemory', 'hasKnowledgeBases', 'hasKbReferences',
      'credentialKeys', 'knowledgeBaseIds', 'context', 'vlmCoordSystem', 'assembledAt',
    ]);
  });
});
