import { describe, expect, it } from 'vitest';
import { REPLAY_START_CURSOR, REPLAY_START_CURSOR_AUDIO } from './LivePlayer.tsx';
import { isMediaCursor } from '../../../../infra/lambda/api/liveMedia.ts';

/**
 * 回放的起始游標是個跨前後端的約定,而且壞掉時完全不會出聲。
 *
 * 後端 listMediaSegments 的語意:沒給 after → 只回「最新幾段」(給即時播放用);
 * 給了 after → 從那個檔名之後往後列。回放要的是「從第一段開始」,所以前端送一個
 * 比任何真實段落都早的游標。
 *
 * 關鍵是後端對**不合格式**的 after 是悄悄忽略、退回「最新幾段」。所以游標一旦寫錯,
 * 症狀是回放只播最後 4 秒就結束 —— 畫面看起來像壞了,但不會有任何錯誤訊息。
 * 這裡直接用後端匯出的判準來驗,而不是在前端重寫一份格式期望值。
 */
describe('回放起始游標', () => {
  it('後端認得這個游標(不認得就會悄悄退回「只播最新兩段」)', () => {
    expect(isMediaCursor('live', REPLAY_START_CURSOR)).toBe(true);
  });

  it('比任何真實段落都早,所以會從第一段開始列', () => {
    const ms = (name: string) => Number(/^[sa](\d{13})\.mp4$/.exec(name)![1]);
    expect(ms(REPLAY_START_CURSOR)).toBe(0);
    // 2026 年的時間戳約 1.79e12;真實段落一定比 0 大,字典序也一定在它之後
    // (同為 13 位數字,所以字典序 = 數值序,StartAfter 才會從頭開始)。
    const real = 's1792725358000.mp4';
    expect(ms(real)).toBeGreaterThan(0);
    expect(REPLAY_START_CURSOR < real).toBe(true);
    expect(REPLAY_START_CURSOR.length).toBe(real.length);
  });

  it('幾個會被悄悄忽略的寫法(說明為什麼需要這組測試)', () => {
    // 位數不對 → 不合格式 → 後端當成沒給 → 回放只播最新兩段。
    expect(isMediaCursor('live', 's0.mp4')).toBe(false);
    expect(isMediaCursor('live', 's000000000000.mp4')).toBe(false); // 12 位
    // 前綴不對(live 用 s,audio 用 a)。
    expect(isMediaCursor('live', 'a0000000000000.mp4')).toBe(false);
    // 副檔名不對。
    expect(isMediaCursor('live', 's0000000000000.m4s')).toBe(false);
  });

  it('audio 來源有自己的游標(前綴不同,用錯一樣會悄悄退回最新幾段)', () => {
    expect(isMediaCursor('audio', REPLAY_START_CURSOR)).toBe(false);
    expect(isMediaCursor('audio', REPLAY_START_CURSOR_AUDIO)).toBe(true);
    expect(isMediaCursor('live', REPLAY_START_CURSOR_AUDIO)).toBe(false);
  });
});
