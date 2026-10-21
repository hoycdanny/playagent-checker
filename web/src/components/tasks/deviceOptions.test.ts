import { describe, expect, it } from 'vitest';
import { ANDROID_VERSIONS, EMULATOR_SCREENS, deviceFilterHint } from './DeviceOptionSelect.tsx';
import { REDROID_ANDROID_VERSIONS, EMULATOR_SCREENS as BACKEND_SCREENS } from '../../../../infra/lambda/api/deviceOptions.ts';

/**
 * 前端選單與後端白名單必須一致。
 *
 * 不一致的兩種後果都很糟,而且都不會在開發時被發現:
 *   - 前端多一個版本 → 使用者選得到,送出時被後端擋下(看起來像系統壞了)
 *   - 前端少一個版本 → 明明支援卻選不到
 * 所以直接拿後端那份清單來比,而不是在兩邊各維護一份期望值。
 */

describe('Android 版本清單', () => {
  it('前端選項與後端白名單完全相同(含順序)', () => {
    expect([...ANDROID_VERSIONS]).toEqual(REDROID_ANDROID_VERSIONS.map((v) => v.version));
  });

  it('預設值 15 在清單裡', () => {
    expect(ANDROID_VERSIONS).toContain('15');
  });
});

describe('模擬器螢幕清單', () => {
  it('前端與後端的 id 與解析度完全相同', () => {
    expect(EMULATOR_SCREENS.map((s) => [s.id, s.width, s.height]))
      .toEqual(BACKEND_SCREENS.map((s) => [s.id, s.width, s.height]));
  });

  it('手機與平板都有(平板是這次要支援的重點)', () => {
    expect(EMULATOR_SCREENS.some((s) => s.id.startsWith('phone'))).toBe(true);
    expect(EMULATOR_SCREENS.some((s) => s.id.startsWith('tablet'))).toBe(true);
  });

  it('解析度寬高都是偶數(後端 parseDisplay 的規則)', () => {
    for (const s of EMULATOR_SCREENS) {
      expect(s.width % 2).toBe(0);
      expect(s.height % 2).toBe(0);
    }
  });
});

describe('deviceFilterHint:過濾結果要講清楚', () => {
  it('有符合的機器時講出數量與機型態', () => {
    const s = deviceFilterHint('TABLET', 3, 'zh-Hant');
    expect(s).toContain('3');
    expect(s).toContain('平板');
    // 要同時說明「自動派發」是什麼,否則使用者不知道留空會怎樣。
    expect(s).toContain('自動派發');
  });

  it('沒有符合的機器時明確說出來,不要只留一個空清單', () => {
    const s = deviceFilterHint('TABLET', 0, 'zh-Hant');
    expect(s).toContain('沒有符合');
    // 並且給出下一步,而不是只報告壞消息。
    expect(s).toMatch(/改選|稍後/);
  });

  it('英文介面也有對應文案(不會掉回中文)', () => {
    expect(deviceFilterHint('PHONE', 2, 'en')).toMatch(/match/i);
    expect(deviceFilterHint('PHONE', 0, 'en')).toMatch(/No available devices/i);
  });
});

/** 與 TasksPage 相同的過濾規則(機型態 → 可選裝置)。 */
const filterByFormFactor = (devices: Array<{ arn: string; formFactor?: string }>, ff: string) =>
  ff === 'ANY' ? devices : devices.filter((d) => (d.formFactor || 'PHONE') === ff);

describe('機型態 → 過濾裝置清單', () => {
  const pool = [
    { arn: 'a', formFactor: 'PHONE' },
    { arn: 'b', formFactor: 'TABLET' },
    { arn: 'c' }, // 沒帶 formFactor 的舊資料
  ];

  it('選平板只留平板', () => {
    expect(filterByFormFactor(pool, 'TABLET').map((d) => d.arn)).toEqual(['b']);
  });

  it('選手機時,沒帶 formFactor 的舊資料算手機(與後端預設一致)', () => {
    expect(filterByFormFactor(pool, 'PHONE').map((d) => d.arn)).toEqual(['a', 'c']);
  });

  it('不限 → 全部都在', () => {
    expect(filterByFormFactor(pool, 'ANY')).toHaveLength(3);
  });

  it('換機型態後,原本選的裝置若不在清單裡就該被清掉', () => {
    // 這是 TasksPage 的 effect 條件:選了手機 a,再把機型態改成平板 → a 不在清單 → 清掉。
    const stillValid = filterByFormFactor(pool, 'TABLET').some((d) => d.arn === 'a');
    expect(stillValid).toBe(false);
  });
});
