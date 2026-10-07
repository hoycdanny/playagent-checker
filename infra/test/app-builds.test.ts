import { describe, test, expect } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  addAppBuild,
  activateAppBuild,
  removeAppBuild,
  withBuilds,
  validateAddBuild,
  ValidationError,
  NotFoundError,
  type AppRecord,
} from '../lambda/api/apps.js';

const TENANT = 't-001';
const APP = 'app-1';
const KEY = `tenants/${TENANT}/apps/${APP}.json`;

/** 記憶體 S3(只需支援 App 記錄的 Get/Put)。 */
function fakeS3(initial?: AppRecord) {
  const store = new Map<string, string>();
  if (initial) store.set(KEY, JSON.stringify(initial));
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      const Key = cmd.input['Key'] as string;
      if (name === 'PutObjectCommand') {
        store.set(Key, String(cmd.input['Body'] ?? ''));
        return {};
      }
      if (name === 'GetObjectCommand') {
        if (!store.has(Key)) {
          const e = new Error('nf');
          e.name = 'NoSuchKey';
          throw e;
        }
        return { Body: { transformToString: async () => store.get(Key) } };
      }
      return {};
    },
  };
  return { store, s3: client as unknown as S3Client };
}

function baseApp(over: Partial<AppRecord> = {}): AppRecord {
  return {
    id: APP,
    name: '老子有錢',
    platform: 'android',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as AppRecord;
}

/** 從 fake S3 讀回寫入的記錄,確認真的持久化(不只是回傳值對)。 */
function stored(store: Map<string, string>): AppRecord {
  return JSON.parse(store.get(KEY)!) as AppRecord;
}

describe('validateAddBuild', () => {
  test('artifactId 必須符合格式(擋路徑穿越)', () => {
    expect(() => validateAddBuild({ artifactId: '../../etc', kind: 'apk' })).toThrow(ValidationError);
    expect(() => validateAddBuild({ artifactId: 'a/b', kind: 'apk' })).toThrow(ValidationError);
    expect(() => validateAddBuild({ artifactId: '', kind: 'apk' })).toThrow(ValidationError);
  });

  test('kind 必須在白名單內', () => {
    expect(() => validateAddBuild({ artifactId: 'art-1', kind: 'sh' })).toThrow(ValidationError);
  });

  test('沒給 label 時用上傳時間當標籤', () => {
    const out = validateAddBuild({ artifactId: 'art-1', kind: 'apk' });
    expect(out.label).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(out.notes).toBeUndefined();
  });

  test('label/notes 會去空白並保留', () => {
    const out = validateAddBuild({ artifactId: 'art-1', kind: 'ipa', label: '  1.2.3 ', notes: ' 修登入 ' });
    expect(out).toMatchObject({ artifactId: 'art-1', kind: 'ipa', label: '1.2.3', notes: '修登入' });
  });
});

describe('addAppBuild', () => {
  test('新版本放最前面並直接成為使用中,同時同步顯示版本', async () => {
    const { store, s3 } = fakeS3(baseApp());
    await addAppBuild(s3, 'b', TENANT, APP, { artifactId: 'art-1', label: '1.0.0', kind: 'apk' });
    const after = await addAppBuild(s3, 'b', TENANT, APP, { artifactId: 'art-2', label: '1.1.0', kind: 'apk' });

    expect(after.builds?.map((b) => b.artifactId)).toEqual(['art-2', 'art-1']);
    expect(after.artifactId).toBe('art-2');
    expect(after.version).toBe('1.1.0');
    expect(stored(store).artifactId).toBe('art-2');
  });

  test('同一個 artifactId 再加一次是更新,不會長出重複項', async () => {
    const { s3 } = fakeS3(baseApp());
    const first = await addAppBuild(s3, 'b', TENANT, APP, { artifactId: 'art-1', label: '1.0.0', kind: 'apk' });
    const again = await addAppBuild(s3, 'b', TENANT, APP, { artifactId: 'art-1', label: '1.0.0-hotfix', kind: 'apk' });

    expect(again.builds).toHaveLength(1);
    expect(again.builds?.[0]?.label).toBe('1.0.0-hotfix');
    // 上傳時間保留第一次的,才看得出這份安裝檔是什麼時候進來的。
    expect(again.builds?.[0]?.uploadedAt).toBe(first.builds?.[0]?.uploadedAt);
  });

  test('App 不存在時拋 NotFoundError', async () => {
    const { s3 } = fakeS3();
    await expect(
      addAppBuild(s3, 'b', TENANT, APP, { artifactId: 'art-1', label: '1', kind: 'apk' }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('activateAppBuild', () => {
  test('切換使用中版本,顯示版本跟著標籤走', async () => {
    const { s3 } = fakeS3(baseApp());
    await addAppBuild(s3, 'b', TENANT, APP, { artifactId: 'art-1', label: '1.0.0', kind: 'apk' });
    await addAppBuild(s3, 'b', TENANT, APP, { artifactId: 'art-2', label: '1.1.0', kind: 'apk' });

    const back = await activateAppBuild(s3, 'b', TENANT, APP, 'art-1');
    expect(back.artifactId).toBe('art-1');
    expect(back.version).toBe('1.0.0');
    // 清單順序不變(順序代表上傳時間,不代表哪個在用)。
    expect(back.builds?.map((b) => b.artifactId)).toEqual(['art-2', 'art-1']);
  });

  test('切換到不存在的版本要失敗', async () => {
    const { s3 } = fakeS3(baseApp({ artifactId: 'art-1' }));
    await expect(activateAppBuild(s3, 'b', TENANT, APP, 'nope')).rejects.toThrow(NotFoundError);
  });
});

describe('removeAppBuild', () => {
  test('不能刪使用中的版本(還有其他版本時)', async () => {
    const { s3 } = fakeS3(baseApp());
    await addAppBuild(s3, 'b', TENANT, APP, { artifactId: 'art-1', label: '1.0.0', kind: 'apk' });
    await addAppBuild(s3, 'b', TENANT, APP, { artifactId: 'art-2', label: '1.1.0', kind: 'apk' });

    await expect(removeAppBuild(s3, 'b', TENANT, APP, 'art-2')).rejects.toThrow(ValidationError);
  });

  test('刪非使用中的版本:清單縮短,使用中不變', async () => {
    const { s3 } = fakeS3(baseApp());
    await addAppBuild(s3, 'b', TENANT, APP, { artifactId: 'art-1', label: '1.0.0', kind: 'apk' });
    await addAppBuild(s3, 'b', TENANT, APP, { artifactId: 'art-2', label: '1.1.0', kind: 'apk' });

    const after = await removeAppBuild(s3, 'b', TENANT, APP, 'art-1');
    expect(after.builds?.map((b) => b.artifactId)).toEqual(['art-2']);
    expect(after.artifactId).toBe('art-2');
  });

  test('刪掉最後一版(即使它在使用中):App 回到沒有產物', async () => {
    const { store, s3 } = fakeS3(baseApp());
    await addAppBuild(s3, 'b', TENANT, APP, { artifactId: 'art-1', label: '1.0.0', kind: 'apk' });

    const after = await removeAppBuild(s3, 'b', TENANT, APP, 'art-1');
    expect(after.artifactId).toBeUndefined();
    expect(after.builds).toBeUndefined();
    expect(stored(store).artifactId).toBeUndefined();
  });
});

describe('withBuilds(讀取時的即時遷移)', () => {
  test('只有 artifactId 的舊 App 會補出一筆版本', () => {
    const out = withBuilds(baseApp({ artifactId: 'art-old', version: '0.9', updatedAt: '2026-02-02T00:00:00.000Z' }));
    expect(out.builds).toEqual([
      { artifactId: 'art-old', label: '0.9', kind: 'apk', uploadedAt: '2026-02-02T00:00:00.000Z' },
    ]);
  });

  test('kind 依平台推斷', () => {
    expect(withBuilds(baseApp({ platform: 'ios', artifactId: 'a' })).builds?.[0]?.kind).toBe('ipa');
    expect(withBuilds(baseApp({ platform: 'windows', artifactId: 'a' })).builds?.[0]?.kind).toBe('exe');
  });

  test('已經有 builds 或根本沒有產物時原樣回傳', () => {
    const withList = baseApp({ artifactId: 'a', builds: [{ artifactId: 'a', label: 'x', kind: 'apk', uploadedAt: 'z' }] });
    expect(withBuilds(withList)).toBe(withList);
    const none = baseApp();
    expect(withBuilds(none)).toBe(none);
  });
});
