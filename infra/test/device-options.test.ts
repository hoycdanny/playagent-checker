import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_ANDROID_VERSION,
  DeviceOptionError,
  EMULATOR_SCREENS,
  formFactorFilterValues,
  parseAndroidVersion,
  parseFormFactor,
  REDROID_ANDROID_VERSIONS,
  REDROID_IMAGE_RE,
  redroidImage,
  redroidTag,
} from '../lambda/api/deviceOptions.js';
import { parseDisplay } from '../lambda/api/tasks.js';

/**
 * 送出任務時可選的 OS 版本與機型(大量測系統穩定度用)。
 *
 * 兩個先前被硬編碼的地方:
 *   - Device Farm 的 ListDevices 固定 FORM_FACTOR=PHONE → 真機池的平板完全用不到
 *   - emulator-userdata.sh 固定 redroid/redroid:15.0.0-latest → 無法選 Android 版本
 */

describe('redroidTag:Android 版本 → 容器 image tag', () => {
  test('白名單內的版本都對得出 tag', () => {
    for (const v of REDROID_ANDROID_VERSIONS) {
      expect(redroidTag(v.version)).toBe(v.tag);
    }
  });

  test('版本與 tag 之間沒有通用公式 —— 這就是不讓 shell 自己組的理由', () => {
    // 8.1 的 tag 是 8.1.0-latest;若用 `${版本}.0.0-latest` 組會變成 8.1.0.0-latest(不存在)。
    // 所以完整映像名由 API 解析後寫進 job.json,userdata 直接用。
    expect(redroidTag('8.1')).toBe('8.1.0-latest');
    expect(redroidTag('8.1')).not.toBe('8.1.0.0-latest');
  });

  test('redroidImage 回完整映像名,且符合 userdata 的防呆形狀', () => {
    for (const v of REDROID_ANDROID_VERSIONS) {
      const img = redroidImage(v.version)!;
      expect(img).toBe(`redroid/redroid:${v.tag}`);
      expect(REDROID_IMAGE_RE.test(img)).toBe(true);
    }
    expect(redroidImage('99')).toBeNull();
  });

  test('不認識的版本回 null(呼叫端必須明確處理,不要猜)', () => {
    expect(redroidTag('99')).toBeNull();
    expect(redroidTag('')).toBeNull();
    expect(redroidTag(undefined)).toBeNull();
  });

  test('預設版本在白名單內', () => {
    expect(redroidTag(DEFAULT_ANDROID_VERSION)).not.toBeNull();
  });
});

describe('parseAndroidVersion', () => {
  test('模擬器:白名單內的版本收下', () => {
    expect(parseAndroidVersion('13', 'emulator')).toBe('13');
    expect(parseAndroidVersion('8.1', 'emulator')).toBe('8.1');
  });

  test('模擬器:不支援的版本在送出任務時就擋掉,並列出可選值', () => {
    expect(() => parseAndroidVersion('7', 'emulator')).toThrow(DeviceOptionError);
    try {
      parseAndroidVersion('7', 'emulator');
    } catch (e) {
      expect((e as Error).message).toContain('可選');
    }
  });

  test('擋掉注入形狀的值(userdata 會拿它組 image tag)', () => {
    for (const bad of ['15; rm -rf /', '15 && curl evil', '../../x', 'latest']) {
      expect(() => parseAndroidVersion(bad, 'emulator')).toThrow(DeviceOptionError);
    }
  });

  test('非模擬器後端一律忽略(Device Farm 的 OS 由挑到的真機決定,不是我們能指定的)', () => {
    expect(parseAndroidVersion('13', 'devicefarm')).toBeUndefined();
    expect(parseAndroidVersion('13', 'web')).toBeUndefined();
  });

  test('沒帶就是沒帶', () => {
    expect(parseAndroidVersion(undefined, 'emulator')).toBeUndefined();
    expect(parseAndroidVersion('', 'emulator')).toBeUndefined();
  });
});

describe('parseFormFactor', () => {
  test('Device Farm:三個值都收', () => {
    expect(parseFormFactor('PHONE', 'devicefarm')).toBe('PHONE');
    expect(parseFormFactor('TABLET', 'devicefarm')).toBe('TABLET');
    expect(parseFormFactor('ANY', 'devicefarm')).toBe('ANY');
  });

  test('大小寫不敏感(前端傳小寫也要能用)', () => {
    expect(parseFormFactor('tablet', 'devicefarm')).toBe('TABLET');
  });

  test('不認識的值擋掉', () => {
    expect(() => parseFormFactor('WATCH', 'devicefarm')).toThrow(DeviceOptionError);
  });

  test('非 Device Farm 後端忽略(模擬器的平板是靠解析度,不是機型欄位)', () => {
    expect(parseFormFactor('TABLET', 'emulator')).toBeUndefined();
  });
});

describe('formFactorFilterValues:ListDevices 的機型過濾', () => {
  test('ANY → 不加過濾(手機與平板都進清單)', () => {
    expect(formFactorFilterValues('ANY')).toBeNull();
  });

  test('TABLET → 只要平板', () => {
    expect(formFactorFilterValues('TABLET')).toEqual(['TABLET']);
  });

  test('PHONE / 沒指定 / 陌生值 → 只要手機(維持這個功能之前的行為)', () => {
    expect(formFactorFilterValues('PHONE')).toEqual(['PHONE']);
    expect(formFactorFilterValues(undefined)).toEqual(['PHONE']);
    expect(formFactorFilterValues('nonsense')).toEqual(['PHONE']);
  });

  test('執行路徑上不丟錯:陌生值用保守預設跑完,不要讓整個任務失敗', () => {
    expect(() => formFactorFilterValues('???')).not.toThrow();
  });
});

describe('parseDisplay:模擬器也要能設解析度(平板版面靠它)', () => {
  test('模擬器收下平板解析度', () => {
    expect(parseDisplay({ width: 1600, height: 2560 }, 'emulator')).toEqual({ width: 1600, height: 2560 });
  });

  test('模擬器不受 Windows 的總像素上限限制(平板解析度會超過 1920×1080)', () => {
    // 1600×2560 = 4,096,000 > 2,073,600;Windows 會被擋,模擬器不該被擋。
    expect(() => parseDisplay({ width: 1600, height: 2560 }, 'windows')).toThrow();
    expect(parseDisplay({ width: 1600, height: 2560 }, 'emulator')).toBeTruthy();
  });

  test('寬高仍要是 320~4096 的偶數', () => {
    expect(() => parseDisplay({ width: 1601, height: 2560 }, 'emulator')).toThrow();
    expect(() => parseDisplay({ width: 100, height: 200 }, 'emulator')).toThrow();
  });

  test('其他後端照舊忽略', () => {
    expect(parseDisplay({ width: 1080, height: 1920 }, 'devicefarm')).toBeUndefined();
    expect(parseDisplay({ width: 1080, height: 1920 }, 'web')).toBeUndefined();
  });
});

describe('EMULATOR_SCREENS:預設螢幕', () => {
  test('手機與平板都有,且都符合 parseDisplay 的規則', () => {
    expect(EMULATOR_SCREENS.some((s) => s.id.startsWith('phone'))).toBe(true);
    expect(EMULATOR_SCREENS.some((s) => s.id.startsWith('tablet'))).toBe(true);
    for (const s of EMULATOR_SCREENS) {
      expect(parseDisplay({ width: s.width, height: s.height }, 'emulator')).toEqual({ width: s.width, height: s.height });
    }
  });
});

/**
 * 這些斷言原本讀 emulator-userdata.sh。userdata 在 2026-10 拆成「引導 + 主體」
 * (EC2 userdata 有 16 KB 硬上限,主體搬到 S3 的 _engine/emulator/run.sh),版本與映像的
 * 處理跟著搬到 run.sh,斷言卻還留在舊檔上 —— 於是這組測試從那時起就在測一個已經
 * 不含該邏輯的檔案。改讀 run.sh,並另外釘住「引導確實會交棒給主體」。
 */
describe('emulator run.sh 與白名單的一致性', () => {
  const sh = readFileSync(join(__dirname, '..', 'lambda', 'engine', 'emulator', 'run.sh'), 'utf8');

  test('引導腳本只負責取得主體並交棒(主體才是這組斷言的對象)', () => {
    const boot = readFileSync(join(__dirname, '..', 'lambda', 'engine', 'emulator-userdata.sh'), 'utf8');
    expect(boot).toContain('_engine/emulator/run.sh');
    expect(boot).toContain('exec /opt/pa-run.sh');
    // userdata 的 16 KB 上限:超過的話 RunInstances 直接被拒,或腳本被截斷後語法錯誤。
    expect(Buffer.byteLength(boot, 'utf8')).toBeLessThan(16384);
  });

  test('從 job.json 讀版本與映像,不再把版本寫死在 docker 指令裡', () => {
    expect(sh).toContain('.androidVersion');
    expect(sh).toContain('.androidImage');
    // docker pull / run 必須用變數,不能再是固定的版本字串。
    expect(sh).toContain('docker pull "$IMG"');
    expect(sh).not.toMatch(/docker pull redroid\/redroid:/);
    expect(sh).not.toMatch(/-p 0\.0\.0\.0:5555:5555 redroid\/redroid:/);
  });

  test('直接讀 API 解析好的 androidImage,不自己用版本號組 tag', () => {
    expect(sh).toContain('.androidImage');
    expect(sh).not.toContain('${AV}.0.0-latest');
  });

  test('有防呆:只接受 redroid 官方 repo 的合法形狀', () => {
    expect(sh).toContain("grep -Eq '^redroid/redroid:[0-9]+(\\.[0-9]+)*-latest$'");
  });

  test('拉不到映像要失敗,不可退回其他版本(否則測試結果會是假的)', () => {
    expect(sh).toMatch(/docker pull "\$IMG"; then[\s\S]{0,200}writestatus error/);
  });

  test('解析度仍從 job.json 讀', () => {
    expect(sh).toContain('.display.width');
    expect(sh).toContain('.display.height');
  });

  /**
   * 快照上傳要直接寫最終 key。
   *
   * 2026-11-01 實測:原本的「先寫 <key>.part 再 `aws s3 mv` 搬正」會失敗 ——
   * `aws s3 mv` 為了保留標籤會呼叫 GetObjectTagging,主機角色沒有那個權限,
   * 結果是任務 pass 了、857 MB 也上傳了,但快照沒更新,而且 .part 永久留在桶裡
   * (清理用的 `aws s3 rm` 同樣沒權限)。症狀跟快照毫無關係,極難查。
   *
   * 那一招本來也沒有必要:S3 不會讓讀取者看到寫到一半的物件,中斷時舊快照原封不動。
   */
  /**
   * 還原快照後要啟動「使用者上傳的那個 App」,不是裝置上第一個第三方包。
   *
   * 2026-11-01 實測:這個被測 App 是啟動器 —— com.example.gameB 首次啟動會下載
   * 1.36 GB 並另外裝一個 com.example.gameA(真正的遊戲)。快照裡因此有兩個第三方包,
   * 而 `pm list packages -3 | head -1` 挑到哪一個是任意的:同一份快照,兩次任務分別
   * 啟動了不同的 App。那會破壞快照的另一個目的(可重現的起點),報告上也看不出來。
   */
  test('還原後以 job.json 的 package 為準(快照裡可能有不只一個第三方 App)', () => {
    expect(sh).toContain('grep -qxF "$PKG"');
    // 挑到的候選要印出來,否則「為什麼啟動了別的 App」只能靠猜。
    expect(sh).toContain('snapshot: 快照內的第三方 App');
  });

  test('快照直接寫最終 key,不走 .part 搬正(mv 需要主機沒有的 GetObjectTagging)', () => {
    expect(sh).toContain('aws s3 cp /tmp/newsnap.tar.zst "s3://$BUCKET/$SNAP_KEY"');
    expect(sh).not.toContain('$SNAP_KEY.part');
    // 只看會執行到的行 —— 上面那段註解本身就在講 `aws s3 mv` 為什麼不能用。
    const code = sh
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/aws s3 mv/);
  });
});
