import { afterEach, describe, expect, test } from 'vitest';
import { CATALOGS } from './messages.ts';
import { tStatic } from './tStatic.ts';

describe('tStatic', () => {
  afterEach(() => localStorage.removeItem('playagent.locale'));

  test.each(['zh-Hant', 'en', 'zh-Hans', 'ja', 'ko'] as const)('reads the stored locale %s', (loc) => {
    localStorage.setItem('playagent.locale', loc);
    expect(tStatic('error.apiNotConfigured')).toBe(CATALOGS[loc]['error.apiNotConfigured']);
  });

  test('locales differ for the same key', () => {
    localStorage.setItem('playagent.locale', 'en');
    const en = tStatic('error.apiNotConfigured');
    localStorage.setItem('playagent.locale', 'ja');
    expect(tStatic('error.apiNotConfigured')).not.toBe(en);
  });
});
