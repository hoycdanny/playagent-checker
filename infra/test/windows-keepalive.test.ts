import { describe, expect, test } from 'vitest';
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const ka = await import('../../agent/glsKeepAlive.mjs');

/**
 * 保活的狀態決策。
 *
 * 這段邏輯決定「現在要不要(重)連」,而判斷錯的後果不對稱:
 *   該連而不連 → session 在一小時後被收掉,長時測試整段白跑
 *   不該連卻連 → 對已經 CONNECTED 的 session 重複送 offer,把好的連線打斷
 * 兩種都不會跳錯,只會表現成「怎麼又只跑了一小時」,所以用純函式釘住。
 *
 * 真實狀態機已經實測過:ACTIVE → (CreateStreamSessionConnection) → CONNECTED,
 * 約 4 秒。斷線後 GLS 會轉成 PENDING_CLIENT_RECONNECTION 等重連。
 */

describe('什麼時候該連', () => {
  test.each(['ACTIVE', 'PENDING_CLIENT_RECONNECTION'])('%s → 連', (s) => {
    expect(ka.decide(s, '').action).toBe('connect');
  });

  test('ACTIVATING(還在開機)→ 等,不要白送 offer', () => {
    expect(ka.decide('ACTIVATING', '').action).toBe('wait');
  });

  test('已經 CONNECTED 且 WebRTC 還活著 → 什麼都不做', () => {
    for (const rtc of ['connected', 'connecting', 'new']) {
      expect(ka.decide('CONNECTED', rtc).action).toBe('hold');
    }
  });

  test('CONNECTED 但 WebRTC 已斷 → 等 GLS 轉成可重連,不要在這個狀態硬送', () => {
    // CreateStreamSessionConnection 只接受 ACTIVE / PENDING_CLIENT_RECONNECTION,
    // 在 CONNECTED 狀態送出去只會拿到錯誤。
    for (const rtc of ['disconnected', 'failed', 'closed']) {
      expect(ka.decide('CONNECTED', rtc).action).toBe('wait');
    }
  });

  test('CONNECTED 但還沒收到任何 WebRTC 狀態 → 等(不要誤判成健康)', () => {
    expect(ka.decide('CONNECTED', '').action).toBe('wait');
  });
});

describe('什麼時候該放棄', () => {
  test.each(['TERMINATED', 'TERMINATING', 'ERROR'])('%s → 停,不要一直重試', (s) => {
    expect(ka.decide(s, 'connected').action).toBe('stop');
  });

  test('終態優先於 WebRTC 狀態(session 沒了就是沒了)', () => {
    expect(ka.decide('TERMINATED', 'connected').action).toBe('stop');
  });

  test('未知狀態當成「等」,不要停也不要亂連', () => {
    for (const s of ['', 'SOMETHING_NEW', 'pending']) {
      expect(ka.decide(s, '').action).toBe('wait');
    }
  });
});

describe('重連退避', () => {
  test('5s → 10s → 20s → 40s,上限 60s', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map((n) => ka.retryDelayMs(n)))
      .toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  test('第 0 次與負數不會算出 0 或負的等待', () => {
    for (const n of [0, -1, -99]) expect(ka.retryDelayMs(n)).toBe(5_000);
  });
});

describe('終態集合對外公開(engine 之後要用它判斷要不要收掉保活)', () => {
  test('包含三個終態', () => {
    expect([...ka.FINAL_STATES].sort()).toEqual(['ERROR', 'TERMINATED', 'TERMINATING']);
  });
});

/**
 * deadline 租約。
 *
 * runner 靠 deadline 在 session 被 GameLift 收掉前自己收尾寫報告,所以這個數字給錯的
 * 後果不對稱:
 *   給太短 → 任務提早收工,少測一段(看得出來,報告還在)
 *   給太長 → session 被直接收掉,任務停在「執行中」而且沒有報告(最糟,而且不會跳錯)
 * 所以保活連不上、或中途死掉時,租約必須停在一個仍然安全的值。
 */
describe('deadline 租約', () => {
  const NOW = 1_700_000_000_000;
  const MIN = 60_000;

  test('不知道 session 何時結束 → 只用重連窗口(3600s)扣掉收尾時間(300s)', () => {
    // 保活死掉的那一刻起,session 還有一整個重連窗口可活,所以這是安全的下限。
    expect(ka.leaseDeadlineMs({ nowMs: NOW, sessionEndMs: 0 })).toBe(NOW + 55 * MIN);
  });

  test('session 的硬性結束時刻比重連窗口早 → 取 session 結束時刻', () => {
    // SessionLengthSeconds 不會因為有人連著就延長,所以不能無視它。
    expect(ka.leaseDeadlineMs({ nowMs: NOW, sessionEndMs: NOW + 20 * MIN }))
      .toBe(NOW + 15 * MIN);
  });

  test('session 還很久才結束 → 仍只敢擔保一個重連窗口', () => {
    expect(ka.leaseDeadlineMs({ nowMs: NOW, sessionEndMs: NOW + 12 * 60 * MIN }))
      .toBe(NOW + 55 * MIN);
  });

  test('壞掉的 sessionEndMs 當成不知道,不要算出 NaN 或過去的時間', () => {
    for (const bad of [NaN, undefined, -1, 0]) {
      expect(ka.leaseDeadlineMs({ nowMs: NOW, sessionEndMs: bad })).toBe(NOW + 55 * MIN);
    }
  });

  test('租約一定在未來(不然 runner 讀到就立刻收工)', () => {
    for (const end of [0, NOW + 60 * MIN, NOW + 24 * 60 * MIN]) {
      expect(ka.leaseDeadlineMs({ nowMs: NOW, sessionEndMs: end })).toBeGreaterThan(NOW);
    }
  });

  test('重連窗口與收尾時間對外公開(engine / runner 兩邊要用同一組數字)', () => {
    expect(ka.RECONNECT_WINDOW_SEC).toBe(3600);
    expect(ka.WRAP_UP_SEC).toBe(300);
  });
});

/**
 * runner 端讀租約的判斷。
 *
 * 這裡每一條都對應一種真實會發生的壞輸入:租約還沒出現、剛寫到一半、時鐘偏移。
 * 全部都必須退化成「沿用現值」而不是算出一個奇怪的時間 —— 收尾時間算錯的後果是
 * 任務沒有報告(見 deadlineLease.mjs 的檔頭)。
 */
describe('runner 讀租約', () => {
  const NOW = 1_700_000_000_000;
  const MIN = 60_000;

  test('租約比現值晚 → 延後', () => {
    expect(ka.nextDeadline(NOW, JSON.stringify({ deadlineMs: NOW + 30 * MIN })))
      .toBe(NOW + 30 * MIN);
  });

  test('租約比現值早 → 不動(不要讓任務提早收工)', () => {
    expect(ka.nextDeadline(NOW, JSON.stringify({ deadlineMs: NOW - 10 * MIN }))).toBe(NOW);
  });

  test('壞掉或殘缺的租約 → 沿用現值', () => {
    for (const bad of ['', '{', 'null', '{}', '{"deadlineMs":"soon"}', '{"deadlineMs":null}', undefined]) {
      expect(ka.nextDeadline(NOW, bad)).toBe(NOW);
    }
  });

  test('「不限時數」不會因為一份租約變成有限', () => {
    // Android 不設時數上限時 deadline 是 NaN。租約把它變成有限值 = 本來能一直跑的任務
    // 突然提早收工,而且看起來像是設定沒生效。
    expect(ka.nextDeadline(NaN, JSON.stringify({ deadlineMs: NOW + 30 * MIN }))).toBeNaN();
  });

  test('保活寫的租約讀回來一定是往後延(兩端對得上)', () => {
    const lease = JSON.stringify({ deadlineMs: ka.leaseDeadlineMs({ nowMs: NOW, sessionEndMs: 0 }) });
    expect(ka.nextDeadline(NOW, lease)).toBe(NOW + 55 * MIN);
  });
});
