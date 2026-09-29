import { describe, it, expect, vi } from 'vitest';
import {
  appCredentialsSecretName,
  isValidCredentialKey,
  listAppCredentials,
  readVisibleCredentials,
  putAppCredential,
  deleteAppCredential,
} from '../lambda/api/appCredentialsStore.js';
import type { SecretWriter } from '../lambda/api/secretValueStore.js';

const T = 'globex-us';
const APP = 'app-mumc6jb3';
const NAME = `playagent/tenant/${T}/app/${APP}/credentials`;

/** 記憶體 SecretWriter:一個 secret 存一個 JSON 物件({key:{value,visible}} 或舊式純字串)。 */
function memWriter(initialJson?: string) {
  const store = new Map<string, string>();
  if (initialJson) store.set(NAME, initialJson);
  const w: SecretWriter & { store: Map<string, string> } = {
    store,
    putSecretValue: vi.fn(async (name: string, value: string) => { store.set(name, value); }),
    deleteSecret: vi.fn(async (name: string) => { store.delete(name); }),
    getSecretJson: async (name: string) => {
      const raw = store.get(name);
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    },
  };
  return w;
}

describe('appCredentialsStore (visible flag)', () => {
  it('secret 名綁 tenant + appId', () => {
    expect(appCredentialsSecretName(T, APP)).toBe(NAME);
  });

  it('key 命名規則(允許中文,禁空白/大括號/$)', () => {
    expect(isValidCredentialKey('帳號')).toBe(true);
    expect(isValidCredentialKey('伺服器名稱')).toBe(true);
    expect(isValidCredentialKey('bad key')).toBe(false);
    expect(isValidCredentialKey('a${b}')).toBe(false);
    expect(isValidCredentialKey('')).toBe(false);
  });

  it('put 寫入 {value,visible};list 只回 {key,visible}(不含值)', async () => {
    const w = memWriter();
    await putAppCredential(w, T, APP, '密碼', 'p', false);
    const items = await putAppCredential(w, T, APP, '伺服器名稱', 'daily-aws', true);
    expect(items).toEqual([
      { key: '伺服器名稱', visible: true },
      { key: '密碼', visible: false },
    ]);
    // secret JSON 存的是 {value,visible}。
    expect(JSON.parse(w.store.get(NAME)!)).toEqual({
      密碼: { value: 'p', visible: false },
      伺服器名稱: { value: 'daily-aws', visible: true },
    });
    // list 不得含任何值。
    expect(JSON.stringify(items)).not.toContain('daily-aws');
  });

  it('readVisibleCredentials 只回可見的 {key,value}', async () => {
    const w = memWriter(JSON.stringify({
      帳號: { value: 'u', visible: false },
      密碼: { value: 'p', visible: false },
      伺服器名稱: { value: 'daily-aws', visible: true },
      伺服器IP: { value: '10.0.0.1', visible: true },
    }));
    const vis = await readVisibleCredentials(w, T, APP);
    expect(vis).toEqual([
      { key: '伺服器IP', value: '10.0.0.1' },
      { key: '伺服器名稱', value: 'daily-aws' },
    ]);
    // 遮蔽的帳密不得出現。
    expect(JSON.stringify(vis)).not.toContain('"u"');
    expect(JSON.stringify(vis)).not.toContain('"p"');
  });

  it('向後相容:舊式純字串 entry 視為 visible=false', async () => {
    const w = memWriter(JSON.stringify({ TOKEN: 'legacy-value' }));
    const items = await listAppCredentials(w, T, APP);
    expect(items).toEqual([{ key: 'TOKEN', visible: false }]);
    const vis = await readVisibleCredentials(w, T, APP);
    expect(vis).toEqual([]); // 舊式一律遮蔽,不進可見
  });

  it('delete 移除單一 key;全空則刪整個 secret', async () => {
    const w = memWriter(JSON.stringify({ A: { value: '1', visible: false }, B: { value: '2', visible: true } }));
    const after = await deleteAppCredential(w, T, APP, 'A');
    expect(after).toEqual([{ key: 'B', visible: true }]);
    const empty = await deleteAppCredential(w, T, APP, 'B');
    expect(empty).toEqual([]);
    expect(w.deleteSecret).toHaveBeenCalledWith(NAME);
    expect(w.store.has(NAME)).toBe(false);
  });
});
