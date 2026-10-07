import { describe, test, expect } from 'vitest';
import {
  buildVersionReport,
  fetchBehind,
  fetchRemoteVersion,
  isValidRef,
  looksLikeToken,
  startUpdate,
  UpdateError,
  type BuildProgress,
  type SystemUpdatePorts,
  type UpdateHistoryEntry,
} from '../lambda/api/systemUpdate.js';

const REPO = 'acme/playagent';

/** 可控的假 ports:每個測試只覆寫它關心的部分。 */
function makePorts(over: Partial<SystemUpdatePorts> & { routes?: Record<string, { status: number; body: unknown }> } = {}) {
  const history: UpdateHistoryEntry[] = [];
  const started: { ref: string; by: string; runTests: boolean }[] = [];
  const routes = over.routes ?? {};
  const ports: SystemUpdatePorts = {
    readToken: async () => 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa',
    writeToken: async () => {},
    readDeployed: async () => null,
    readHistory: async () => history,
    writeHistory: async (items) => { history.length = 0; history.push(...items); },
    github: async (path) => routes[path] ?? { status: 404, body: null },
    startBuild: async (env) => { started.push(env); return 'build-1'; },
    getBuild: async () => null,
    listBuildIds: async () => [],
    readLog: async () => ({ lines: [] }),
    ...over,
  };
  return { ports, history, started };
}

describe('系統更新 — 版本字串驗證', () => {
  test('接受 tag / 分支 / sha', () => {
    for (const ref of ['v1.2.3', 'main', 'release/2026-10', 'fcbbe2e', 'a'.repeat(40)]) {
      expect(isValidRef(ref)).toBe(true);
    }
  });

  test('拒絕會帶進 shell 或跳出倉庫的字串', () => {
    for (const ref of ['', ' ', 'main; rm -rf /', 'main && echo', '../../etc', 'a..b', '-flag', '$(whoami)', '`id`', 'a'.repeat(200)]) {
      expect(isValidRef(ref)).toBe(false);
    }
  });

  test('token 格式檢查只收合理長度的英數字串', () => {
    expect(looksLikeToken('github_pat_11AAAAAAA0bbbbbbbbb')).toBe(true);
    expect(looksLikeToken('short')).toBe(false);
    expect(looksLikeToken('has space in it aaaaaaaaaaaa')).toBe(false);
  });
});

describe('系統更新 — 最新版本解析', () => {
  test('有 release 就用 release tag', async () => {
    const { ports } = makePorts({
      routes: {
        [`/repos/${REPO}/releases/latest`]: { status: 200, body: { tag_name: 'v2.0.0', name: '第二版', published_at: '2026-10-01T00:00:00Z' } },
        [`/repos/${REPO}/commits/v2.0.0`]: { status: 200, body: { sha: 'deadbeef' } },
      },
    });
    const v = await fetchRemoteVersion(ports, 't', REPO);
    expect(v).toMatchObject({ kind: 'release', ref: 'v2.0.0', sha: 'deadbeef', subject: '第二版' });
  });

  test('沒有 release 但有 tag 就用最新 tag', async () => {
    const { ports } = makePorts({
      routes: {
        [`/repos/${REPO}/tags?per_page=1`]: { status: 200, body: [{ name: 'v1.9.0', commit: { sha: 'cafe' } }] },
      },
    });
    const v = await fetchRemoteVersion(ports, 't', REPO);
    expect(v).toMatchObject({ kind: 'tag', ref: 'v1.9.0', sha: 'cafe' });
  });

  test('兩者都沒有就退回預設分支最新 commit(只取第一行訊息)', async () => {
    const { ports } = makePorts({
      routes: {
        [`/repos/${REPO}`]: { status: 200, body: { default_branch: 'main' } },
        [`/repos/${REPO}/commits/main`]: { status: 200, body: { sha: 'abc123', commit: { message: '標題\n\n內文' } } },
      },
    });
    const v = await fetchRemoteVersion(ports, 't', REPO);
    expect(v).toMatchObject({ kind: 'branch', ref: 'main', sha: 'abc123', subject: '標題' });
  });

  test('token 無效時給得出原因,而不是丟原始狀態碼', async () => {
    const { ports } = makePorts({ routes: { [`/repos/${REPO}`]: { status: 401, body: null } } });
    await expect(fetchRemoteVersion(ports, 't', REPO)).rejects.toThrow('token 無效');
  });
});

describe('系統更新 — 落後的 commit', () => {
  test('回傳最新在前的清單與 ahead_by', async () => {
    const { ports } = makePorts({
      routes: {
        [`/repos/${REPO}/compare/old...new`]: {
          status: 200,
          body: {
            ahead_by: 2,
            commits: [
              { sha: '1', commit: { message: '舊的', author: { name: 'A', date: '2026-10-01T00:00:00Z' } } },
              { sha: '2', commit: { message: '新的', author: { name: 'B' } } },
            ],
          },
        },
      },
    });
    const r = await fetchBehind(ports, 't', REPO, 'old', 'new');
    expect(r.count).toBe(2);
    expect(r.commits.map((c) => c.sha)).toEqual(['2', '1']);
    expect(r.commits[0]).toMatchObject({ subject: '新的', author: 'B' });
  });

  test('同一個版本不呼叫 compare', async () => {
    let calls = 0;
    const { ports } = makePorts({ github: async () => { calls++; return { status: 200, body: {} }; } });
    expect(await fetchBehind(ports, 't', REPO, 'same', 'same')).toEqual({ count: 0, commits: [] });
    expect(calls).toBe(0);
  });
});

describe('系統更新 — 版本狀態報告', () => {
  test('沒有 token 時不打 GitHub,只回已部署版本與 tokenConfigured:false', async () => {
    let calls = 0;
    const { ports } = makePorts({
      readToken: async () => null,
      readDeployed: async () => ({ ref: 'v1', sha: 'aaa' }),
      github: async () => { calls++; return { status: 200, body: {} }; },
    });
    const r = await buildVersionReport(ports, REPO);
    expect(r.tokenConfigured).toBe(false);
    expect(r.deployed).toMatchObject({ ref: 'v1' });
    expect(r.latest).toBeNull();
    expect(calls).toBe(0);
  });

  test('GitHub 讀取失敗時仍回得出頁面內容,錯誤放在 error', async () => {
    const { ports } = makePorts({
      readDeployed: async () => ({ ref: 'v1', sha: 'aaa' }),
      routes: { [`/repos/${REPO}`]: { status: 403, body: null } },
    });
    const r = await buildVersionReport(ports, REPO);
    expect(r.error).toContain('拒絕存取');
    expect(r.deployed).not.toBeNull();
  });

  test('sha 相同視為已是最新', async () => {
    const { ports } = makePorts({
      readDeployed: async () => ({ ref: 'v2.0.0', sha: 'deadbeef' }),
      routes: {
        [`/repos/${REPO}/releases/latest`]: { status: 200, body: { tag_name: 'v2.0.0' } },
        [`/repos/${REPO}/commits/v2.0.0`]: { status: 200, body: { sha: 'deadbeef' } },
        [`/repos/${REPO}/compare/deadbeef...deadbeef`]: { status: 200, body: { ahead_by: 0, commits: [] } },
      },
    });
    const r = await buildVersionReport(ports, REPO);
    expect(r.updateAvailable).toBe(false);
  });

  test('沒有已部署紀錄時視為可更新(讓第一次能把版本登記起來)', async () => {
    const { ports } = makePorts({
      routes: {
        [`/repos/${REPO}/releases/latest`]: { status: 200, body: { tag_name: 'v1' } },
        [`/repos/${REPO}/commits/v1`]: { status: 200, body: { sha: 'x1' } },
      },
    });
    const r = await buildVersionReport(ports, REPO);
    expect(r.updateAvailable).toBe(true);
  });
});

describe('系統更新 — 觸發更新的四道檢查', () => {
  const okRoutes = { [`/repos/${REPO}/commits/v1`]: { status: 200, body: { sha: 'sha1' } } };

  test('成功時啟動 build 並記一筆 started', async () => {
    const { ports, history, started } = makePorts({ routes: okRoutes });
    const r = await startUpdate(ports, REPO, { ref: 'v1', by: 'admin@example.com' });
    expect(r).toMatchObject({ buildId: 'build-1', ref: 'v1', sha: 'sha1' });
    expect(started[0]).toMatchObject({ ref: 'v1', by: 'admin@example.com', runTests: true });
    expect(history[0]).toMatchObject({ ref: 'v1', result: 'started', by: 'admin@example.com' });
  });

  test('沒有 token 就擋下', async () => {
    const { ports } = makePorts({ readToken: async () => null });
    await expect(startUpdate(ports, REPO, { ref: 'v1', by: 'a' })).rejects.toThrow(UpdateError);
  });

  test('版本字串不合法就擋下,且不呼叫 GitHub', async () => {
    let calls = 0;
    const { ports } = makePorts({ github: async () => { calls++; return { status: 200, body: {} }; } });
    await expect(startUpdate(ports, REPO, { ref: 'main; rm -rf /', by: 'a' })).rejects.toThrow('格式不正確');
    expect(calls).toBe(0);
  });

  test('GitHub 上不存在的版本就擋下', async () => {
    const { ports } = makePorts({ routes: {} });
    await expect(startUpdate(ports, REPO, { ref: 'v9', by: 'a' })).rejects.toThrow('找不到版本');
  });

  test('已有更新在跑就擋下', async () => {
    const running: BuildProgress = { buildId: 'b0', status: 'IN_PROGRESS', phases: [] };
    const { ports } = makePorts({
      routes: okRoutes,
      listBuildIds: async () => ['b0'],
      getBuild: async () => running,
    });
    await expect(startUpdate(ports, REPO, { ref: 'v1', by: 'a' })).rejects.toThrow('已有更新正在執行');
  });

  test('有任務在跑時第一次擋下,帶 force 才過', async () => {
    const { ports } = makePorts({ routes: okRoutes, countActiveRuns: async () => 2 });
    await expect(startUpdate(ports, REPO, { ref: 'v1', by: 'a' })).rejects.toThrow('2 個測試任務');
    const r = await startUpdate(ports, REPO, { ref: 'v1', by: 'a', force: true });
    expect(r.buildId).toBe('build-1');
  });

  test('歷史只保留 50 筆', async () => {
    const old: UpdateHistoryEntry[] = Array.from({ length: 50 }, (_, i) => ({
      ref: `v${i}`, sha: `s${i}`, result: 'success', at: '2026-01-01T00:00:00Z',
    }));
    const { ports, history } = makePorts({ routes: okRoutes, readHistory: async () => old });
    await startUpdate(ports, REPO, { ref: 'v1', by: 'a' });
    expect(history).toHaveLength(50);
    expect(history[0]).toMatchObject({ result: 'started' });
  });
});
