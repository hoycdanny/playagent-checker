/**
 * Shape of every 5-locale table.
 *
 * 1. The exported tables of report/reportText.ts: each entry has five non-empty values whose
 *    `{name}` placeholders agree across zh-Hant, en, zh-Hans, ja and ko.
 * 2. Every 5-string array literal that contains CJK anywhere in web/src (the same tuples the
 *    hardcoded-CJK guard exempts): same two rules, so a table cannot ship with a missing
 *    translation or a placeholder that one locale dropped.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CATEGORY_TEXT, DIMENSION_TEXT, SCOPE_TEXT, STATUS_TEXT, T, tr } from '../components/report/reportText.ts';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// `${name}` is a template expression whose variable name is localised in some tables; only `{name}` counts.
const PLACEHOLDER = /(?<!\$)\{[A-Za-z_][A-Za-z0-9_]*\}/g;

function placeholders(s: string): string {
  return (s.match(PLACEHOLDER) ?? []).sort().join(',');
}

function problems(key: string, v: readonly string[]): string[] {
  const out: string[] = [];
  if (v.length !== 5) out.push(`${key}: ${v.length} values, expected 5`);
  v.forEach((s, i) => {
    // Only English may be empty: a suffix such as the Chinese 步 that English does not need.
    if (typeof s !== 'string' || (s.trim() === '' && i !== 1)) out.push(`${key}: value #${i} is empty`);
  });
  const want = placeholders(v[0] ?? '');
  v.forEach((s, i) => {
    if (placeholders(s ?? '') !== want) out.push(`${key}: value #${i} placeholders [${placeholders(s ?? '')}] differ from zh-Hant [${want}]`);
  });
  return out;
}

describe('reportText tables', () => {
  const tables: Record<string, Record<string, readonly string[]>> = {
    T,
    STATUS_TEXT,
    DIMENSION_TEXT,
    SCOPE_TEXT,
    CATEGORY_TEXT,
  };
  for (const [name, table] of Object.entries(tables)) {
    it(`${name}: every entry has five non-empty values with matching placeholders`, () => {
      const keys = Object.keys(table);
      expect(keys.length).toBeGreaterThan(5);
      const bad = keys.flatMap((k) => problems(`${name}.${k}`, table[k]!));
      expect(bad.join('\n')).toBe('');
    });
  }

  it('T is large enough to prove the loop is not vacuous', () => {
    expect(Object.keys(T).length).toBeGreaterThan(300);
  });

  it('tr() maps the five locales: zh-Hant / zh-Hans read zh, ja / ko read en for backend data', () => {
    const data = { zh: '中', en: 'EN' };
    expect(tr(data, 'zh-Hant')).toBe('中');
    expect(tr(data, 'zh-Hans')).toBe('中');
    expect(tr(data, 'en')).toBe('EN');
    expect(tr(data, 'ja')).toBe('EN');
    expect(tr(data, 'ko')).toBe('EN');
  });

  it('tr() on an L5 constant picks the locale value', () => {
    expect(tr(STATUS_TEXT.PASS, 'zh-Hant')).toBe('通過');
    expect(tr(STATUS_TEXT.PASS, 'zh-Hans')).toBe('通过');
    expect(tr(STATUS_TEXT.PASS, 'ja')).toBe('合格');
    expect(tr(STATUS_TEXT.PASS, 'ko')).toBe('통과');
    expect(tr(STATUS_TEXT.PASS, 'en')).toBe('PASS');
  });
});

function listSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listSources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

describe('every 5-string tuple that contains CJK in web/src', () => {
  const found: Array<{ where: string; values: string[] }> = [];
  for (const p of listSources(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, p).split(sep).join('/');
    if (rel === 'i18n/messages.ts' || rel.startsWith('pages/guide')) continue; // catalogs, not tuples
    const text = readFileSync(p, 'utf8');
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n: ts.Node) => {
      if (
        ts.isArrayLiteralExpression(n) &&
        n.elements.length === 5 &&
        n.elements.every((e) => ts.isStringLiteralLike(e) || ts.isTemplateExpression(e))
      ) {
        // Template chunks with ${...} are compared on their literal text with the expressions removed.
        const values = n.elements.map((e) =>
          ts.isTemplateExpression(e)
            ? e.head.text + e.templateSpans.map((s) => '${}' + s.literal.text).join('')
            : (e as ts.StringLiteralLike).text,
        );
        if (values.some((v) => CJK.test(v))) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          found.push({ where: `${rel}:${line + 1}`, values });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  it('finds a large number of tuples', () => {
    expect(found.length).toBeGreaterThan(1000);
  });

  it('each has five non-empty values and the same placeholders in every locale', () => {
    const bad = found.flatMap((f) => problems(f.where, f.values));
    expect(bad.join('\n')).toBe('');
  });

  it('the zh-Hans, ja and ko values are not copies of the English text (no silent fallback)', () => {
    // A value equal to the English one is fine for brand names / numbers / symbols, so only flag
    // values that contain Latin sentences (3+ consecutive words) and no CJK/Hangul at all.
    const SENTENCE = /[A-Za-z]{3,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}/;
    const bad: string[] = [];
    for (const f of found) {
      const [, en, hans, ja, ko] = f.values;
      for (const [label, v] of [['zh-Hans', hans], ['ja', ja], ['ko', ko]] as const) {
        if (v === en && SENTENCE.test(v ?? '') && !CJK.test(v ?? '')) bad.push(`${f.where}: ${label} is a copy of en`);
      }
    }
    expect(bad.join('\n')).toBe('');
  });
});
