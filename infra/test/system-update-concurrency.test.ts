import { describe, expect, test } from 'vitest';
import { startUpdate, UpdateError, type SystemUpdatePorts, type BuildProgress } from '../lambda/api/systemUpdate.js';

/**
 * 升級失敗的真實原因(實測這個專案最近 20 次 build):
 *   5 次失敗,每一次都在另一次成功的 7~8 秒內啟動,
 *   錯誤都是 `Cannot delete ChangeSet in status CREATE_IN_PROGRESS`
 *   —— 兩個 cdk deploy 搶同一個具名 changeset,第二個死。
 *
 * 原本 startUpdate 只在開頭檢查一次「有沒有更新在跑」,之後還要呼叫 GitHub API 解析 sha
 * (數秒),才真的 StartBuild。兩次點擊都會通過那次檢查。
 * 這組測試鎖住「啟動前會再檢查一次」這個行為。
 */

/** 可控的假 ports:記錄 startBuild 次數,並能在 GitHub 查詢期間「插入」另一個 build。 */
function makePorts(opts: {
  /** 每次 findRunningBuild 回傳的結果(依呼叫順序)。 */
  running: Array<BuildProgress | null>;
  onGithub?: () => void;
}) {
  const calls = { startBuild: 0, findRunning: 0, github: 0 };
  const running = [...opts.running];
  const ports: SystemUpdatePorts = {
    readToken: async () => null,
    writeToken: async () => {},
    readDeployed: async () => null,
    readHistory: async () => [],
    writeHistory: async () => {},
    github: async () => {
      calls.github += 1;
      opts.onGithub?.();
      // resolveSha 會打 /commits/<ref> 之類的路徑;回一個 sha 就好。
      return { status: 200, body: { sha: 'a'.repeat(40) } };
    },
    startBuild: async () => {
      calls.startBuild += 1;
      return `proj:build-${calls.startBuild}`;
    },
    getBuild: async (id: string) => ({ buildId: id, status: 'IN_PROGRESS', phases: [] }),
    // findRunningBuild 透過 listBuildIds + getBuild 判斷;這裡直接用 listBuildIds 的回傳
    // 控制「這一次檢查有沒有看到進行中的 build」。
    listBuildIds: async () => {
      calls.findRunning += 1;
      const next = running.shift() ?? null;
      return next ? [next.buildId] : [];
    },
    readLog: async () => ({ lines: [] }),
  };
  return { ports, calls };
}

describe('startUpdate:不能讓兩個更新同時啟動', () => {
  test('一開始就有更新在跑 → 直接拒絕,不啟動', async () => {
    const { ports, calls } = makePorts({
      running: [{ buildId: 'proj:already', status: 'IN_PROGRESS', phases: [] }],
    });
    await expect(startUpdate(ports, 'o/r', { ref: 'main', by: 'me' })).rejects.toThrow(UpdateError);
    expect(calls.startBuild).toBe(0);
  });

  test('第一次檢查沒看到、但解析 sha 期間別人啟動了 → 啟動前的第二次檢查要攔下來', async () => {
    // 第 1 次檢查:沒有;第 2 次檢查(GitHub 之後):有 —— 這就是原本會漏掉的競態。
    const { ports, calls } = makePorts({
      running: [null, { buildId: 'proj:sneaked-in', status: 'IN_PROGRESS', phases: [] }],
    });
    await expect(startUpdate(ports, 'o/r', { ref: 'main', by: 'me' })).rejects.toThrow(/已有更新正在執行/);
    // 關鍵:沒有啟動第二個 build。
    expect(calls.startBuild).toBe(0);
  });

  test('兩次檢查都沒看到 → 正常啟動一次', async () => {
    const { ports, calls } = makePorts({ running: [null, null] });
    const r = await startUpdate(ports, 'o/r', { ref: 'main', by: 'me' });
    expect(r.buildId).toBe('proj:build-1');
    expect(calls.startBuild).toBe(1);
  });

  test('啟動前一定要再檢查一次(不是只檢查開頭)', async () => {
    const { ports, calls } = makePorts({ running: [null, null] });
    await startUpdate(ports, 'o/r', { ref: 'main', by: 'me' });
    // 檢查次數必須 >= 2:一次在開頭(讓使用者馬上看到結果),一次緊貼啟動前。
    expect(calls.findRunning).toBeGreaterThanOrEqual(2);
    // 而且第二次要在 GitHub 查詢之後 —— 否則窗口沒縮小,等於沒修。
    expect(calls.github).toBeGreaterThanOrEqual(1);
  });
});

describe('startUpdate:其他既有把關不能被改壞', () => {
  test('版本字串格式不對 → 拒絕,不打 GitHub 也不啟動', async () => {
    const { ports, calls } = makePorts({ running: [null, null] });
    await expect(startUpdate(ports, 'o/r', { ref: 'bad ref!!', by: 'me' })).rejects.toThrow(UpdateError);
    expect(calls.startBuild).toBe(0);
    expect(calls.github).toBe(0);
  });

  test('有測試任務在跑且沒有 force → 拒絕', async () => {
    const { ports, calls } = makePorts({ running: [null, null] });
    ports.countActiveRuns = async () => 2;
    await expect(startUpdate(ports, 'o/r', { ref: 'main', by: 'me' })).rejects.toThrow(/測試任務在執行/);
    expect(calls.startBuild).toBe(0);
  });

  test('有測試任務但帶 force → 照樣啟動', async () => {
    const { ports, calls } = makePorts({ running: [null, null] });
    ports.countActiveRuns = async () => 2;
    await startUpdate(ports, 'o/r', { ref: 'main', by: 'me', force: true });
    expect(calls.startBuild).toBe(1);
  });
});

describe('CodeBuild 的並行上限被觸發時,要給人看得懂的訊息', () => {
  test('AccountLimitExceededException → 翻成「已有更新正在執行」', async () => {
    const { ports } = makePorts({ running: [null, null] });
    ports.startBuild = async () => {
      const e = new Error('Concurrent build limit exceeded. This build project has a limit of 1 concurrent build(s).');
      e.name = 'AccountLimitExceededException';
      throw e;
    };
    await expect(startUpdate(ports, 'o/r', { ref: 'main', by: 'me' })).rejects.toThrow(/已有更新正在執行/);
  });

  test('只靠訊息內容也認得出來(SDK 改了錯誤名稱時不會漏)', async () => {
    const { ports } = makePorts({ running: [null, null] });
    ports.startBuild = async () => { throw new Error('Concurrent build limit exceeded'); };
    await expect(startUpdate(ports, 'o/r', { ref: 'main', by: 'me' })).rejects.toThrow(UpdateError);
  });

  test('其他錯誤照原樣往上拋(不要把真正的故障偽裝成並行問題)', async () => {
    const { ports } = makePorts({ running: [null, null] });
    ports.startBuild = async () => { throw new Error('IAM role not authorized'); };
    await expect(startUpdate(ports, 'o/r', { ref: 'main', by: 'me' })).rejects.toThrow(/IAM role not authorized/);
  });
});
