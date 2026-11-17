import { describe, expect, test } from 'vitest';
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  buildMemoryExport,
  mdText,
  parseImportBundle,
  planMemoryImport,
  renderMemoryMarkdown,
  type ImportTarget,
  type RawStructure,
} from '../lambda/api/memoryTransfer.js';
import { emptyEdits, type MemoryHint } from '../lambda/api/memoryHints.js';
import { handleRequest, type ApiDeps } from '../lambda/api/core.js';

const P = { lobby: 'page_0000aaa1', slot: 'page_0000bbb2', shop: 'page_0000ccc3', login: 'page_0000ddd4' };

function page(id: string, name: string, visits = 3, extra: Record<string, unknown> = {}) {
  return {
    id, name, aliases: { [name]: visits }, pHash: '', screenshotRef: `screenshots/${id}.png`,
    knownControlLabels: ['SPIN'], visitCount: visits, hitCount: 0,
    firstSeenAt: '2026-11-01T00:00:00Z', lastSeenAt: '2026-11-02T00:00:00Z', ...extra,
  };
}

function structure(): RawStructure {
  return {
    schemaVersion: 2, appName: 'Example Slots', rootPageId: P.lobby,
    pages: {
      [P.lobby]: page(P.lobby, '大廳', 5),
      [P.slot]: page(P.slot, '老虎機', 4),
      [P.login]: page(P.login, '會員登入', 2),
    },
    edges: [
      { fromPageId: P.lobby, toPageId: P.slot, trigger: { kind: 'tap', label: 'tap 老虎機', target: '老虎機' }, hitCount: 6, missCount: 1, op: { a: 'tap', x: 0.5, y: 0.8 } },
      { fromPageId: P.lobby, toPageId: P.login, trigger: { kind: 'type', label: 'type 密碼', target: '密碼' }, hitCount: 2, missCount: 0, op: { a: 'type', text: 'hunter2-secret' } },
    ],
    lastUpdatedAt: '2026-11-02T00:00:00Z',
  } as unknown as RawStructure;
}

const hint = (id: string, text: string, pageId?: string): MemoryHint => ({
  id, text, ...(pageId ? { pageId } : {}), source: 'manual', enabled: true,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
});

function bundleOf(s: RawStructure | null, extra: Record<string, unknown> = {}) {
  return parseImportBundle({
    manifest: { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, app: { id: 'app-src', name: 'Example Slots' }, exportedAt: '2026-11-03T00:00:00.000Z' },
    structure: s,
    edits: {},
    hints: [],
    ...extra,
  });
}

const emptyTarget = (): ImportTarget => ({ structure: null, edits: emptyEdits(), hints: [], screenshotPages: new Set() });
const AT = '2026-11-18T00:00:00.000Z';

/** 只夠這組測試用的假 S3(Get / Put / List / Delete)。 */
function fakeS3() {
  const store = new Map<string, string>();
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      const key = cmd.input['Key'] as string;
      if (name === 'PutObjectCommand') { store.set(key, String(cmd.input['Body'] ?? '')); return {}; }
      if (name === 'GetObjectCommand') {
        if (!store.has(key)) { const e = new Error('nf'); e.name = 'NoSuchKey'; throw e; }
        return { Body: { transformToString: async () => store.get(key) }, ETag: `"e-${store.get(key)!.length}"` };
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = String(cmd.input['Prefix'] ?? '');
        const delim = cmd.input['Delimiter'];
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
        if (delim === '/') {
          const prefixes = [...new Set(keys.map((k) => prefix + k.slice(prefix.length).split('/')[0] + '/'))];
          return { CommonPrefixes: prefixes.map((Prefix) => ({ Prefix })) };
        }
        return { Contents: keys.map((Key) => ({ Key })) };
      }
      if (name === 'DeleteObjectCommand') { store.delete(key); return {}; }
      return {};
    },
  };
  return { store, client };
}

describe('匯出', () => {
  test('輸入文字不會出現在 data 或 memory.md;截圖只附畫面還在的', async () => {
    const { store, client } = fakeS3();
    const pre = 'tenants/t-1/memory/app-1';
    store.set(`${pre}/structure.json`, JSON.stringify(structure()));
    store.set(`${pre}/edits.json`, JSON.stringify({ ...emptyEdits(), opEdits: { [`${P.lobby}>${P.login}>type>密碼`]: { op: { a: 'type', text: 'other-secret' } } } }));
    store.set(`${pre}/hints.json`, JSON.stringify({ schemaVersion: 1, hints: [hint('hint-aaaaaa1', '先關掉活動彈窗')] }));
    store.set(`${pre}/meta.json`, JSON.stringify({ totalRuns: 7 }));
    store.set(`${pre}/screenshots/${P.lobby}.png`, 'png');
    store.set(`${pre}/screenshots/page_ffffffff.png`, 'orphan');
    const out = await buildMemoryExport(client as never, 'b', 't-1', 'app-1', {
      appName: 'Example Slots', lang: 'zh-Hant', presignGet: async (k) => `https://signed/${k}`, now: new Date(AT),
    });
    const all = JSON.stringify(out);
    expect(all).not.toContain('hunter2-secret');
    expect(all).not.toContain('other-secret');
    // 路徑本身仍保留(動作種類與目標欄位),只是沒有可重播的輸入內容。
    expect(out.data.structure!.edges.some((e) => e.trigger.kind === 'type' && !e.op)).toBe(true);
    expect(out.screenshots.map((s) => s.pageId)).toEqual([P.lobby]);
    expect(out.screenshots[0]!.path).toBe(`screenshots/${P.lobby}.png`);
    expect(out.manifest).toMatchObject({ format: BUNDLE_FORMAT, version: BUNDLE_VERSION, app: { id: 'app-1', name: 'Example Slots' } });
    expect(out.manifest.counts).toMatchObject({ pages: 3, screenshots: 1, hints: 1, runs: 7 });
  });

  test('memory.md:有截圖才放圖片連結、路徑表含位置與成功失敗次數、應用記憶與路線都在', () => {
    const edits = {
      ...emptyEdits(),
      routes: [{ id: 'route-abcdef', name: '去老虎機', enabled: true, steps: [{ id: 's-aaaa', pageId: P.lobby, action: '點老虎機' }, { id: 's-bbbb', pageId: P.slot, action: '按 SPIN' }], branches: [] }],
      opEdits: { [`${P.lobby}>${P.slot}>tap>老虎機`]: { verified: true } },
    };
    const md = renderMemoryMarkdown({
      appId: 'app-1', appName: 'Example Slots', exportedAt: AT, lang: 'zh-Hant',
      view: structure(), edits, hints: [hint('hint-aaaaaa1', '先關掉活動彈窗'), hint('hint-aaaaaa2', '要先領每日獎勵', P.slot)],
      meta: { totalRuns: 7 }, screenshots: new Set([P.lobby]),
    });
    expect(md).toContain('# 記憶地圖: Example Slots');
    expect(md).toContain(`![大廳](screenshots/${P.lobby}.png)`);
    expect(md).not.toContain(`screenshots/${P.slot}.png`);
    expect(md).toContain('(0.50, 0.80)');
    expect(md).toContain('6 / 1');
    expect(md).toContain('已確認可直接執行');
    expect(md).toContain('- 先關掉活動彈窗');
    expect(md).toContain('  - 要先領每日獎勵');
    expect(md).toContain('### 去老虎機');
    expect(md).toContain(`1. **大廳** (\`${P.lobby}\`): 點老虎機`);
    expect(md).toContain('累計測試次數: 7');
  });

  test('五種語系的標題都不同,英文版沒有中文標題', () => {
    const base = { appId: 'app-1', appName: 'X', exportedAt: AT, view: structure(), edits: emptyEdits(), hints: [], meta: {}, screenshots: new Set<string>() };
    const titles = (['zh-Hant', 'en', 'zh-Hans', 'ja', 'ko'] as const).map((lang) => renderMemoryMarkdown({ ...base, lang }).split('\n')[0]);
    expect(new Set(titles).size).toBe(5);
    expect(renderMemoryMarkdown({ ...base, lang: 'en' })).toContain('## How to use this memory');
  });

  test('從遊戲畫面讀到的名稱不能改變 Markdown 結構', () => {
    expect(mdText('a|b\n# 標題 ![x](http://evil)')).toBe('a\\|b \\# 標題 \\!\\[x\\](http://evil)');
  });
});

describe('匯入驗證', () => {
  test('不是本平台的匯出檔、版本不符、畫面 id 不合法都拒絕', () => {
    expect(() => parseImportBundle({ manifest: { format: 'other', version: 1, app: { id: 'a' } } })).toThrow(/manifest.format/);
    expect(() => parseImportBundle({ manifest: { format: BUNDLE_FORMAT, version: 9, app: { id: 'a' } } })).toThrow(/版本/);
    expect(() => bundleOf({ ...structure(), pages: { '../../etc': page('x', 'x') } } as unknown as RawStructure)).toThrow(/畫面 id/);
  });

  test('匯入檔裡的輸入文字一律丟掉', () => {
    const b = bundleOf(structure());
    expect(JSON.stringify(b)).not.toContain('hunter2-secret');
  });

  test('畫面數超過上限整份拒絕,不做部分匯入', () => {
    const pages: Record<string, unknown> = {};
    for (let i = 0; i < 2001; i++) { const id = `page_${i.toString(16).padStart(8, '0')}`; pages[id] = page(id, `畫面名${i}`); }
    expect(() => bundleOf({ ...structure(), pages } as unknown as RawStructure)).toThrow(/上限/);
  });
});

describe('匯入合併', () => {
  test('匯入到空的應用:全部新增、標記來源、截圖對照正確', () => {
    const plan = planMemoryImport(emptyTarget(), bundleOf(structure()), { importedAt: AT, screenshotsInBundle: new Set([P.lobby, P.slot]) });
    expect(plan.summary.pages).toEqual({ added: 3, merged: 0 });
    expect(plan.summary.edges.added).toBe(2);
    expect(Object.values(plan.structure.pages).every((p) => p.imported?.fromApp === 'app-src')).toBe(true);
    expect(plan.uploads).toEqual(expect.arrayContaining([{ from: P.lobby, to: P.lobby }, { from: P.slot, to: P.slot }]));
    expect(plan.summary.screenshots).toBe(2);
  });

  test('同一個畫面(同名、不同 id)併成一個;目標的 id 不變,即使匯入的次數比較多', () => {
    const target: ImportTarget = {
      structure: { schemaVersion: 2, appName: 'T', rootPageId: 'page_00000001', pages: { page_00000001: page('page_00000001', '大廳', 1) }, edges: [], lastUpdatedAt: null } as unknown as RawStructure,
      edits: { ...emptyEdits(), routes: [{ id: 'route-target', name: '目標路線', enabled: true, steps: [{ id: 's-tttt', pageId: 'page_00000001', action: '' }], branches: [] }] },
      hints: [hint('hint-target1', '目標自己的記憶', 'page_00000001')],
      screenshotPages: new Set(['page_00000001']),
    };
    const plan = planMemoryImport(target, bundleOf(structure()), { importedAt: AT, screenshotsInBundle: new Set([P.lobby]) });
    expect(plan.summary.pages).toEqual({ added: 2, merged: 1 });
    // 目標的畫面 id 保留,次數是兩邊相加(都是真的觀察)。
    const lobby = plan.structure.pages['page_00000001']!;
    expect(lobby).toBeDefined();
    expect(lobby.visitCount).toBe(6);
    expect(lobby.imported).toBeUndefined();
    expect(plan.structure.pages[P.lobby]).toBeUndefined();
    // 匯入的「大廳 → 老虎機」接到目標的大廳上。
    expect(plan.structure.edges.some((e) => e.fromPageId === 'page_00000001' && e.toPageId === P.slot)).toBe(true);
    // 目標已有截圖,不從匯入檔覆蓋。
    expect(plan.uploads.find((u) => u.to === 'page_00000001')).toBeUndefined();
    // 目標自己的路線與記憶不受影響。
    expect(plan.edits.routes!.find((r) => r.id === 'route-target')!.steps[0]!.pageId).toBe('page_00000001');
    expect(plan.hints.find((h) => h.id === 'hint-target1')!.pageId).toBe('page_00000001');
  });

  test('id 撞號但畫面不同:換新 id 當新畫面,不因 id 相同就合併', () => {
    const target: ImportTarget = {
      structure: { schemaVersion: 2, appName: 'T', rootPageId: P.lobby, pages: { [P.lobby]: page(P.lobby, '商城', 2) }, edges: [], lastUpdatedAt: null } as unknown as RawStructure,
      edits: emptyEdits(), hints: [], screenshotPages: new Set(),
    };
    const plan = planMemoryImport(target, bundleOf(structure()), { importedAt: AT, screenshotsInBundle: new Set([P.lobby]) });
    expect(plan.structure.pages[P.lobby]!.name).toBe('商城');
    const lobby = Object.values(plan.structure.pages).find((p) => p.name === '大廳')!;
    expect(lobby.id).not.toBe(P.lobby);
    // 大廳的截圖放到新的 id,不蓋掉商城那一格。
    expect(plan.uploads).toContainEqual({ from: P.lobby, to: lobby.id });
  });

  test('路線、應用記憶、操作修正都改指到合併後的畫面;找不到畫面的路線略過', () => {
    const target: ImportTarget = {
      structure: { schemaVersion: 2, appName: 'T', rootPageId: 'page_00000001', pages: { page_00000001: page('page_00000001', '大廳', 9) }, edges: [], lastUpdatedAt: null } as unknown as RawStructure,
      edits: emptyEdits(), hints: [hint('hint-dupdup1', '先關掉活動彈窗')], screenshotPages: new Set(),
    };
    const b = bundleOf(structure(), {
      hints: [hint('hint-aaaaaa1', '先關掉活動彈窗'), hint('hint-aaaaaa2', '在大廳先領獎勵', P.lobby)],
      edits: {
        routes: [
          { id: 'route-good01', name: '好', enabled: true, steps: [{ id: 's-aaaa', pageId: P.lobby, action: 'x' }], branches: [] },
          { id: 'route-bad001', name: '壞', enabled: true, steps: [{ id: 's-bbbb', pageId: 'page_99999999', action: 'x' }], branches: [] },
        ],
        opEdits: { [`${P.lobby}>${P.slot}>tap>老虎機`]: { verified: true } },
        renames: { [P.slot]: '主遊戲' },
      },
    });
    const plan = planMemoryImport(target, b, { importedAt: AT, screenshotsInBundle: new Set() });
    expect(plan.summary.hints).toEqual({ added: 1, skipped: 1 });
    expect(plan.hints.find((h) => h.text === '在大廳先領獎勵')!.pageId).toBe('page_00000001');
    expect(plan.summary.routes).toEqual({ added: 1, skipped: 1 });
    expect(plan.edits.routes!.find((r) => r.id === 'route-good01')!.steps[0]!.pageId).toBe('page_00000001');
    expect(plan.edits.opEdits![`page_00000001>${P.slot}>tap>老虎機`]).toMatchObject({ verified: true });
    expect(plan.edits.renames[P.slot]).toBe('主遊戲');
    expect(plan.summary.warnings).toContain('noScreenshots');
  });

  test('匯入檔的「已刪除」只套在匯入進來的新畫面,不替目標刪掉自己的畫面', () => {
    const target: ImportTarget = {
      structure: { schemaVersion: 2, appName: 'T', rootPageId: 'page_00000001', pages: { page_00000001: page('page_00000001', '大廳', 9) }, edges: [], lastUpdatedAt: null } as unknown as RawStructure,
      edits: emptyEdits(), hints: [], screenshotPages: new Set(),
    };
    const b = bundleOf(structure(), { edits: { deletedPages: [P.lobby, P.login] } });
    const plan = planMemoryImport(target, b, { importedAt: AT, screenshotsInBundle: new Set() });
    expect(plan.edits.deletedPages).toEqual([P.login]);
    expect(plan.summary.deleted.pages).toBe(1);
  });

  test('同一份輸入算兩次結果相同(預覽看到的就是套用寫入的)', () => {
    const run = () => planMemoryImport(emptyTarget(), bundleOf(structure()), { importedAt: AT, screenshotsInBundle: new Set([P.lobby]) });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe('匯出 → 匯入(來回)', () => {
  test('匯出的資料原樣匯進另一個空的應用:畫面、路徑、路線、記憶、截圖都對得上', async () => {
    const { store, client } = fakeS3();
    const src = 'tenants/t-1/memory/app-src';
    store.set(`${src}/structure.json`, JSON.stringify(structure()));
    store.set(`${src}/edits.json`, JSON.stringify({
      ...emptyEdits(),
      renames: { [P.slot]: '主遊戲' },
      routes: [{ id: 'route-abcdef', name: '去老虎機', enabled: true, steps: [{ id: 's-aaaa', pageId: P.lobby, action: '點老虎機' }], branches: [] }],
    }));
    store.set(`${src}/hints.json`, JSON.stringify({ schemaVersion: 1, hints: [hint('hint-aaaaaa1', '在大廳先領獎勵', P.lobby)] }));
    store.set(`${src}/screenshots/${P.lobby}.png`, 'png');
    store.set(`${src}/screenshots/${P.slot}.png`, 'png');
    const ex = await buildMemoryExport(client as never, 'b', 't-1', 'app-src', { lang: 'en', presignGet: async (k) => k, now: new Date(AT) });

    // 瀏覽器拆 zip 後送的就是這些(與 MemoryTransfer.tsx 相同的欄位對應)。
    const bundle = parseImportBundle({
      manifest: ex.manifest,
      structure: ex.data.structure,
      edits: ex.data.edits,
      hints: ex.data.hints.hints,
    });
    const shots = new Set(ex.screenshots.map((s) => s.pageId));
    const plan = planMemoryImport(emptyTarget(), bundle, { importedAt: AT, screenshotsInBundle: shots });

    expect(Object.keys(plan.structure.pages).sort()).toEqual(Object.keys(ex.data.structure!.pages).sort());
    expect(plan.structure.edges).toHaveLength(ex.data.structure!.edges.length);
    expect(plan.edits.renames[P.slot]).toBe('主遊戲');
    expect(plan.edits.routes!.map((r) => r.id)).toEqual(['route-abcdef']);
    expect(plan.hints.map((h) => [h.text, h.pageId])).toEqual([['在大廳先領獎勵', P.lobby]]);
    expect(plan.uploads.map((u) => u.to).sort()).toEqual([P.lobby, P.slot].sort());
  });
});

describe('API:預覽 → 套用', () => {
  function deps() {
    const { store, client } = fakeS3();
    return {
      store,
      d: {
        bucket: 'b', sharedS3: client, getTenantS3: async () => client,
        draftCase: async () => '', enqueueJob: async () => {}, hasher: { hash: (s: string) => s, randomToken: () => 't' },
      } as unknown as ApiDeps,
    };
  }
  const claims = { 'custom:tenantId': 't-1', sub: 'u-1', email: 'qa@example.com' };
  const body = (extra: Record<string, unknown> = {}) => ({
    app: 'app-dst',
    manifest: { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, app: { id: 'app-src', name: 'Example Slots' }, exportedAt: '2026-11-03T00:00:00.000Z' },
    structure: structure(), edits: {}, hints: [hint('hint-aaaaaa1', '先關掉活動彈窗')], screenshots: [],
    ...extra,
  });

  test('預覽不寫入;套用寫入三個檔與匯入紀錄;同一份再匯一次被拒', async () => {
    const { store, d } = deps();
    const pre = await handleRequest({ method: 'POST', path: '/memory/import/preview', claims, body: body() }, d);
    expect(pre.status).toBe(200);
    expect((pre.body as { summary: { pages: { added: number } } }).summary.pages.added).toBe(3);
    expect([...store.keys()].some((k) => k.includes('/memory/app-dst/'))).toBe(false);

    const ap = await handleRequest({ method: 'POST', path: '/memory/import/apply', claims, body: body() }, d);
    expect(ap.status).toBe(200);
    const base = 'tenants/t-1/memory/app-dst';
    expect(Object.keys(JSON.parse(store.get(`${base}/structure.json`)!).pages)).toHaveLength(3);
    expect(JSON.parse(store.get(`${base}/hints.json`)!).hints).toHaveLength(1);
    const log = JSON.parse(store.get(`${base}/imports.json`)!).items;
    expect(log[0]).toMatchObject({ by: 'qa@example.com', fromApp: 'app-src', exportedAt: '2026-11-03T00:00:00.000Z' });
    expect(JSON.stringify([...store.values()])).not.toContain('hunter2-secret');

    const again = await handleRequest({ method: 'POST', path: '/memory/import/apply', claims, body: body() }, d);
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe('ALREADY_IMPORTED');
  });

  test('應用有測試正在進行時拒絕匯入', async () => {
    const { store, d } = deps();
    store.set('tenants/t-1/jobs/job-zzz/job.json', JSON.stringify({ jobId: 'job-zzz', appId: 'app-dst', caseId: 'c', backend: 'emulator', createdAt: AT }));
    store.set('tenants/t-1/jobs/job-zzz/status.json', JSON.stringify({ jobId: 'job-zzz', state: 'running', updatedAt: AT }));
    const r = await handleRequest({ method: 'POST', path: '/memory/import/preview', claims, body: body() }, d);
    expect(r.status).toBe(409);
    expect((r.body as { code: string }).code).toBe('APP_HAS_RUNNING_JOBS');
  });

  test('格式錯誤回 400', async () => {
    const { d } = deps();
    const r = await handleRequest({ method: 'POST', path: '/memory/import/preview', claims, body: body({ manifest: { format: 'x' } }) }, d);
    expect(r.status).toBe(400);
  });
});
