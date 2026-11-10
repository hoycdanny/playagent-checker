import { describe, expect, test } from 'vitest';
import { handleRequest, type ApiDeps } from '../lambda/api/core.js';

/**
 * 判定覆核的端到端串接(走真實的路由處理器)。
 *
 * 為什麼需要這一層:覆寫的語意已經在 finding-overrides.test.ts 驗過,儲存在
 * report-overrides-store.test.ts 驗過,但「送一筆覆核進去 → 報告重算 →
 * 記憶被寫入」這一整串沒有任何測試覆蓋,而它剛好是串接最多的一段:
 * 路由 → 驗證 → S3 → 報告組裝 → 引擎重算 → 記憶回寫。
 *
 * 這組測試不涵蓋瀏覽器與真實網路,但涵蓋其餘每一段。
 */

function fakeDeps(): ApiDeps & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const meta = new Map<string, Record<string, string>>();
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      const key = cmd.input['Key'] as string;
      if (name === 'PutObjectCommand') {
        store.set(key, String(cmd.input['Body'] ?? ''));
        if (cmd.input['Metadata']) meta.set(key, cmd.input['Metadata'] as Record<string, string>);
        return {};
      }
      if (name === 'GetObjectCommand') {
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
        const prefix = (cmd.input['Prefix'] as string) ?? '';
        return { Contents: [...store.keys()].filter((k) => k.startsWith(prefix)).map((Key) => ({ Key })) };
      }
      if (name === 'DeleteObjectCommand') { store.delete(key); return {}; }
      return {};
    },
  };
  return {
    bucket: 'test-bucket',
    store,
    sharedS3: client as never,
    getTenantS3: async () => client as never,
    draftCase: async () => '',
    enqueueJob: async () => {},
    hasher: { hash: (s: string) => `hash(${s})`, randomToken: () => 'tok' },
  } as unknown as ApiDeps & { store: Map<string, string> };
}

const claims = { 'custom:tenantId': 't-001', sub: 'u-1', email: 'tester@example.com' };
const T = 'tenants/t-001/';
const JOB = 'job-ovr-1';

/** 一次有「疑似閃退」的執行:foregroundLost + appState<=1 且有值 → 已確認的遊戲缺陷。 */
function seed(deps: ReturnType<typeof fakeDeps>) {
  deps.store.set(`${T}apps/app-1.json`, JSON.stringify({ id: 'app-1', name: 'Demo', platform: 'android', genre: 'slot' }));
  deps.store.set(`${T}jobs/${JOB}/job.json`, JSON.stringify({
    jobId: JOB, appId: 'app-1', caseId: 'exploration', backend: 'devicefarm', platform: 'android',
  }));
  deps.store.set(`${T}jobs/${JOB}/report.json`, JSON.stringify({
    jobId: JOB, state: 'fail', task: '探索遊戲',
    steps: [
      { index: 0, screen: '大廳', action: 'tap', x: 5, y: 5 },
      { index: 1, screen: '大廳', action: 'tap', x: 5, y: 5, prevAction: 'tap', foregroundLost: true, appState: 0 },
      { index: 2, screen: '大廳', action: 'done' },
    ],
  }));
}

const getReport = async (deps: ReturnType<typeof fakeDeps>) =>
  handleRequest({ method: 'GET', path: `/reports/${JOB}`, claims }, deps);

type Structured = {
  findings: Array<{ id: string; classification: string; severity: string; category: string; override?: { original: { classification: string }; reason: string; by: string; dismissed: boolean } }>;
  counts: { defects: Record<string, number> };
  release: { overrides?: { total: number; dismissed: number; reclassified: number } };
  notes: Array<{ zh: string }>;
};
const structuredOf = (res: { body: unknown }) =>
  (res.body as { structured: Structured }).structured;

describe('覆核前:機器判定', () => {
  test('當機被判為已確認的遊戲缺陷', async () => {
    const deps = fakeDeps();
    seed(deps);
    const r = structuredOf(await getReport(deps));
    const crash = r.findings.find((f) => f.category === 'crash');
    expect(crash, '這個情境應該產生當機缺陷').toBeDefined();
    expect(crash!.classification).toBe('GAME_FAILURE');
    expect(r.counts.defects.critical).toBeGreaterThan(0);
    expect(r.release.overrides).toBeUndefined();
  });
});

describe('送一筆覆核 → 報告重算', () => {
  test('標為誤判後,報告的判定、統計與說明一起變', async () => {
    const deps = fakeDeps();
    seed(deps);
    const before = structuredOf(await getReport(deps));
    const crash = before.findings.find((f) => f.category === 'crash')!;

    const post = await handleRequest({
      method: 'POST', path: `/tasks/${JOB}/report-overrides`, claims,
      body: {
        findingId: crash.id, dismissed: true,
        reason: '裝置被系統回收,不是遊戲崩潰',
        remember: true, findingTitle: '疑似閃退', screen: '大廳',
      },
    }, deps);
    expect(post.status).toBe(201);

    // 1. 覆核者與時間由伺服器填(前端沒送 by/at)
    const stored = JSON.parse(deps.store.get(`${T}jobs/${JOB}/overrides.json`)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].by).toBe('tester@example.com');
    expect(typeof stored[0].at).toBe('string');

    // 2. 報告重新讀出來已套用
    const after = structuredOf(await getReport(deps));
    const same = after.findings.find((f) => f.id === crash.id)!;
    expect(same.classification).toBe('NEEDS_TRIAGE');
    expect(same.override!.original.classification).toBe('GAME_FAILURE');
    expect(same.override!.reason).toBe('裝置被系統回收,不是遊戲崩潰');
    expect(same.override!.by).toBe('tester@example.com');

    // 3. 統計與說明
    expect(after.counts.defects.critical).toBeLessThan(before.counts.defects.critical);
    expect(after.release.overrides).toEqual({ total: 1, dismissed: 1, reclassified: 0 });
    expect(after.notes.some((n) => n.zh.includes('人工覆寫'))).toBe(true);
  });

  test('改判嚴重性也會重算', async () => {
    const deps = fakeDeps();
    seed(deps);
    const crash = structuredOf(await getReport(deps)).findings.find((f) => f.category === 'crash')!;
    await handleRequest({
      method: 'POST', path: `/tasks/${JOB}/report-overrides`, claims,
      body: { findingId: crash.id, severity: 'low', reason: '只在這台偶發' },
    }, deps);
    const after = structuredOf(await getReport(deps));
    expect(after.findings.find((f) => f.id === crash.id)!.severity).toBe('low');
    expect(after.release.overrides).toEqual({ total: 1, dismissed: 0, reclassified: 1 });
  });

  test('第二筆覆核是追加,報告以時間最晚的為準', async () => {
    const deps = fakeDeps();
    seed(deps);
    const crash = structuredOf(await getReport(deps)).findings.find((f) => f.category === 'crash')!;
    await handleRequest({
      method: 'POST', path: `/tasks/${JOB}/report-overrides`, claims,
      body: { findingId: crash.id, dismissed: true, reason: '以為是環境問題' },
    }, deps);
    await handleRequest({
      method: 'POST', path: `/tasks/${JOB}/report-overrides`, claims,
      body: { findingId: crash.id, classification: 'GAME_FAILURE', reason: '重現過了,是真的' },
    }, deps);

    // 稽核軌跡:兩筆都留著
    expect(JSON.parse(deps.store.get(`${T}jobs/${JOB}/overrides.json`)!)).toHaveLength(2);
    // 報告以最新的為準
    const after = structuredOf(await getReport(deps));
    expect(after.findings.find((f) => f.id === crash.id)!.classification).toBe('GAME_FAILURE');
  });
});

describe('回寫應用記憶', () => {
  const hintsKey = (deps: ReturnType<typeof fakeDeps>) =>
    [...deps.store.keys()].find((k) => k.endsWith('hints.json'));

  test('勾選記住 → 寫入一條標為 verdict_review 的記憶', async () => {
    const deps = fakeDeps();
    seed(deps);
    const crash = structuredOf(await getReport(deps)).findings.find((f) => f.category === 'crash')!;
    const res = await handleRequest({
      method: 'POST', path: `/tasks/${JOB}/report-overrides`, claims,
      body: {
        findingId: crash.id, dismissed: true, reason: '載入中的正常狀態',
        remember: true, findingTitle: '疑似閃退', screen: '大廳',
      },
    }, deps);
    expect((res.body as { hintId?: string }).hintId).toBeTruthy();

    const key = hintsKey(deps);
    expect(key, '應該寫進這個 App 的記憶').toBeTruthy();
    const doc = JSON.parse(deps.store.get(key!)!);
    expect(doc.hints).toHaveLength(1);
    const h = doc.hints[0];
    // 來源要可辨識:這類記憶是跨任務的,出問題時要知道該停用哪些
    expect(h.source).toBe('verdict_review');
    expect(h.jobId).toBe(JOB);
    expect(h.createdBy).toBe('tester@example.com');
    // 文字要有指向,而且理由原文保留
    expect(h.text).toContain('大廳');
    expect(h.text).toContain('疑似閃退');
    expect(h.text).toContain('載入中的正常狀態');
  });

  test('沒勾選 → 不寫記憶(跨任務的影響必須是明確選的)', async () => {
    const deps = fakeDeps();
    seed(deps);
    const crash = structuredOf(await getReport(deps)).findings.find((f) => f.category === 'crash')!;
    await handleRequest({
      method: 'POST', path: `/tasks/${JOB}/report-overrides`, claims,
      body: { findingId: crash.id, dismissed: true, reason: 'x' },
    }, deps);
    expect(hintsKey(deps)).toBeUndefined();
  });

  test('載入畫面不當記憶範圍(沿用操作員指令那條規則)', async () => {
    const deps = fakeDeps();
    seed(deps);
    const crash = structuredOf(await getReport(deps)).findings.find((f) => f.category === 'crash')!;
    await handleRequest({
      method: 'POST', path: `/tasks/${JOB}/report-overrides`, claims,
      body: {
        findingId: crash.id, dismissed: true, reason: 'x',
        remember: true, findingTitle: '閃退', screen: '載入中',
      },
    }, deps);
    const doc = JSON.parse(deps.store.get(hintsKey(deps)!)!);
    // 記憶仍會寫,但不綁在載入畫面上(綁了之後只在載入畫面提醒,沒有意義)
    expect(doc.hints[0].screen).toBeUndefined();
  });
});

describe('把關', () => {
  test('沒有理由 → 400,而且不寫任何東西', async () => {
    const deps = fakeDeps();
    seed(deps);
    const res = await handleRequest({
      method: 'POST', path: `/tasks/${JOB}/report-overrides`, claims,
      body: { findingId: 'DEF-1', dismissed: true },
    }, deps);
    expect(res.status).toBe(400);
    expect(deps.store.has(`${T}jobs/${JOB}/overrides.json`)).toBe(false);
  });

  test('什麼都沒改 → 400', async () => {
    const deps = fakeDeps();
    seed(deps);
    const res = await handleRequest({
      method: 'POST', path: `/tasks/${JOB}/report-overrides`, claims,
      body: { findingId: 'DEF-1', reason: '只是想註解' },
    }, deps);
    expect(res.status).toBe(400);
  });

  test('任務不存在 → 404', async () => {
    const deps = fakeDeps();
    const res = await handleRequest({
      method: 'POST', path: '/tasks/job-nope/report-overrides', claims,
      body: { findingId: 'DEF-1', dismissed: true, reason: 'x' },
    }, deps);
    expect(res.status).toBe(404);
  });

  test('GET 讀得回紀錄', async () => {
    const deps = fakeDeps();
    seed(deps);
    await handleRequest({
      method: 'POST', path: `/tasks/${JOB}/report-overrides`, claims,
      body: { findingId: 'DEF-1', dismissed: true, reason: 'x' },
    }, deps);
    const res = await handleRequest({ method: 'GET', path: `/tasks/${JOB}/report-overrides`, claims }, deps);
    expect(res.status).toBe(200);
    expect((res.body as { items: unknown[] }).items).toHaveLength(1);
  });

  test('一般成員不能清空紀錄(會抹掉稽核軌跡)', async () => {
    const deps = fakeDeps();
    seed(deps);
    const res = await handleRequest({ method: 'DELETE', path: `/tasks/${JOB}/report-overrides`, claims }, deps);
    expect(res.status).toBe(403);
  });
});
