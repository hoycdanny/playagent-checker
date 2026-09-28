import { describe, test, expect } from 'vitest';
import { handleRequest, type ApiDeps } from '../lambda/api/core.js';

/**
 * fake S3:以記憶體模擬 Put/Get/List。以 command 建構子名稱分派。
 */
function fakeDeps(): ApiDeps & {
  store: Map<string, string>;
  seenPrefixes: string[];
  enqueued: Array<{
    tenantId: string;
    jobId: string;
    backend: string;
    vlmModel?: string;
    seats?: { agent?: string; vlm?: string; subagent?: string };
  }>;
} {
  const store = new Map<string, string>();
  const meta = new Map<string, Record<string, string>>();
  const seenPrefixes: string[] = [];
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      if (name === 'PutObjectCommand') {
        store.set(cmd.input.Key as string, String(cmd.input.Body ?? ''));
        if (cmd.input.Metadata) {
          meta.set(cmd.input.Key as string, cmd.input.Metadata as Record<string, string>);
        }
        return {};
      }
      if (name === 'GetObjectCommand') {
        const key = cmd.input.Key as string;
        if (!store.has(key)) {
          const err = new Error('not found');
          err.name = 'NoSuchKey';
          throw err;
        }
        return {
          Body: { transformToString: async () => store.get(key) },
          Metadata: meta.get(key),
          ETag: `"etag-${key}"`,
        };
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = (cmd.input.Prefix as string) ?? '';
        seenPrefixes.push(prefix);
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
        return { Contents: keys.map((Key) => ({ Key })) };
      }
      if (name === 'DeleteObjectCommand') {
        store.delete(cmd.input.Key as string);
        meta.delete(cmd.input.Key as string);
        return {};
      }
      if (name === 'DeleteObjectsCommand') {
        const del = cmd.input.Delete as { Objects?: Array<{ Key: string }> } | undefined;
        for (const o of del?.Objects ?? []) {
          store.delete(o.Key);
          meta.delete(o.Key);
        }
        return {};
      }
      return {};
    },
  };
  const enqueued: Array<{
    tenantId: string;
    jobId: string;
    backend: string;
    vlmModel?: string;
    seats?: { agent?: string; vlm?: string; subagent?: string };
  }> = [];
  return {
    bucket: 'test-bucket',
    store,
    seenPrefixes,
    enqueued,
    // 共用命名空間(shared/*)在測試裡就用同一個記憶體 client(不隔租戶)。
    sharedS3: client as never,
    getTenantS3: async () => client as never,
    draftCase: async (description: string, appId: string, baseYaml?: string) =>
      baseYaml
        ? `name: refined\napp: ${appId}\ntask: ${description || '(潤飾)'}\n# from-template`
        : `name: drafted\napp: ${appId}\ntask: ${description}\nassertions:\n  - done`,
    enqueueJob: async (msg) => {
      enqueued.push(msg);
    },
    hasher: {
      hash: (input: string) => `hash(${input})`,
      randomToken: () => 'tok-fixed-0000',
    },
  };
}

const claims = { 'custom:tenantId': 't-001', sub: 'u-1', email: 'a@example.com' };

describe('API 核心 — 身分', () => {
  test('無 claims → 401', async () => {
    const res = await handleRequest(
      { method: 'GET', path: '/apps', claims: null },
      fakeDeps(),
    );
    expect(res.status).toBe(401);
  });

  test('GET /me 回租戶', async () => {
    const res = await handleRequest(
      { method: 'GET', path: '/me', claims },
      fakeDeps(),
    );
    expect(res.body).toEqual({ tenantId: 't-001', email: 'a@example.com' });
  });

  test('未知路由 → 404', async () => {
    const res = await handleRequest(
      { method: 'GET', path: '/nope', claims },
      fakeDeps(),
    );
    expect(res.status).toBe(404);
  });
});

describe('API 核心 — App CRUD', () => {
  test('POST /apps 建立後 GET /apps 讀得到', async () => {
    const deps = fakeDeps();
    const created = await handleRequest(
      {
        method: 'POST',
        path: '/apps',
        claims,
        body: { name: 'Demo Game', platform: 'android', identifier: 'com.demo.game' },
      },
      deps,
    );
    expect(created.status).toBe(201);
    const record = created.body as { id: string; name: string; platform: string };
    expect(record.name).toBe('Demo Game');
    expect(record.platform).toBe('android');

    const list = await handleRequest({ method: 'GET', path: '/apps', claims }, deps);
    expect(list.status).toBe(200);
    const items = (list.body as { items: Array<{ id: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(record.id);
  });

  test('POST /apps 缺 name → 400', async () => {
    const res = await handleRequest(
      { method: 'POST', path: '/apps', claims, body: { platform: 'android' } },
      fakeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test('POST /apps 非法 platform → 400', async () => {
    const res = await handleRequest(
      {
        method: 'POST',
        path: '/apps',
        claims,
        body: { name: 'X', platform: 'mainframe' },
      },
      fakeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test('App 物件落在租戶前綴', async () => {
    const deps = fakeDeps();
    await handleRequest(
      { method: 'POST', path: '/apps', claims, body: { name: 'X', platform: 'web' } },
      deps,
    );
    expect([...deps.store.keys()].every((k) => k.startsWith('tenants/t-001/apps/'))).toBe(
      true,
    );
  });

  /** 建立一個 App 並回傳其 id(供更新/刪除測試複用)。 */
  async function createDemoApp(deps: ReturnType<typeof fakeDeps>): Promise<string> {
    const created = await handleRequest(
      {
        method: 'POST',
        path: '/apps',
        claims,
        body: { name: 'Demo', platform: 'android', identifier: 'com.demo' },
      },
      deps,
    );
    return (created.body as { id: string }).id;
  }

  test('PUT /apps/{id} 局部更新名稱與備註', async () => {
    const deps = fakeDeps();
    const id = await createDemoApp(deps);
    const res = await handleRequest(
      {
        method: 'PUT',
        path: `/apps/${id}`,
        claims,
        body: { name: 'Renamed', notes: '需先登入' },
      },
      deps,
    );
    expect(res.status).toBe(200);
    const rec = res.body as { name: string; notes?: string; platform: string; identifier?: string };
    expect(rec.name).toBe('Renamed');
    expect(rec.notes).toBe('需先登入');
    // 未提供的欄位維持不變
    expect(rec.platform).toBe('android');
    expect(rec.identifier).toBe('com.demo');
  });

  test('PUT /apps/{id} 以空字串清除識別碼', async () => {
    const deps = fakeDeps();
    const id = await createDemoApp(deps);
    const res = await handleRequest(
      { method: 'PUT', path: `/apps/${id}`, claims, body: { identifier: '' } },
      deps,
    );
    expect(res.status).toBe(200);
    expect((res.body as { identifier?: string }).identifier).toBeUndefined();
  });

  test('PUT /apps/{id} 找不到 → 404', async () => {
    const res = await handleRequest(
      { method: 'PUT', path: '/apps/app-nope', claims, body: { name: 'X' } },
      fakeDeps(),
    );
    expect(res.status).toBe(404);
  });

  test('PUT /apps/{id} 非法 platform → 400', async () => {
    const deps = fakeDeps();
    const id = await createDemoApp(deps);
    const res = await handleRequest(
      { method: 'PUT', path: `/apps/${id}`, claims, body: { platform: 'mainframe' } },
      deps,
    );
    expect(res.status).toBe(400);
  });

  test('DELETE /apps/{id} 後 GET /apps 讀不到', async () => {
    const deps = fakeDeps();
    const id = await createDemoApp(deps);
    const del = await handleRequest(
      { method: 'DELETE', path: `/apps/${id}`, claims },
      deps,
    );
    expect(del.status).toBe(200);
    const list = await handleRequest({ method: 'GET', path: '/apps', claims }, deps);
    const items = (list.body as { items: unknown[] }).items;
    expect(items).toHaveLength(0);
  });

  test('GET /apps/{id} 找不到 → 404', async () => {
    const res = await handleRequest(
      { method: 'GET', path: '/apps/app-nope', claims },
      fakeDeps(),
    );
    expect(res.status).toBe(404);
  });
});

describe('API 核心 — 上傳', () => {
  test('POST /uploads 非法 kind → 400', async () => {
    const res = await handleRequest(
      { method: 'POST', path: '/uploads', claims, body: { kind: 'exe' } },
      fakeDeps(),
    );
    expect(res.status).toBe(400);
  });

  // 註:presigned URL 的產生需要真實 S3 客戶端簽章,單元測試以 fake 無法簽,
  //     故 presigned 正常路徑於部署後以 curl 驗證(見 tasks 3.4)。
});

describe('API 核心 — 案例', () => {
  test('POST /cases/draft 回 AI 草擬 YAML', async () => {
    const res = await handleRequest(
      {
        method: 'POST',
        path: '/cases/draft',
        claims,
        body: { description: '登入後完成一關', appId: 'app-1' },
      },
      fakeDeps(),
    );
    expect(res.status).toBe(200);
    expect((res.body as { yaml: string }).yaml).toContain('task:');
  });

  test('POST /cases/draft 缺 description → 400', async () => {
    const res = await handleRequest(
      { method: 'POST', path: '/cases/draft', claims, body: {} },
      fakeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test('POST /cases/draft 範本感知編修:帶 baseYaml 可不帶 description', async () => {
    const res = await handleRequest(
      {
        method: 'POST',
        path: '/cases/draft',
        claims,
        body: { appId: 'app-1', baseYaml: 'name: 到達「大廳」\ntask: 進入大廳' },
      },
      fakeDeps(),
    );
    expect(res.status).toBe(200);
    // 走編修分支(fakeDeps 對有 baseYaml 回 refined)。
    expect((res.body as { yaml: string }).yaml).toContain('refined');
  });

  test('POST /cases 存檔後 GET /cases 讀得到', async () => {
    const deps = fakeDeps();
    const created = await handleRequest(
      {
        method: 'POST',
        path: '/cases',
        claims,
        body: { app: 'app-1', name: '登入流程', yaml: 'name: login\ntask: log in' },
      },
      deps,
    );
    expect(created.status).toBe(201);
    const list = await handleRequest({ method: 'GET', path: '/cases', claims }, deps);
    const items = (list.body as { items: Array<{ name: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('登入流程');
  });

  test('POST /cases 含字面量密鑰 → 400(秘密邊界)', async () => {
    const res = await handleRequest(
      {
        method: 'POST',
        path: '/cases',
        claims,
        body: {
          app: 'app-1',
          name: 'x',
          yaml: 'task: log in\npassword: hunter2',
        },
      },
      fakeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test('POST /cases 含 ${ENV} 佔位密鑰 → 允許', async () => {
    const res = await handleRequest(
      {
        method: 'POST',
        path: '/cases',
        claims,
        body: {
          app: 'app-1',
          name: 'x',
          yaml: 'task: log in\npassword: ${GAME_PASSWORD}',
        },
      },
      fakeDeps(),
    );
    expect(res.status).toBe(201);
  });
});

describe('API 核心 — 共用知識庫', () => {
  test('POST /knowledge-bases 建立後 GET 讀得到', async () => {
    const deps = fakeDeps();
    const created = await handleRequest(
      {
        method: 'POST',
        path: '/knowledge-bases',
        claims,
        body: { name: 'Slot 知識', kind: 'category', genre: 'slot', markdown: '# RTP' },
      },
      deps,
    );
    expect(created.status).toBe(201);
    const kb = created.body as { id: string; kind: string; genre?: string };
    expect(kb.kind).toBe('category');
    expect(kb.genre).toBe('slot');

    const list = await handleRequest({ method: 'GET', path: '/knowledge-bases', claims }, deps);
    const items = (list.body as { items: Array<{ id: string; builtin?: boolean }> }).items;
    // 清單含平台內建(builtin)知識庫 + 剛建立的使用者項。
    expect(items.some((i) => i.id === kb.id)).toBe(true);
    expect(items.some((i) => i.builtin === true)).toBe(true);
  });

  test('知識庫存於 shared/ 前綴(跨租戶共用,不在租戶前綴)', async () => {
    const deps = fakeDeps();
    await handleRequest(
      {
        method: 'POST',
        path: '/knowledge-bases',
        claims,
        body: { name: 'RTP', kind: 'scenario', markdown: 'x' },
      },
      deps,
    );
    const keys = [...deps.store.keys()].filter((k) => k.includes('knowledge-bases'));
    expect(keys.length).toBe(1);
    expect(keys[0]!.startsWith('shared/knowledge-bases/')).toBe(true);
  });

  test('POST /knowledge-bases 缺 name → 400', async () => {
    const res = await handleRequest(
      { method: 'POST', path: '/knowledge-bases', claims, body: { kind: 'scenario' } },
      fakeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test('POST /knowledge-bases 非法 kind → 400', async () => {
    const res = await handleRequest(
      { method: 'POST', path: '/knowledge-bases', claims, body: { name: 'x', kind: 'bogus' } },
      fakeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test('PUT /knowledge-bases/{id} 更新 markdown', async () => {
    const deps = fakeDeps();
    const created = await handleRequest(
      { method: 'POST', path: '/knowledge-bases', claims, body: { name: 'x', kind: 'scenario', markdown: 'old' } },
      deps,
    );
    const id = (created.body as { id: string }).id;
    const res = await handleRequest(
      { method: 'PUT', path: `/knowledge-bases/${id}`, claims, body: { markdown: 'new' } },
      deps,
    );
    expect(res.status).toBe(200);
    expect((res.body as { markdown: string }).markdown).toBe('new');
  });

  test('DELETE /knowledge-bases/{id} 後使用者項消失(內建仍在)', async () => {
    const deps = fakeDeps();
    const created = await handleRequest(
      { method: 'POST', path: '/knowledge-bases', claims, body: { name: 'x', kind: 'scenario' } },
      deps,
    );
    const id = (created.body as { id: string }).id;
    await handleRequest({ method: 'DELETE', path: `/knowledge-bases/${id}`, claims }, deps);
    const list = await handleRequest({ method: 'GET', path: '/knowledge-bases', claims }, deps);
    const items = (list.body as { items: Array<{ id: string; builtin?: boolean }> }).items;
    // 使用者建立的項已移除;平台內建項不受影響仍在。
    expect(items.some((i) => i.id === id)).toBe(false);
    expect(items.every((i) => i.builtin === true)).toBe(true);
  });

  test('內建知識庫唯讀:PUT/DELETE 一律 400', async () => {
    const deps = fakeDeps();
    const put = await handleRequest(
      { method: 'PUT', path: '/knowledge-bases/kb-builtin-slot', claims, body: { markdown: 'x' } },
      deps,
    );
    expect(put.status).toBe(400);
    const del = await handleRequest(
      { method: 'DELETE', path: '/knowledge-bases/kb-builtin-slot', claims },
      deps,
    );
    expect(del.status).toBe(400);
    // GET 單一內建仍讀得到,且標 builtin。
    const got = await handleRequest(
      { method: 'GET', path: '/knowledge-bases/kb-builtin-slot', claims },
      deps,
    );
    expect(got.status).toBe(200);
    expect((got.body as { builtin?: boolean }).builtin).toBe(true);
  });

  test('GET /knowledge-bases/{id} 找不到 → 404', async () => {
    const res = await handleRequest(
      { method: 'GET', path: '/knowledge-bases/kb-nope', claims },
      fakeDeps(),
    );
    expect(res.status).toBe(404);
  });

  test('提交任務帶 knowledgeBaseIds → 快照進 job.json', async () => {
    const deps = fakeDeps();
    deps.store.set('tenants/t-001/apps/app-1.json', JSON.stringify({ id: 'app-1' }));
    deps.store.set('tenants/t-001/cases/app-1/case-1.yaml', 'task: x');
    const created = await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        body: { backend: 'web', appId: 'app-1', caseId: 'case-1', knowledgeBaseIds: ['kb-a', 'kb-b'] },
      },
      deps,
    );
    const jobId = (created.body as { jobId: string }).jobId;
    const job = JSON.parse(deps.store.get(`tenants/t-001/jobs/${jobId}/job.json`)!);
    expect(job.knowledgeBaseIds).toEqual(['kb-a', 'kb-b']);
  });

  test('提交未帶 knowledgeBaseIds 時套用 App 預設', async () => {
    const deps = fakeDeps();
    deps.store.set(
      'tenants/t-001/apps/app-1.json',
      JSON.stringify({ id: 'app-1', defaultKnowledgeBaseIds: ['kb-default'] }),
    );
    deps.store.set('tenants/t-001/cases/app-1/case-1.yaml', 'task: x');
    const created = await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        body: { backend: 'web', appId: 'app-1', caseId: 'case-1' },
      },
      deps,
    );
    const jobId = (created.body as { jobId: string }).jobId;
    const job = JSON.parse(deps.store.get(`tenants/t-001/jobs/${jobId}/job.json`)!);
    expect(job.knowledgeBaseIds).toEqual(['kb-default']);
  });

  test('App 有 genre 時自動掛上對應內建類型知識庫(放最前,與明選去重)', async () => {
    const deps = fakeDeps();
    deps.store.set(
      'tenants/t-001/apps/app-1.json',
      JSON.stringify({ id: 'app-1', genre: 'slot' }),
    );
    deps.store.set('tenants/t-001/cases/app-1/case-1.yaml', 'task: x');
    const created = await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        body: { backend: 'web', appId: 'app-1', caseId: 'case-1', knowledgeBaseIds: ['kb-a'] },
      },
      deps,
    );
    const jobId = (created.body as { jobId: string }).jobId;
    const job = JSON.parse(deps.store.get(`tenants/t-001/jobs/${jobId}/job.json`)!);
    // 內建 slot 知識庫排最前,使用者明選 kb-a 在後。
    expect(job.knowledgeBaseIds).toEqual(['kb-builtin-slot', 'kb-a']);
  });

  test('exploration 任務 + App genre 且案例無 task → 用依類型探索目標', async () => {
    const deps = fakeDeps();
    deps.store.set(
      'tenants/t-001/apps/app-1.json',
      JSON.stringify({ id: 'app-1', genre: 'tower_defense' }),
    );
    // 案例 YAML 無 task 欄位。
    deps.store.set('tenants/t-001/cases/app-1/case-1.yaml', 'name: 探索');
    const created = await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        body: { backend: 'web', appId: 'app-1', caseId: 'case-1', category: 'exploration' },
      },
      deps,
    );
    const jobId = (created.body as { jobId: string }).jobId;
    const job = JSON.parse(deps.store.get(`tenants/t-001/jobs/${jobId}/job.json`)!);
    expect(job.caseTask).toContain('塔防');
    // 同時也自動掛上塔防內建知識庫。
    expect(job.knowledgeBaseIds).toContain('kb-builtin-tower_defense');
  });
});

describe('API 核心 — 案例編輯/刪除', () => {
  async function createDemoCase(deps: ReturnType<typeof fakeDeps>): Promise<string> {
    const created = await handleRequest(
      {
        method: 'POST',
        path: '/cases',
        claims,
        body: { app: 'app-1', name: 'Login flow', yaml: 'task: log in' },
      },
      deps,
    );
    return (created.body as { id: string }).id;
  }

  test('GET /cases/{app}/{id} 讀得到 YAML', async () => {
    const deps = fakeDeps();
    const id = await createDemoCase(deps);
    const res = await handleRequest(
      { method: 'GET', path: `/cases/app-1/${id}`, claims },
      deps,
    );
    expect(res.status).toBe(200);
    const body = res.body as { name: string; yaml: string };
    expect(body.name).toBe('Login flow');
    expect(body.yaml).toContain('task: log in');
  });

  test('PUT /cases/{app}/{id} 更新名稱與 YAML', async () => {
    const deps = fakeDeps();
    const id = await createDemoCase(deps);
    const res = await handleRequest(
      {
        method: 'PUT',
        path: `/cases/app-1/${id}`,
        claims,
        body: { name: 'Renamed', yaml: 'task: updated' },
      },
      deps,
    );
    expect(res.status).toBe(200);
    const got = await handleRequest(
      { method: 'GET', path: `/cases/app-1/${id}`, claims },
      deps,
    );
    const body = got.body as { name: string; yaml: string };
    expect(body.name).toBe('Renamed');
    expect(body.yaml).toContain('task: updated');
  });

  test('PUT /cases 含字面量密鑰 → 400(秘密邊界仍生效)', async () => {
    const deps = fakeDeps();
    const id = await createDemoCase(deps);
    const res = await handleRequest(
      {
        method: 'PUT',
        path: `/cases/app-1/${id}`,
        claims,
        body: { yaml: 'password: hunter2' },
      },
      deps,
    );
    expect(res.status).toBe(400);
  });

  test('PUT /cases 找不到 → 404', async () => {
    const res = await handleRequest(
      { method: 'PUT', path: '/cases/app-1/case-nope', claims, body: { name: 'x' } },
      fakeDeps(),
    );
    expect(res.status).toBe(404);
  });

  test('DELETE /cases/{app}/{id} 後 GET /cases 讀不到', async () => {
    const deps = fakeDeps();
    const id = await createDemoCase(deps);
    const del = await handleRequest(
      { method: 'DELETE', path: `/cases/app-1/${id}`, claims },
      deps,
    );
    expect(del.status).toBe(200);
    const list = await handleRequest({ method: 'GET', path: '/cases', claims }, deps);
    expect((list.body as { items: unknown[] }).items).toHaveLength(0);
  });
});

describe('API 核心 — 記憶地圖生成場景範本', () => {
  test('GET /memory/templates:無地圖回空陣列', async () => {
    const deps = fakeDeps();
    const res = await handleRequest(
      { method: 'GET', path: '/memory/templates', query: { app: 'app-1' }, claims },
      deps,
    );
    expect(res.status).toBe(200);
    expect((res.body as { items: unknown[] }).items).toEqual([]);
  });

  test('GET /memory/templates:有地圖時由可達路徑生成範本', async () => {
    const deps = fakeDeps();
    const p = (id: string, name: string) => ({
      id, name, pHash: '0'.repeat(64), screenshotRef: `screenshots/${id}.png`,
      knownControlLabels: [], visitCount: 1, hitCount: 1,
      firstSeenAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-01T00:00:00Z',
    });
    deps.store.set(
      'tenants/t-001/memory/app-1/structure.json',
      JSON.stringify({
        schemaVersion: 1, appName: 'app-1', rootPageId: 'p1', lastUpdatedAt: null,
        pages: { p1: p('p1', '主選單'), p2: p('p2', '設定') },
        edges: [{ fromPageId: 'p1', toPageId: 'p2', trigger: { kind: 'tap', label: '開設定' }, hitCount: 1, missCount: 0 }],
      }),
    );
    const res = await handleRequest(
      { method: 'GET', path: '/memory/templates', query: { app: 'app-1' }, claims },
      deps,
    );
    expect(res.status).toBe(200);
    const items = (res.body as { items: Array<{ targetScreen: string }> }).items;
    expect(items.some((i) => i.targetScreen === '設定')).toBe(true);
  });

  test('GET /memory/templates:缺 app → 400', async () => {
    const res = await handleRequest(
      { method: 'GET', path: '/memory/templates', claims },
      fakeDeps(),
    );
    expect(res.status).toBe(400);
  });
});

describe('API 核心 — 任務提交/取消', () => {
  /** 預先在 store 種入 app 與 case 物件,使提交前校驗通過。 */
  function seedAppAndCase(deps: ReturnType<typeof fakeDeps>) {
    deps.store.set('tenants/t-001/apps/app-1.json', JSON.stringify({ id: 'app-1' }));
    deps.store.set('tenants/t-001/cases/app-1/case-1.yaml', 'task: do it');
  }

  test('POST /tasks 成功建立、落初始狀態、送入佇列', async () => {
    const deps = fakeDeps();
    seedAppAndCase(deps);
    const res = await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        body: { backend: 'web', appId: 'app-1', caseId: 'case-1' },
      },
      deps,
    );
    expect(res.status).toBe(201);
    const jobId = (res.body as { jobId: string }).jobId;
    expect(jobId).toMatch(/^job-/);
    expect(deps.enqueued).toHaveLength(1);
    expect(deps.enqueued[0]!.backend).toBe('web');
    // 初始狀態為 running
    const statusRaw = deps.store.get(`tenants/t-001/jobs/${jobId}/status.json`);
    expect(JSON.parse(statusRaw!).state).toBe('running');
  });

  test('POST /tasks 可分別選三角色模型(agent/vlm/subagent),寫入 job 並帶 seats 入列', async () => {
    const deps = fakeDeps();
    seedAppAndCase(deps);
    const res = await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        body: {
          backend: 'devicefarm',
          appId: 'app-1',
          caseId: 'case-1',
          agentModel: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
          vlmModel: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
          subagentModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        },
      },
      deps,
    );
    expect(res.status).toBe(201);
    const jobId = (res.body as { jobId: string }).jobId;
    // job.json 落三角色模型選擇
    const job = JSON.parse(deps.store.get(`tenants/t-001/jobs/${jobId}/job.json`)!);
    expect(job.agentModel).toBe('us.anthropic.claude-opus-4-5-20251101-v1:0');
    expect(job.vlmModel).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(job.subagentModel).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    // 入列訊息帶 seats 供引擎解析
    expect(deps.enqueued[0]!.seats).toEqual({
      agent: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
      vlm: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      subagent: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    });
  });

  test('POST /tasks agent 模型不在 agent seat 清單 → 400', async () => {
    const deps = fakeDeps();
    seedAppAndCase(deps);
    const res = await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        // claude-3-haiku 只能坐 subagent,不能坐 agent → 應被拒。
        body: { backend: 'web', appId: 'app-1', caseId: 'case-1', agentModel: 'us.anthropic.claude-3-haiku-20240307-v1:0' },
      },
      deps,
    );
    expect(res.status).toBe(400);
  });

  test('POST /tasks App 不存在 → 400(花費前失敗)', async () => {
    const deps = fakeDeps();
    // 只種 case 不種 app
    deps.store.set('tenants/t-001/cases/app-1/case-1.yaml', 'task: x');
    const res = await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        body: { backend: 'web', appId: 'app-1', caseId: 'case-1' },
      },
      deps,
    );
    expect(res.status).toBe(400);
    expect(deps.enqueued).toHaveLength(0);
  });

  test('POST /tasks 非法 backend → 400', async () => {
    const res = await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        body: { backend: 'mainframe', appId: 'app-1', caseId: 'case-1' },
      },
      fakeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test('GET /tasks/{id}/logs 回傳每步互動 log(依 index 排序,含錯誤步)', async () => {
    const deps = fakeDeps();
    const jobId = 'job-logs1-dddd';
    const base = `tenants/t-001/jobs/${jobId}`;
    // 亂序寫入兩筆 trace,其中一筆為模型錯誤(body 太大)。
    deps.store.set(
      `${base}/traces/1.json`,
      JSON.stringify({
        index: 1, seat: 'vlm', modelId: 'qwen.qwen3-vl-235b-a22b', channel: 'converse',
        ok: false, request: { imageCount: 2, imageApproxKB: 4200 },
        error: { name: 'ValidationException', message: 'Failed to buffer the request body: length limit exceeded' },
      }),
    );
    deps.store.set(
      `${base}/traces/0.json`,
      JSON.stringify({
        index: 0, seat: 'vlm', modelId: 'qwen.qwen3-vl-235b-a22b', channel: 'converse',
        ok: true, request: { imageCount: 1, imageApproxKB: 800 }, rawResponse: '{"action":"tap"}',
        tokens: { input: 1200, output: 30 },
      }),
    );
    const res = await handleRequest({ method: 'GET', path: `/tasks/${jobId}/logs`, claims }, deps);
    expect(res.status).toBe(200);
    const items = (res.body as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((x) => x.index)).toEqual([0, 1]); // 依 index 排序
    expect(items[0]!.ok).toBe(true);
    expect(items[1]!.ok).toBe(false);
    expect((items[1]!.error as { message: string }).message).toContain('length limit exceeded');
  });

  test('POST /tasks/{id}/cancel:running → cancelled', async () => {
    const deps = fakeDeps();
    seedAppAndCase(deps);
    const created = await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        body: { backend: 'web', appId: 'app-1', caseId: 'case-1' },
      },
      deps,
    );
    const jobId = (created.body as { jobId: string }).jobId;
    const res = await handleRequest(
      { method: 'POST', path: `/tasks/${jobId}/cancel`, claims },
      deps,
    );
    expect(res.status).toBe(200);
    expect((res.body as { state: string }).state).toBe('cancelled');
    // cancel 旗標已寫
    expect(deps.store.has(`tenants/t-001/jobs/${jobId}/cancel.json`)).toBe(true);
  });

  test('cancel 不存在的任務 → 404', async () => {
    const res = await handleRequest(
      { method: 'POST', path: '/tasks/job-nope-xxxx/cancel', claims },
      fakeDeps(),
    );
    expect(res.status).toBe(404);
  });

  test('GET /tasks 回傳含狀態的清單', async () => {
    const deps = fakeDeps();
    seedAppAndCase(deps);
    await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        body: { backend: 'web', appId: 'app-1', caseId: 'case-1' },
      },
      deps,
    );
    const list = await handleRequest({ method: 'GET', path: '/tasks', claims }, deps);
    const items = (list.body as { items: Array<{ state: string; backend: string; locality: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.state).toBe('running');
    expect(items[0]!.locality).toBe('cloud');
  });

  test('GET /tasks 列表帶模型與(估算)花費(來自 report.json)', async () => {
    const deps = fakeDeps();
    seedAppAndCase(deps);
    const jobId = 'job-list1-cccc';
    const base = `tenants/t-001/jobs/${jobId}`;
    deps.store.set(
      `${base}/job.json`,
      JSON.stringify({
        jobId, tenantId: 't-001', backend: 'devicefarm', locality: 'cloud',
        category: 'exploration', appId: 'app-1', caseId: 'case-1',
        vlmModel: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
        createdAt: '2026-09-27T12:00:00.000Z',
      }),
    );
    deps.store.set(`${base}/status.json`, JSON.stringify({ state: 'pass', updatedAt: '2026-09-27T12:10:00.000Z' }));
    deps.store.set(
      `${base}/config.json`,
      JSON.stringify({
        budgetUsd: 1,
        seats: [
          { seat: 'agent', modelId: 'anthropic.claude-opus-4-5-20251101-v1:0', inputPerM: 15, outputPerM: 75 },
          { seat: 'vlm', modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0', inputPerM: 3, outputPerM: 15 },
          { seat: 'subagent', modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0', inputPerM: 1, outputPerM: 5 },
        ],
      }),
    );
    deps.store.set(
      `${base}/report.json`,
      JSON.stringify({
        vlmModel: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
        tokens: { input: 1_000_000, output: 1_000_000 },
      }),
    );
    const list = await handleRequest({ method: 'GET', path: '/tasks', claims }, deps);
    const items = (list.body as { items: Array<Record<string, unknown>> }).items;
    const it = items.find((x) => x.jobId === jobId)!;
    expect(it.vlmModel).toBe('anthropic.claude-sonnet-4-5-20250929-v1:0');
    // 三角色模型來自 config.seats。
    expect(it.seatModels).toEqual({
      agent: 'anthropic.claude-opus-4-5-20251101-v1:0',
      vlm: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      subagent: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    });
    // 花費以 vlm seat 單價估算:1M×$3 + 1M×$15 = $18。
    expect(it.billableSpendUsd).toBeCloseTo(18, 5);
    expect(it.spendEstimated).toBe(true);
  });

  test('DELETE /tasks/{jobId} 刪整包(job.json + status + 報告)後清單為空', async () => {
    const deps = fakeDeps();
    seedAppAndCase(deps);
    const created = await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        body: { backend: 'web', appId: 'app-1', caseId: 'case-1' },
      },
      deps,
    );
    const jobId = (created.body as { jobId: string }).jobId;
    // 種一份報告在同一 job 底下,確認會一起刪
    deps.store.set(`tenants/t-001/jobs/${jobId}/report.json`, '{"jobId":"x"}');

    const del = await handleRequest(
      { method: 'DELETE', path: `/tasks/${jobId}`, claims },
      deps,
    );
    expect(del.status).toBe(200);
    // job 前綴下所有物件都被清掉
    const remaining = [...deps.store.keys()].filter((k) =>
      k.startsWith(`tenants/t-001/jobs/${jobId}/`),
    );
    expect(remaining).toHaveLength(0);
    const list = await handleRequest({ method: 'GET', path: '/tasks', claims }, deps);
    expect((list.body as { items: unknown[] }).items).toHaveLength(0);
  });

  test('DELETE /tasks 非法 jobId → 400', async () => {
    const res = await handleRequest(
      { method: 'DELETE', path: '/tasks/not!valid', claims },
      fakeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test('GET /tasks/{id} 回傳 meta:情境 + 模型 + 花費(report 未記花費 → 由 token 估算)', async () => {
    const deps = fakeDeps();
    seedAppAndCase(deps);
    // 種一個含 vlmModel + 知識庫的 job、config 快照、report(有 task/tokens、無 billableSpendUsd)。
    const jobId = 'job-meta1-aaaa';
    const base = `tenants/t-001/jobs/${jobId}`;
    deps.store.set(
      `${base}/job.json`,
      JSON.stringify({
        jobId,
        tenantId: 't-001',
        backend: 'devicefarm',
        locality: 'cloud',
        category: 'exploration',
        appId: 'app-1',
        caseId: 'case-1',
        vlmModel: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
        knowledgeBaseIds: ['kb-builtin-slot', 'kb-a'],
        createdAt: '2026-09-27T12:00:00.000Z',
      }),
    );
    deps.store.set(
      `${base}/config.json`,
      JSON.stringify({
        budgetUsd: 1,
        seats: [
          { seat: 'agent', modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0', inputPerM: 3, outputPerM: 15 },
          { seat: 'vlm', modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0', inputPerM: 3, outputPerM: 15 },
          { seat: 'subagent', modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0', inputPerM: 3, outputPerM: 15 },
        ],
        resolvedAt: '2026-09-27T12:00:06.000Z',
      }),
    );
    deps.store.set(
      `${base}/report.json`,
      JSON.stringify({
        task: '探索這款拉霸遊戲',
        tokens: { input: 1_000_000, output: 1_000_000 },
        stepCount: 27,
      }),
    );

    const res = await handleRequest({ method: 'GET', path: `/tasks/${jobId}`, claims }, deps);
    expect(res.status).toBe(200);
    const meta = (res.body as { meta: Record<string, unknown> }).meta;
    expect(meta.task).toBe('探索這款拉霸遊戲');
    expect(meta.knowledgeBaseIds).toEqual(['kb-builtin-slot', 'kb-a']);
    expect(meta.vlmModel).toBe('anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect((meta.seats as unknown[]).length).toBe(3);
    expect(meta.budgetUsd).toBe(1);
    // 1M input × $3/M + 1M output × $15/M = $18;report 未記花費 → 估算。
    expect(meta.billableSpendUsd).toBeCloseTo(18, 5);
    expect(meta.spendEstimated).toBe(true);
  });

  test('GET /tasks/{id} meta:report 已記 billableSpendUsd → 直接採用(非估算)', async () => {
    const deps = fakeDeps();
    seedAppAndCase(deps);
    const jobId = 'job-meta2-bbbb';
    const base = `tenants/t-001/jobs/${jobId}`;
    deps.store.set(
      `${base}/job.json`,
      JSON.stringify({
        jobId, tenantId: 't-001', backend: 'web', locality: 'cloud',
        category: 'test', appId: 'app-1', caseId: 'case-1',
        createdAt: '2026-09-27T12:00:00.000Z',
      }),
    );
    deps.store.set(
      `${base}/report.json`,
      JSON.stringify({ billableSpendUsd: 0.42, budgetUsd: 5 }),
    );
    const res = await handleRequest({ method: 'GET', path: `/tasks/${jobId}`, claims }, deps);
    const meta = (res.body as { meta: Record<string, unknown> }).meta;
    expect(meta.billableSpendUsd).toBe(0.42);
    expect(meta.budgetUsd).toBe(5);
    expect(meta.spendEstimated).toBeUndefined();
  });

  test('GET /tasks/{id} meta:無 config/report 也不失敗(退化為空)', async () => {
    const deps = fakeDeps();
    seedAppAndCase(deps);
    const created = await handleRequest(
      {
        method: 'POST',
        path: '/tasks',
        claims,
        body: { backend: 'web', appId: 'app-1', caseId: 'case-1' },
      },
      deps,
    );
    const jobId = (created.body as { jobId: string }).jobId;
    const res = await handleRequest({ method: 'GET', path: `/tasks/${jobId}`, claims }, deps);
    expect(res.status).toBe(200);
    const meta = (res.body as { meta: Record<string, unknown> }).meta;
    expect(meta.seats).toEqual([]);
    expect(meta.knowledgeBaseIds).toEqual([]);
    expect(meta.billableSpendUsd).toBeUndefined();
    expect(meta.tokens).toBeUndefined();
  });
});
