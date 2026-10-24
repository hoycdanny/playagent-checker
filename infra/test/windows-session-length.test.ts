import { describe, expect, test } from 'vitest';
import { sessionSeconds, wantsKeepAlive, MAX_UNATTENDED_SECONDS, MAX_SESSION_SECONDS } from '../lambda/engine/windowsHost.js';

/**
 * GameLift Streams 的兩個時間參數原本被設成同一個值,等於自己把 session 壽命壓到一小時。
 *
 *   ConnectionTimeoutSeconds 只是「等 client 連線或重連」的窗口(上限 3600,AWS 強制)
 *   SessionLengthSeconds     是 session 的硬性總長,不管有沒有 client 連著(上限 24 小時)
 *
 * 解耦之後,沒有保活 client 時的實際壽命必須**完全沒變**(還是最多一小時)——
 * 這是這組測試最重要的一條:這次改動不該讓任何現有任務的行為改變。
 *
 * deadline 要用 effective 而不是 session:取大的會讓 runner 以為還有時間,
 * 結果被 GameLift 直接收掉、任務停在「執行中」且沒有報告。
 */

describe('沒有保活時行為不變(最重要)', () => {
  test.each([
    [1, 3600],
    [2, 3600],
    [12, 3600],
    [72, 3600],
  ])('使用者選 %i 小時 → 實際仍是 %i 秒(一小時)', (hours, expected) => {
    expect(sessionSeconds(hours * 60, false).effective).toBe(expected);
  });

  test('未指定時數時與原本一樣(預設 60 分鐘)', () => {
    expect(sessionSeconds(undefined, false).effective).toBe(3600);
  });

  test('連線窗口永遠是 AWS 的上限,不隨使用者選的時數變', () => {
    for (const h of [1, 2, 24, 72]) {
      expect(sessionSeconds(h * 60, false).connection).toBe(MAX_UNATTENDED_SECONDS);
      expect(sessionSeconds(h * 60, true).connection).toBe(MAX_UNATTENDED_SECONDS);
    }
  });
});

describe('有保活時才吃得到長時數', () => {
  test('2 小時 → 7200 秒', () => {
    const t = sessionSeconds(120, true);
    expect(t.session).toBe(7200);
    expect(t.effective).toBe(7200);
  });

  test('超過 GameLift 的 24 小時上限要被壓下來,而不是原樣送出去被 API 拒絕', () => {
    const t = sessionSeconds(72 * 60, true); // 使用者選 72 小時(模擬器的選項上限)
    expect(t.session).toBe(MAX_SESSION_SECONDS);
    expect(t.effective).toBe(MAX_SESSION_SECONDS);
    expect(t.session).toBe(86_400);
  });

  test('不到一小時的任務不會因為保活而變長', () => {
    expect(sessionSeconds(30, true).effective).toBe(1800);
    expect(sessionSeconds(30, false).effective).toBe(1800);
  });
});

describe('下限', () => {
  test('低於 10 分鐘一律拉到 10 分鐘(開機本身就要 10~15 分鐘)', () => {
    for (const m of [0, 1, 5, 9]) {
      expect(sessionSeconds(m, false).effective).toBe(600);
      expect(sessionSeconds(m, true).effective).toBe(600);
    }
  });

  test('負數與 NaN 不會算出負的或 NaN 的時間', () => {
    for (const m of [-1, -600, Number.NaN]) {
      const t = sessionSeconds(m, false);
      expect(t.effective).toBeGreaterThanOrEqual(600);
      expect(Number.isFinite(t.effective)).toBe(true);
    }
  });
});

describe('session 與 connection 的關係', () => {
  test('effective 永遠不超過兩者的小值(沒有保活時)', () => {
    for (const h of [0.5, 1, 2, 12, 24, 72]) {
      const t = sessionSeconds(h * 60, false);
      expect(t.effective).toBe(Math.min(t.session, t.connection));
    }
  });

  test('effective 永遠不超過 session(有保活時連線窗口不再是限制)', () => {
    for (const h of [0.5, 1, 2, 12, 24, 72]) {
      const t = sessionSeconds(h * 60, true);
      expect(t.effective).toBe(t.session);
      expect(t.effective).toBeLessThanOrEqual(MAX_SESSION_SECONDS);
    }
  });
});

/**
 * runner 的初始 deadline 與 effective 是兩個不同的數字,混用過一次就會出事。
 *
 *   effective = 預期壽命,拿去告訴使用者「這次最長跑多久」
 *   deadline  = runner 幾點要收尾寫報告,永遠保守
 *
 * 為什麼 deadline 不能跟著 effective 變長:engine 起保活 task 的時候無法知道它會不會
 * 真的連上(映像拉不到、WebRTC 出不去都可能)。deadline 給長值而保活其實沒連上的話,
 * session 會在 3600 秒被收掉,runner 卻以為還有好幾小時 —— 任務停在「執行中」而且沒有
 * 報告,是最糟的一種失敗,而且不會跳任何錯。真正的延長由保活 task 寫的租約負責。
 */
describe('初始 deadline 永遠保守', () => {
  test.each([1, 2, 6, 24, 72])('使用者選 %i 小時、有保活 → deadline 仍是一小時', (hours) => {
    expect(sessionSeconds(hours * 60, true).deadline).toBe(3600);
  });

  test('沒有保活時 deadline 與 effective 相同(行為完全沒變)', () => {
    for (const h of [0.5, 1, 2, 12, 72]) {
      const t = sessionSeconds(h * 60, false);
      expect(t.deadline).toBe(t.effective);
    }
  });

  test('不到一小時的任務,deadline 就是它自己的長度(不要憑空多給時間)', () => {
    expect(sessionSeconds(30, true).deadline).toBe(1800);
    expect(sessionSeconds(30, false).deadline).toBe(1800);
  });

  test('deadline 永遠是正數且不超過 session(壞掉的時數也一樣)', () => {
    for (const m of [-1, 0, Number.NaN, 5, 60, 100_000]) {
      for (const ka of [true, false]) {
        const t = sessionSeconds(m, ka);
        expect(t.deadline).toBeGreaterThanOrEqual(600);
        expect(t.deadline).toBeLessThanOrEqual(t.session);
      }
    }
  });

  test('deadline 扣掉 5 分鐘收尾後仍在未來(不然 runner 一啟動就收工)', () => {
    for (const m of [10, 30, 60, 120]) {
      expect(sessionSeconds(m, true).deadline - 300).toBeGreaterThan(0);
    }
  });
});

describe('什麼時候啟動保活', () => {
  test('超過一小時且環境已配置 → 啟動', () => {
    expect(wantsKeepAlive(120, true)).toBe(true);
    expect(wantsKeepAlive(61, true)).toBe(true);
  });

  test('剛好一小時不需要保活(無人連線的 session 本來就撐得到)', () => {
    expect(wantsKeepAlive(60, true)).toBe(false);
    expect(wantsKeepAlive(30, true)).toBe(false);
  });

  test('環境沒配置就不啟動 —— 舊部署要退回一小時,不是整個任務失敗', () => {
    for (const m of [61, 120, 72 * 60]) expect(wantsKeepAlive(m, false)).toBe(false);
  });

  test('壞掉的時數不會誤啟動保活', () => {
    for (const m of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(wantsKeepAlive(m as number | undefined, true)).toBe(false);
    }
  });
});
