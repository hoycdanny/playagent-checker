import { describe, expect, test } from 'vitest';
import { parseSnapshotName, appSnapshotPrefix } from '../lambda/api/snapshots.js';
import { parseSnapshot, validateSubmit, ValidationError } from '../lambda/api/tasks.js';

/**
 * 快照檔名的解析。
 *
 * 這段容易寫錯,因為 artifactVersion 本身含連字號(`art-mva92xdd-s6il77`),
 * 用 split('-') 會把它切碎。而解析錯的後果是前端顯示錯的版本/解析度,
 * 使用者會以為某份快照適用於他正要跑的設定,其實不是。
 *
 * 另一半是安全:名稱來自 URL,刪除前必須認得出形狀,否則可以用它刪掉 App 前綴下的
 * 任何物件(包括 App 自己的 metadata)。
 */

describe('解析快照檔名', () => {
  test('真實的檔名(artifactVersion 含連字號)', () => {
    const r = parseSnapshotName('snap-art-mva92xdd-s6il77-15-aarch64-1080x1920.tar.zst');
    expect(r).not.toBeNull();
    expect(r!.artifactVersion).toBe('art-mva92xdd-s6il77');
    expect(r!.androidVersion).toBe('15');
    expect(r!.arch).toBe('aarch64');
    expect(r!.display).toBe('1080x1920');
  });

  test('x86_64 架構(名稱含底線與數字)', () => {
    const r = parseSnapshotName('snap-art-abc-9-x86_64-1920x1080.tar.zst');
    expect(r!.arch).toBe('x86_64');
    expect(r!.artifactVersion).toBe('art-abc');
    expect(r!.display).toBe('1920x1080');
  });

  test('帶小數的 Android 版本(8.1)', () => {
    const r = parseSnapshotName('snap-art-xy-8.1-aarch64-720x1280.tar.zst');
    expect(r!.androidVersion).toBe('8.1');
    expect(r!.artifactVersion).toBe('art-xy');
  });

  test('認不出形狀的一律回 null', () => {
    for (const bad of [
      '',
      'snap.tar.zst',
      'snapshot.tar.zst',
      'snap-art-abc-15-aarch64.tar.zst',        // 少解析度
      'snap-art-abc-aarch64-1080x1920.tar.zst', // 少 Android 版本
      'snap-art-abc-15-aarch64-1080x1920.tar',  // 副檔名不符
      'app-mva95wxf-camd57.json',               // App 自己的 metadata
      '../../../etc/passwd',
      'snap-art-abc-15-aarch64-1080x1920.tar.zst.part', // 上傳中的半份檔案
    ]) {
      expect(parseSnapshotName(bad), bad).toBeNull();
    }
  });

  test('.part 不能被當成快照 —— 那是上傳中斷留下的半份檔案', () => {
    // run.sh 先寫 <key>.part 再搬正,所以中斷會留下它。
    // 當成快照去還原的話,解壓會失敗而且原因看起來跟快照無關。
    expect(parseSnapshotName('snap-art-abc-15-aarch64-1080x1920.tar.zst.part')).toBeNull();
  });
});

describe('前綴', () => {
  test('掛在 App 底下,與 App 的 metadata 同一層', () => {
    // App metadata 是 tenants/<t>/apps/<appId>.json,S3 沒有真資料夾所以兩者並存。
    expect(appSnapshotPrefix('default', 'app-x')).toBe('tenants/default/apps/app-x/');
  });

  test('租戶隔離:前綴一定帶 tenantId(快照含登入 token)', () => {
    expect(appSnapshotPrefix('t1', 'app-x')).toContain('tenants/t1/');
    expect(appSnapshotPrefix('t2', 'app-x')).not.toContain('tenants/t1/');
  });
});
describe('送出任務時的 snapshot 欄位', () => {
  test('emulator:收 use/save 兩個布林', () => {
    expect(parseSnapshot({ use: true }, 'emulator')).toEqual({ use: true });
    expect(parseSnapshot({ save: false }, 'emulator')).toEqual({ save: false });
    expect(parseSnapshot({ use: true, save: false }, 'emulator')).toEqual({ use: true, save: false });
  });

  test('沒給旗標就不落欄位 —— 讓 run.sh 的預設(use 關、save 開)生效', () => {
    expect(parseSnapshot(undefined, 'emulator')).toBeUndefined();
    expect(parseSnapshot({}, 'emulator')).toBeUndefined();
    expect(parseSnapshot(null, 'emulator')).toBeUndefined();
  });

  test('其他後端一律忽略 —— 只有 Redroid 的 /data 能外掛與打包', () => {
    for (const backend of ['windows', 'devicefarm', 'web', 'attached'] as const) {
      expect(parseSnapshot({ use: true }, backend as never)).toBeUndefined();
    }
  });

  test('非布林值要拒絕,不能當成 true', () => {
    // 前端若誤傳字串 "false",視為 true 會讓使用者從快照起跑卻以為是乾淨安裝,
    // 之後的失敗完全無從解釋。寧可在提交時就報錯。
    expect(() => parseSnapshot({ use: 'false' }, 'emulator')).toThrow(ValidationError);
    expect(() => parseSnapshot({ save: 1 }, 'emulator')).toThrow(ValidationError);
    expect(() => parseSnapshot('yes', 'emulator')).toThrow(ValidationError);
  });

  test('經 validateSubmit 落到 SubmitInput', () => {
    const got = validateSubmit({
      backend: 'emulator',
      appId: 'app-x',
      caseId: 'case-x',
      snapshot: { use: true },
    });
    expect(got.snapshot).toEqual({ use: true });
    // 同一組請求換成 windows 後端就不該有這個欄位。
    const win = validateSubmit({
      backend: 'windows',
      appId: 'app-x',
      caseId: 'case-x',
      snapshot: { use: true },
    });
    expect(win.snapshot).toBeUndefined();
  });
});
