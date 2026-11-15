import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CATALOGS, LOCALES } from './messages.ts';

describe('navigation labels and page titles', () => {
  test.each(LOCALES)('%s: the Devices nav label, page title and in-page heading are the same string', (loc) => {
    const c = CATALOGS[loc];
    expect(c['devices.title']).toBe(c['nav.devices']);
    expect(c['page.devices.title']).toBe(c['nav.devices']);
  });
});

describe('every nav label equals its page title', () => {
  const pairs = ['apps', 'cases', 'tasks', 'reports', 'devices', 'knowledge', 'memory', 'cost'] as const;
  test.each(LOCALES)('%s', (loc) => {
    const c = CATALOGS[loc] as Record<string, string>;
    for (const p of pairs) {
      const title = c[`page.${p}.title`];
      if (title !== undefined) expect(title, `${loc} page.${p}.title`).toBe(c[`nav.${p}`]);
    }
  });
});

describe('members password Copy button', () => {
  test.each(LOCALES)('%s: members.copy exists and is not the English fallback outside en', (loc) => {
    const copy = CATALOGS[loc]['members.copy'];
    expect(copy).toBeTruthy();
    if (loc !== 'en') expect(copy).not.toBe(CATALOGS.en['members.copy']);
  });

  test('MembersPage renders the Copy label from the catalog, not a literal', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'MembersPage.tsx'), 'utf8');
    expect(src).not.toMatch(/['"]Copy['"]/);
    expect(src).toContain("t('members.copy')");
  });
});
