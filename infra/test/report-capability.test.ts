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

  test('網路:兩個後端的能力不同,差別剛好在丟包,所以要分開寫', () => {
    const c = capabilityOf('M09')!;
    expect(c.level).toBe('partial');
    // Android 容器用流量塑形,做得到延遲、頻寬,**也做得到丟包**
    expect(c.covers.zh).toContain('延遲');
    expect(c.covers.zh).toContain('頻寬');
    expect(c.covers.zh).toContain('封包遺失率');
    // 但不能寫成「都做得到」:網頁後端的丟包仍是缺口,而且要指名是哪個後端
    expect(c.gap!.zh).toContain('網頁後端');
    expect(c.gap!.zh).toContain('封包遺失率');
    // 容器的「離線」是全丟封包,不是鏈路斷開 —— 這個差別會讓測斷網提示的測項測不到,
    // 屬於缺口而不是能力,必須寫在 gap 裡。
    expect(c.gap!.zh).toContain('全丟');
    expect(c.fallback!.zh).toContain('封包過濾驅動');
  });

  test('網路:宣告裡不能把「工具回報成功」講成已驗', () => {
    const c = capabilityOf('M09')!;
    // 量測不符時的處理必須寫出來,否則讀者會以為施加成功就等於條件生效
    expect(c.fallback!.zh).toContain('未經獨立量測確認');
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
  /** 用指定的弱網紀錄跑一份報告(不給就是沒施加條件的普通執行)。 */
  const netNote = (networkConditions?: unknown) => {
    const raw: RawStep = {
      state: 'pass',
      task: '探索遊戲',
      steps: [st(0, '大廳', 'tap', { x: 5, y: 5 }), st(1, '選單', 'done')],
      ...(networkConditions ? { networkConditions } : {}),
    };
    const r = buildStructuredReport({ raw, job: { jobId: 'job-test' }, app: { genre: 'slot' } } as never);
    const net = r.claimScope.notVaried.find((n) => n.id === 'network');
    expect(net, '網路條件必須永遠表態').toBeDefined();
    return net!.note;
  };

  test('沒要求條件時,只能講觀察到什麼,不得主張弱網已驗', () => {
    const note = netNote();
    expect(note.zh).toContain('未施加任何網路條件');
    expect(note.zh).toContain('不得主張');
    expect(note.en).toContain('No network condition was imposed');
  });

  test('施加成功時,結論要收斂到那一組條件,不得外推到其他延遲與頻寬', () => {
    const note = netNote({
      requested: { latencyMs: 1000, downKbps: 400 },
      applied: { latencyMs: 1000, downKbps: 400 },
      unsupported: [],
      ok: true,
      verified: false,
      summary: '延遲 1000 ms / 下行 400 kbps',
    });
    expect(note.zh).toContain('已施加');
    expect(note.zh).toContain('延遲 1000 ms / 下行 400 kbps');
    expect(note.zh).toContain('僅適用於這個網路條件');
  });

  test('後端做不到的項目要單獨點名,不能被「已施加」一句帶過', () => {
    const note = netNote({
      requested: { latencyMs: 1000, lossPct: 5 },
      applied: { latencyMs: 1000 },
      unsupported: [{ key: 'lossPct', reason: 'CDP 無法製造封包遺失' }],
      ok: true,
      verified: false,
      summary: '延遲 1000 ms',
    });
    expect(note.zh).toContain('lossPct');
    expect(note.zh).toContain('不得視為已驗');
  });

  test('施加失敗時,必須降級成一次沒有條件的普通執行', () => {
    const note = netNote({
      requested: { latencyMs: 1000 },
      applied: null,
      unsupported: [],
      ok: false,
      verified: false,
      error: 'CDP session 無法建立',
      summary: null,
    });
    expect(note.zh).toContain('施加失敗');
    expect(note.zh).toContain('CDP session 無法建立');
    expect(note.zh).toContain('不得主張弱網已驗');
    // 失敗的一次絕對不可以留下「已施加」的字眼
    expect(note.zh).not.toContain('已施加 ');
  });
});
