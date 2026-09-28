import { describe, test, expect } from 'vitest';
import {
  CATALOGS,
  PRIMARY_LOCALES,
  type MessageKey,
} from './messages.ts';

describe('i18n 目錄完整性', () => {
  const baseKeys = Object.keys(CATALOGS['zh-Hant']) as MessageKey[];

  test('一級語系(zh-Hant / en)key 齊備且非空', () => {
    for (const locale of PRIMARY_LOCALES) {
      const catalog = CATALOGS[locale];
      for (const key of baseKeys) {
        expect(catalog[key], `${locale} 缺 key ${key}`).toBeTruthy();
      }
    }
  });

  test('所有語系不含基準集以外的多餘 key', () => {
    const baseSet = new Set(baseKeys);
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const key of Object.keys(catalog)) {
        expect(baseSet.has(key as MessageKey), `${locale} 多出 key ${key}`).toBe(
          true,
        );
      }
    }
  });
});
