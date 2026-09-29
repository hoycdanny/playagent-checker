import { describe, it, expect, vi } from 'vitest';
import {
  appCredentialsSecretName,
  isValidCredentialKey,
  listAppCredentialKeys,
  putAppCredential,
  deleteAppCredential,
} from '../lambda/api/appCredentialsStore.js';
import type { SecretWriter } from '../lambda/api/secretValueStore.js';

const T = 'globex-us';
const APP = 'app-mumc6jb3';
const NAME = `playagent/tenant/${T}/app/${APP}/credentials`;

/** 記憶體 SecretWriter:一個 secret 存一個 JSON 物件。 */
function memWriter(initial: Record<string, string> = {}) {
  const store = new Map<string, string>();
  if (Object.keys(initial).length) store.set(NAME, JSON.stringify(initial));
  const w: SecretWriter & { store: Map<string, string> } = {
    store,
    putSecretValue: vi.fn(async (name: string, value: string) => { store.set(name, value); }),
    deleteSecret: vi.fn(async (name: string) => { store.delete(name); }),
    getSecretJson: async (name: string) => {
      const raw = store.get(name);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    },
  };
  return w;
}

describe('appCredentialsStore', () => {
  it('secret 名綁 tenant + appId', () => {
    expect(appCredentialsSecretName(T, APP)).toBe(NAME);
  });

  it('key 命名規則(允許中文,禁空白/大括號/$)', () => {
    expect(isValidCredentialKey('帳號')).toBe(true);
    expect(isValidCredentialKey('伺服器名稱')).toBe(true);
    expect(isValidCredentialKey('TEST_USERNAME')).toBe(true);
    expect(isValidCredentialKey('bad key')).toBe(false); // 含空白
    expect(isValidCredentialKey('a${b}')).toBe(false); // 含 ${}
    expect(isValidCredentialKey('')).toBe(false);
  });

  it('put 後 list 只回 key 名(排序),值進 secret JSON', async () => {
    const w = memWriter();
    await putAppCredential(w, T, APP, 'TEST_PASSWORD', 'p');
    const keys = await putAppCredential(w, T, APP, 'TEST_USERNAME', 'u');
    expect(keys).toEqual(['TEST_PASSWORD', 'TEST_USERNAME']);
    // 值確實寫進 secret JSON。
    expect(JSON.parse(w.store.get(NAME)!)).toEqual({ TEST_PASSWORD: 'p', TEST_USERNAME: 'u' });
  });

  it('delete 移除單一 key;全空則刪整個 secret', async () => {
    const w = memWriter({ A: '1', B: '2' });
    const after = await deleteAppCredential(w, T, APP, 'A');
    expect(after).toEqual(['B']);
    const empty = await deleteAppCredential(w, T, APP, 'B');
    expect(empty).toEqual([]);
    expect(w.deleteSecret).toHaveBeenCalledWith(NAME);
    expect(w.store.has(NAME)).toBe(false);
  });

  it('listAppCredentialKeys 不回值', async () => {
    const w = memWriter({ 帳號代號: 'secret-value' });
    const keys = await listAppCredentialKeys(w, T, APP);
    expect(keys).toEqual(['帳號代號']);
    expect(JSON.stringify(keys)).not.toContain('secret-value');
  });
});
