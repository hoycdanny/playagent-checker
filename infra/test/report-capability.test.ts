import { describe, expect, test } from 'vitest';
import { buildStructuredReport } from '../lambda/api/report/engine.js';
import { CATEGORY_CAPABILITY, capabilityOf, capabilitySummary } from '../lambda/api/report/qaCapability.js';
import { QA_CATEGORIES, buildQaDocumentSet } from '../lambda/api/report/qaDocs.js';

/**
 * 平台可執行範圍宣告。
 *
 * 這組測試守的不是「能力有多強」,是「宣告有沒有說實話」:
 * 每一類都要表態、做不到的要寫原因與補法、而且不能用分類數假裝成涵蓋率。
 */

type RawStep = Record<string, unknown>;
const st = (i: number, screen: string, action: string, extra: RawStep = {}): RawStep => ({ index: i, screen, action, ...extra });
const report = () =>
  buildStructuredReport({
    raw: { state: 'pass', task: '探索遊戲', steps: [st(0, '大廳', 'tap', { x: 5, y: 5 }), st(1, '選單', 'done')] },
    job: { jobId: 'job-test' },
    app: { genre: 'slot' },
  } as never);

describe('宣告的完整性', () => {
  test('19 個測項分類全部表態,沒有漏類', () => {
    expect(CATEGORY_CAPABILITY).toHaveLength(19);
    const codes = CATEGORY_CAPABILITY.map((c) => c.code);
    expect(new Set(codes).size).toBe(19);
    // 與測項分類表的代碼一一對應(不能宣告一個不存在的分類)
    expect([...codes].sort()).toEqual(QA_CATEGORIES.map((c) => c.code).sort());
  });

  test('不是 automated 的都要寫出缺口與補法', () => {
    for (const c of CATEGORY_CAPABILITY) {
      if (c.level === 'automated') continue;
      expect(c.gap?.zh.length ?? 0, `${c.code} 缺少 gap`).toBeGreaterThan(0);
      expect(c.fallback?.zh.length ?? 0, `${c.code} 缺少 fallback`).toBeGreaterThan(0);
    }
  });

  test('每一類都要說明做得到什麼(即使是做不到的類)', () => {
    for (const c of CATEGORY_CAPABILITY) {
      expect(c.covers.zh.length, `${c.code} 缺少 covers`).toBeGreaterThan(0);
      expect(c.covers.en.length, `${c.code} 缺少英文 covers`).toBeGreaterThan(0);
    }
  });

  test('摘要不把分類數講成涵蓋率', () => {
    const s = capabilitySummary();
    expect(s.automated + s.partial + s.not_supported).toBe(s.total);
    expect(s.note.zh).toContain('分類數不等於測項數');
  });
});

describe('關鍵缺口要如實標示', () => {
  test('影音語系:結構性做不到,理由點明沒有音軌也沒有核定文案', () => {
    const c = capabilityOf('M08')!;
    expect(c.level).toBe('not_supported');
    expect(c.gap!.zh).toContain('音訊軌未擷取');
    expect(c.gap!.zh).toContain('核定文案');
  });

  test('網路:觀察得到但施加不了,兩者分開寫', () => {
    const c = capabilityOf('M09')!;
    expect(c.level).toBe('partial');
    expect(c.covers.zh).toContain('觀察');
    expect(c.gap!.zh).toContain('無法施加');
    expect(c.gap!.zh).toMatch(/延遲|丟包/);
  });

  test('設備周邊:沒有實體 I/O,不能假裝部分可行', () => {
    const c = capabilityOf('M15')!;
    expect(c.level).toBe('not_supported');
    expect(c.gap!.zh).toContain('實體');
  });

  test('帳務與效能是強項,標為可自動執行', () => {
    expect(capabilityOf('M04')!.level).toBe('automated');
    expect(capabilityOf('M12')!.level).toBe('automated');
    // 帳務的說明要講到是「重建成帳」而非採用 AI 自報
    expect(capabilityOf('M04')!.covers.zh).toContain('重建');
  });
});

describe('接進結案報告', () => {
  test('T07 帶出可執行範圍表,19 類全列', () => {
    const t07 = buildQaDocumentSet(report()).documents.find((d) => d.code === 'T07')!;
    const cap = t07.tables.find((t) => t.id === 'platform_capability')!;
    expect(cap.rows).toHaveLength(19);
    expect(cap.columns.map((c) => c.key)).toEqual(['code', 'name', 'level', 'covers', 'gap', 'fallback']);
    // 做不到的類在表上要有原因,不能是空白
    const m08 = cap.rows.find((r) => r['code'] === 'M08')!;
    expect(m08['level']).toBe('結構性做不到');
    expect(m08['gap']).not.toBe('—');
  });

  test('文件集的說明點出「全綠但有缺口」的風險', () => {
    const notes = buildQaDocumentSet(report()).notes.map((n) => n.zh).join(' ');
    expect(notes).toContain('分類數不等於測項數');
    expect(notes).toContain('放行依據');
  });
});

describe('適用邊界的網路條件', () => {
  test('無論有沒有觀測到斷線,都要聲明平台無法施加網路條件', () => {
    const r = report();
    const net = r.claimScope.notVaried.find((n) => n.id === 'network')!;
    expect(net).toBeDefined();
    expect(net.note.zh).toContain('無法施加');
  });
});
