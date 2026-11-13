/**
 * Guard: no hardcoded CJK display strings in web/src.
 *
 * Every Han / Kana / Hangul string literal, template chunk and JSX text in a
 * non-test source file must be one of:
 *   1. an element of a 5-string array (an L5 tuple, see locale5.ts),
 *   2. inside an exact-path TABLE_FILES entry (per-locale catalogs / guide texts),
 *   3. under a leading `// i18n-allow: <reason>` comment, pinned in ALLOW_MARKERS,
 *   4. (interim) an element of a 2-string pair in an exact-path PAIR_DEBT file.
 * Comments are not AST nodes, so they are never scanned.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Han, Kana, Hangul and CJK compatibility ideographs. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

/** Per-locale catalogs and guide texts (exact paths, no globs). */
const TABLE_FILES: readonly string[] = [
  'i18n/messages.ts',
  'pages/guideContent.ts',
  'pages/guide/zhHans.ts',
  'pages/guide/ja.ts',
  'pages/guide/ko.ts',
];

/** Recognisers / generated artifacts: file -> number of `i18n-allow` markers. */
const ALLOW_MARKERS: Readonly<Record<string, number>> = {
  'components/cases/excelImport.ts': 1,
  'components/credentials/CredentialsPanel.tsx': 1,
  'components/cases/acceptanceSpec.ts': 1,
  'components/memory/memoryScript.ts': 1,
  'pages/CostPage.tsx': 1,
  'components/tasks/OperatorChat.tsx': 1,
};

/** Interim: files that still hold [zh-Hant, en] pairs. FEAT-002 removes this list. */
const PAIR_DEBT: readonly string[] = [
  'pages/TaskDetailPage.tsx',
  'components/memory/ScreenStudio.tsx',
  'components/memory/MemoryEditor.tsx',
  'components/tasks/MomentFeed.tsx',
  'pages/CostPage.tsx',
  'components/cases/CaseOverviewTable.tsx',
  'components/cases/ExcelImport.tsx',
  'components/tasks/TaskTimeline.tsx',
  'components/tasks/OperatorChat.tsx',
  'components/cases/AcceptanceEditor.tsx',
  'components/memory/RoutesPanel.tsx',
  'components/tasks/LiveScreen.tsx',
  'components/tasks/memoryUsage.ts',
  'components/tasks/MemoryUsagePanel.tsx',
  'components/tasks/TaskAskPanel.tsx',
  'components/ScreenGraph.tsx',
  'components/memory/graphView.ts',
  'components/tasks/ScriptPanel.tsx',
  'components/tasks/RecordingPlayer.tsx',
  'components/memory/OpStage.tsx',
  'components/memory/MemoryPanel.tsx',
  'components/tasks/BootTimeline.tsx',
  'components/report/reportText.ts',
  'components/outcome.ts',
  'components/report/qaDocsExport.ts',
  'components/report/StructuredReportView.tsx',
  'components/tasks/feed.ts',
  'components/tasks/StepSound.tsx',
  'components/report/SlotCapturePanel.tsx',
  'components/cases/acceptanceSpec.ts',
  'components/cases/excelImport.ts',
];

type Kind = 'l5' | 'table' | 'marker' | 'pair';

interface ScanResult {
  violations: { line: number; text: string }[];
  exempt: Record<Kind, number>;
  markersFound: number;
  markersUsed: number;
}

function isStringLike(n: ts.Node): boolean {
  return ts.isStringLiteralLike(n) || ts.isTemplateExpression(n);
}

function arrayParent(node: ts.Node): ts.ArrayLiteralExpression | null {
  let cur: ts.Node = node;
  // A template head/middle/tail sits inside a TemplateExpression / span.
  while (cur.parent && (ts.isTemplateSpan(cur.parent) || ts.isTemplateExpression(cur.parent))) {
    cur = cur.parent;
  }
  const p = cur.parent;
  return p && ts.isArrayLiteralExpression(p) ? p : null;
}

/** True when the node sits inside the zh: value of an object literal that also has an en: property. */
function inZhEnObject(node: ts.Node): boolean {
  for (let a: ts.Node | undefined = node; a && a.parent; a = a.parent) {
    const p = a.parent;
    if (ts.isPropertyAssignment(a) && ts.isObjectLiteralExpression(p) && a.name.getText() === 'zh') {
      return p.properties.some((q) => ts.isPropertyAssignment(q) && q.name.getText() === 'en');
    }
  }
  return false;
}

const MARKER = /\/\/\s*i18n-allow:\s*\S/;

export function scan(text: string, fileName: string): ScanResult {
  const norm = fileName.split(sep).join('/');
  const kind = norm.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(norm, text, ts.ScriptTarget.Latest, true, kind);
  const result: ScanResult = {
    violations: [],
    exempt: { l5: 0, table: 0, marker: 0, pair: 0 },
    markersFound: 0,
    markersUsed: 0,
  };
  const inTable = TABLE_FILES.includes(norm);
  const inPairDebt = PAIR_DEBT.includes(norm);
  const usedMarkers = new Set<number>();

  // Count markers that are real comments (not text inside a string).
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  void scanner;
  const commentRe = /\/\/[^\n]*/g;
  for (const m of text.matchAll(commentRe)) {
    if (MARKER.test(m[0]) && m.index !== undefined) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      if (text.slice(lineStart, m.index).trim() === '') result.markersFound++;
    }
  }

  const markerFor = (n: ts.Node): number | null => {
    const ranges = ts.getLeadingCommentRanges(text, n.getFullStart()) ?? [];
    for (const r of ranges) {
      if (MARKER.test(text.slice(r.pos, r.end))) return r.pos;
    }
    return null;
  };

  const visit = (node: ts.Node) => {
    let value: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      value = node.text;
    } else if (ts.isJsxText(node)) value = node.text;

    if (value !== null && CJK.test(value)) {
      let exempt: Kind | null = null;
      if (inTable) exempt = 'table';
      if (!exempt) {
        const arr = arrayParent(node);
        if (arr && arr.elements.every(isStringLike)) {
          if (arr.elements.length === 5) exempt = 'l5';
          else if (arr.elements.length === 2 && inPairDebt) exempt = 'pair';
        }
      }
      if (!exempt && inPairDebt && inZhEnObject(node)) exempt = 'pair';
      if (!exempt) {
        for (let a: ts.Node | undefined = node; a; a = a.parent) {
          const pos = markerFor(a);
          if (pos !== null) {
            usedMarkers.add(pos);
            exempt = 'marker';
            break;
          }
        }
      }
      if (exempt) result.exempt[exempt]++;
      else {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        result.violations.push({ line: line + 1, text: value.trim().slice(0, 60) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  result.markersUsed = usedMarkers.size;
  return result;
}

export function scanSource(text: string, fileName: string): { line: number; text: string }[] {
  return scan(text, fileName).violations;
}

function listSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listSources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

const FILES = listSources(SRC_ROOT).map((p) => ({
  rel: relative(SRC_ROOT, p).split(sep).join('/'),
  text: readFileSync(p, 'utf8'),
}));
const SCANS = new Map(FILES.map((f) => [f.rel, scan(f.text, f.rel)]));

describe('scanSource (planted violations)', () => {
  it('flags Han in JSX text', () => {
    expect(scanSource('export const x = <b>中文</b>;', 'components/Foo.tsx')).toHaveLength(1);
  });
  it('exempts the same text in a TABLE_FILES entry', () => {
    expect(scanSource('export const x = "中文";', 'i18n/messages.ts')).toHaveLength(0);
  });
  it('flags Han in a plain string, template chunk and no-substitution template', () => {
    expect(scanSource('const a = "中文";', 'components/Foo.ts')).toHaveLength(1);
    expect(scanSource('const a = `中文${1}`;', 'components/Foo.ts')).toHaveLength(1);
    expect(scanSource('const a = `${1}中文`;', 'components/Foo.ts')).toHaveLength(1);
    expect(scanSource('const a = `中文`;', 'components/Foo.ts')).toHaveLength(1);
  });
  it('exempts a 5-string tuple but not a 4- or 6-string array', () => {
    expect(scanSource('const a = ["中","b","c","d","e"];', 'components/Foo.ts')).toHaveLength(0);
    expect(scanSource('const a = ["中","b","c","d"];', 'components/Foo.ts')).toHaveLength(1);
    expect(scanSource('const a = ["中","b","c","d","e","f"];', 'components/Foo.ts')).toHaveLength(1);
  });
  it('flags a 2-element pair outside PAIR_DEBT', () => {
    expect(scanSource('const a = ["中","b"];', 'components/Foo.ts')).toHaveLength(1);
  });
  it('flags Hangul and Kana', () => {
    expect(scanSource('const a = "한국어";', 'components/Foo.ts')).toHaveLength(1);
    expect(scanSource('const a = "ひらがな";', 'components/Foo.ts')).toHaveLength(1);
  });
  it('ignores comments', () => {
    expect(scanSource('// 中文\n/* 中文 */\nconst a = 1;', 'components/Foo.ts')).toHaveLength(0);
  });
  it('honours i18n-allow markers and counts them', () => {
    const src = '// i18n-allow: header alias\nconst a = ["中", "x"];\n';
    const r = scan(src, 'components/Foo.ts');
    expect(r.violations).toHaveLength(0);
    expect(r.markersFound).toBe(1);
    expect(r.markersUsed).toBe(1);
    // A marker with no reason does not exempt.
    expect(scanSource('// i18n-allow:\nconst a = "中";', 'components/Foo.ts')).toHaveLength(1);
  });
  it('reports a marker that guards nothing as unused', () => {
    const r = scan('// i18n-allow: stale\nconst a = 1;\n', 'components/Foo.ts');
    expect(r.markersFound).toBe(1);
    expect(r.markersUsed).toBe(0);
  });
});

describe('no hardcoded CJK display strings in web/src', () => {
  it('has zero violations', () => {
    const lines: string[] = [];
    for (const [rel, r] of SCANS) {
      for (const v of r.violations) lines.push(`${rel}:${v.line}  ${v.text}`);
    }
    expect(lines.join('\n')).toBe('');
  });
});

describe('guard is not vacuous', () => {
  it('scans a plausible number of files', () => {
    expect(FILES.length).toBeGreaterThan(100);
  });
  it('sees a large number of exempt literals', () => {
    let n = 0;
    for (const r of SCANS.values()) n += r.exempt.l5 + r.exempt.table + r.exempt.marker + r.exempt.pair;
    expect(n).toBeGreaterThan(500);
  });
  it('sees L5 tuples in the kb text tables', () => {
    expect(SCANS.get('components/kb/kbText.ts')!.exempt.l5).toBeGreaterThan(0);
    expect(SCANS.get('components/kb/builtinKbText.ts')!.exempt.l5).toBeGreaterThan(0);
  });
  it.each(TABLE_FILES)('TABLE_FILES entry %s exists and holds CJK literals', (rel) => {
    const r = SCANS.get(rel);
    expect(r, `stale allowlist entry, remove it: ${rel}`).toBeDefined();
    expect(r!.exempt.table, `stale allowlist entry, remove it: ${rel}`).toBeGreaterThan(0);
  });
  it('ALLOW_MARKERS match the markers found, and each guards a CJK literal', () => {
    for (const [rel, r] of SCANS) {
      const expected = ALLOW_MARKERS[rel] ?? 0;
      expect(r.markersFound, `${rel}: i18n-allow marker count`).toBe(expected);
      expect(r.markersUsed, `${rel}: marker guards no CJK literal`).toBe(expected);
    }
    for (const rel of Object.keys(ALLOW_MARKERS)) {
      expect(SCANS.has(rel), `stale ALLOW_MARKERS entry: ${rel}`).toBe(true);
    }
  });
  it.each(PAIR_DEBT)('PAIR_DEBT entry %s still contains a pair', (rel) => {
    expect(SCANS.get(rel)?.exempt.pair ?? 0).toBeGreaterThan(0);
  });
});
