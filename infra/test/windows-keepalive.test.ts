import { describe, expect, test } from 'vitest';
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const ka = await import('../../worker/windows-host/keepalive/keepalive.mjs');

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
