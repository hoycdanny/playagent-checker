import { describe, expect, it } from 'vitest';
import { GEN_LOCALES, LANG_NAME, cacheSuffix, parseGenLocale } from '../lambda/api/genLocale.js';

describe('genLocale', () => {
  it('parses the five locales and the legacy zh', () => {
    for (const l of GEN_LOCALES) expect(parseGenLocale(l, 'en')).toBe(l);
    expect(parseGenLocale('zh', 'en')).toBe('zh-Hant');
  });

  it('falls back for unknown or non-string values', () => {
    expect(parseGenLocale('xx', 'zh-Hant')).toBe('zh-Hant');
    expect(parseGenLocale(undefined, 'en')).toBe('en');
    expect(parseGenLocale(5, 'ko')).toBe('ko');
  });

  it('names every locale natively', () => {
    expect(LANG_NAME['zh-Hant']).toBe('繁體中文');
    for (const l of GEN_LOCALES) expect(LANG_NAME[l].length).toBeGreaterThan(0);
  });

  it('keeps the legacy cache suffixes', () => {
    expect(cacheSuffix('zh-Hant')).toBe('zh');
    expect(cacheSuffix('en')).toBe('en');
    expect(cacheSuffix('zh-Hans')).toBe('zh-Hans');
    expect(cacheSuffix('ja')).toBe('ja');
    expect(cacheSuffix('ko')).toBe('ko');
  });
});
