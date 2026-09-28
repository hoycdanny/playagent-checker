import { describe, it, expect } from 'vitest';
import {
  registerDevice,
  listDevices,
  verifyDeviceToken,
  deleteDevice,
  type Hasher,
} from '../lambda/api/devices.js';

const TENANT = 'acme-tw';

/** 決定性 hasher(測試用)—— 模擬單向雜湊,輸出不含明文(對齊真實 SHA-256 行為)。 */
const hasher: Hasher = {
  hash: (input: string) =>
    'sha:' + [...input].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16),
  randomToken: () => 'tok-abcdef-123456-xyz',
};

function fakeS3() {
  const store = new Map<string, string>();
  const client = {
    store,
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      const Key = cmd.input.Key as string;
      if (name === 'PutObjectCommand') {
        store.set(Key, cmd.input.Body as string);
        return {};
      }
      if (name === 'GetObjectCommand') {
        const body = store.get(Key);
        if (body === undefined) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return { Body: { transformToString: async () => body } };
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = cmd.input.Prefix as string;
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
        return { Contents: keys.map((Key) => ({ Key })) };
      }
      if (name === 'DeleteObjectCommand') {
        store.delete(Key);
        return {};
      }
      return {};
    },
  };
  return client;
}

describe('裝置註冊(Req 13.1)', () => {
  it('註冊回傳一次性 token 明文;儲存只存 hash 與 hint(不存明文)', async () => {
    const s3 = fakeS3();
    const { device, token } = await registerDevice(
      s3 as never,
      'b',
      TENANT,
      { label: '我的手機' },
      hasher,
    );
    expect(token).toBe('tok-abcdef-123456-xyz');
    expect(device.label).toBe('我的手機');
    expect(device.tokenHint).toContain('…'); // 遮罩
    // 儲存內容不得含明文 token,只存 hash。
    const raw = s3.store.get(`tenants/${TENANT}/devices/${device.deviceId}.json`)!;
    expect(raw).not.toContain(token);
    expect(raw).toContain(hasher.hash(token)); // 只存 hash
  });

  it('列出裝置不含 tokenHash(機密不外洩)', async () => {
    const s3 = fakeS3();
    await registerDevice(s3 as never, 'b', TENANT, {}, hasher);
    const items = await listDevices(s3 as never, 'b', TENANT);
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]!)).not.toContain('tokenHash');
  });

  it('verifyDeviceToken 正確 token 通過、錯誤 token 拒絕', async () => {
    const s3 = fakeS3();
    const { device, token } = await registerDevice(s3 as never, 'b', TENANT, {}, hasher);
    expect(
      await verifyDeviceToken(s3 as never, 'b', TENANT, device.deviceId, token, hasher),
    ).toBe(true);
    expect(
      await verifyDeviceToken(s3 as never, 'b', TENANT, device.deviceId, 'wrong', hasher),
    ).toBe(false);
  });

  it('刪除裝置後列表為空', async () => {
    const s3 = fakeS3();
    const { device } = await registerDevice(s3 as never, 'b', TENANT, {}, hasher);
    await deleteDevice(s3 as never, 'b', TENANT, device.deviceId);
    expect(await listDevices(s3 as never, 'b', TENANT)).toHaveLength(0);
  });
});
