/**
 * Guard for the zh-Hans report text table (zhHansReport.ts):
 *  1. no value contains a Traditional-only character,
 *  2. every zh-Hant literal that the backend writes into a report pair (infra/lambda/api/report/*.ts) and that has a
 *     Traditional-only character has a row, so a new backend sentence cannot silently show Traditional text in zh-Hans,
 *  3. the lookup works for exact rows and for rows with interpolated parts, and tr() uses it only for zh-Hans.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TRADITIONAL_ONLY } from '../../../../tools/screenshots/lib/language-check.mjs';
import { hansText, tr } from './reportText.ts';
import { ZH_HANS_REPORT } from './zhHansReport.ts';

const TRAD: string = TRADITIONAL_ONLY;
const HAN = /[\u3400-\u9fff]/;
const hasTrad = (s: string) => [...s].some((ch) => TRAD.includes(ch));

const REPORT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'infra', 'lambda', 'api', 'report');

/** Static or template zh text of L('zh','en') calls and { zh, en } literals, with holes as {0}, {1}. */
function backendZh(): string[] {
  const out = new Set<string>();
  const take = (n: ts.Expression): void => {
    if (ts.isParenthesizedExpression(n)) return take(n.expression);
    if (ts.isConditionalExpression(n)) { take(n.whenTrue); take(n.whenFalse); return; }
    if (ts.isStringLiteralLike(n)) { if (HAN.test(n.text)) out.add(n.text); return; }
    if (ts.isTemplateExpression(n)) {
      let key = n.head.text;
      const lits = [n.head.text];
      n.templateSpans.forEach((s, i) => { key += `{${i}}${s.literal.text}`; lits.push(s.literal.text); });
      const nest = (m: ts.Node) => {
        if (m !== n && (ts.isStringLiteralLike(m) || ts.isTemplateExpression(m))) take(m as ts.Expression);
        ts.forEachChild(m, nest);
      };
      n.templateSpans.forEach((s) => nest(s.expression));
      if (HAN.test(lits.join(''))) out.add(key);
    }
  };
  const visit = (n: ts.Node) => {
    // lookup tables named *Zh whose values are spliced into report sentences
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /Zh$/.test(n.name.text) && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
      for (const p of n.initializer.properties) if (ts.isPropertyAssignment(p)) take(p.initializer);
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'L' && n.arguments.length === 2) take(n.arguments[0]!);
    // helper calls such as mod('id', 'zh', 'en', ...): a Han literal followed by an English literal
    if (ts.isCallExpression(n) && !(ts.isIdentifier(n.expression) && n.expression.text === 'L')) {
      const a = n.arguments;
      for (let i = 0; i + 1 < a.length; i++) {
        const x = a[i]!;
        const y = a[i + 1]!;
        if (ts.isStringLiteralLike(x) && ts.isStringLiteralLike(y) && HAN.test(x.text) && !HAN.test(y.text) && /[A-Za-z]/.test(y.text)) take(x);
      }
    }
    if (ts.isObjectLiteralExpression(n)) {
      const prop = (name: string) => n.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
      const zh = prop('zh');
      if (zh && prop('en')) take(zh.initializer);
    }
    ts.forEachChild(n, visit);
  };
  for (const f of readdirSync(REPORT_DIR).filter((x) => x.endsWith('.ts') && !x.endsWith('.d.ts'))) {
    visit(ts.createSourceFile(f, readFileSync(join(REPORT_DIR, f), 'utf8'), ts.ScriptTarget.Latest, true));
  }
  return [...out];
}

describe('zh-Hans report text table', () => {
  it('has no Traditional-only character in any value', () => {
    const bad = ZH_HANS_REPORT.filter(([, v]) => hasTrad(v)).map(([k, v]) => `${k} -> ${v}`);
    expect(bad.join('\n')).toBe('');
  });

  it('has a row for every backend sentence that contains a Traditional-only character', () => {
    const keys = new Set(ZH_HANS_REPORT.map(([k]) => k));
    const missing = backendZh().filter((zh) => hasTrad(zh) && !keys.has(zh));
    expect(missing.join('\n')).toBe('');
  });

  it('has no stale row (every key is still a backend sentence)', () => {
    const live = new Set(backendZh());
    const stale = ZH_HANS_REPORT.filter(([k]) => !live.has(k)).map(([k]) => k);
    expect(stale.join('\n')).toBe('');
  });

  it('converts exact rows and rows with interpolated parts', () => {
    expect(hansText('所有驗收項目通過')).toBe('所有验收项目通过');
    const tpl = ZH_HANS_REPORT.find(([k]) => k.includes('{0}') && HAN.test(k.replace(/\{\d+\}/g, '')));
    expect(tpl).toBeTruthy();
    const filled = tpl![0].replace(/\{(\d+)\}/g, (_, i: string) => `X${i}`);
    const expected = tpl![1].replace(/\{(\d+)\}/g, (_, i: string) => `X${i}`);
    expect(hansText(filled)).toBe(expected);
  });

  it('converts text composed from other report text (id prefix, 、 lists)', () => {
    expect(hansText('AC-G05 AI 測試代理行為可靠')).toBe('AC-G05 AI 测试代理行为可靠');
    expect(hansText('AI 測試代理行為可靠、AC-G05 AI 測試代理行為可靠')).toBe('AI 测试代理行为可靠、AC-G05 AI 测试代理行为可靠');
  });

  it('converts a composed verdict sentence end to end', () => {
    const out = hansText('必要項目全部通過;建議項目未通過:AC-G04 沒有待人工判讀的異常、AC-G05 AI 測試代理行為可靠');
    expect(hasTrad(out)).toBe(false);
    expect(out).toContain('AC-G05 AI 测试代理行为可靠');
  });

  it('converts sentences built from a lookup table, a conditional branch or nested templates', () => {
    for (const s of [
      '平台限制:沒有逐幀動畫比對器;動畫是否正確目前只能由 AI 在截圖上觀察,不產生此範疇的確定性證據',
      'AI 共 3 次操作,成功率 80%;模組覆蓋率 26.67%。',
      '發布建議(規則引擎):測試不足,觸發 1 條規則。',
      '0 項(低嚴重度 0 項)',
    ]) expect(hasTrad(hansText(s)), s).toBe(false);
  });

  it('returns unknown text unchanged', () => {
    expect(hansText('no row for this')).toBe('no row for this');
  });

  it('tr() uses the table for zh-Hans only', () => {
    const pair = { zh: '所有驗收項目通過', en: 'All acceptance criteria pass' };
    expect(tr(pair, 'zh-Hans')).toBe('所有验收项目通过');
    expect(tr(pair, 'zh-Hant')).toBe('所有驗收項目通過');
    expect(tr(pair, 'en')).toBe('All acceptance criteria pass');
    expect(tr(pair, 'ja')).toBe('All acceptance criteria pass');
  });
});
