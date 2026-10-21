import { describe, expect, it } from 'vitest';
import { ANDROID_VERSIONS, EMULATOR_SCREENS } from './DeviceOptionSelect.tsx';
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
