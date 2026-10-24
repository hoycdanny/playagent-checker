import { describe, expect, test } from 'vitest';
import { sessionSeconds, MAX_UNATTENDED_SECONDS, MAX_SESSION_SECONDS } from '../lambda/engine/windowsHost.js';

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
