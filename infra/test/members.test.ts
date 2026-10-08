import { describe, test, expect, vi } from 'vitest';
import { handleRequest, type ApiDeps } from '../lambda/api/core.js';
import type { MemberRecord, UserAdmin } from '../lambda/api/users.js';

/**
 * 成員管理路由。重點在「不能把自己鎖在門外」的那三道閘:
 * 停用自己、取消自己的管理員、刪自己,都必須被擋下來 ——
 * 這個平台可能只有一個管理員,擋不住就沒有人能把權限拿回來。
 */

const ME = 'admin@example.com';
const OTHER = 'tester@example.com';

const claims = (email: string, admin = true) => ({
  email,
  'cognito:username': email,
  sub: 'u-1',
  'custom:tenantId': 't-001',
  ...(admin ? { 'cognito:groups': ['admins'] } : {}),
});

function fakeUserAdmin() {
  const calls: string[] = [];
  const admin: UserAdmin = {
    listMembers: vi.fn(async (): Promise<MemberRecord[]> => [
      { username: ME, email: ME, tenantId: 't-001', enabled: true, status: 'CONFIRMED', createdAt: null, admin: true },
    ]),
    createMember: vi.fn(async (i) => ({
      username: i.email, email: i.email, tenantId: i.tenantId, enabled: true, status: 'CONFIRMED', createdAt: null,
    })),
    setEnabled: vi.fn(async (u, e) => { calls.push(`setEnabled:${u}:${e}`); }),
    setAdmin: vi.fn(async (u, a) => { calls.push(`setAdmin:${u}:${a}`); }),
    resetPassword: vi.fn(async (u) => { calls.push(`resetPassword:${u}`); }),
    setTenant: vi.fn(async (u, t) => { calls.push(`setTenant:${u}:${t}`); }),
    deleteMember: vi.fn(async (u) => { calls.push(`delete:${u}`); }),
  };
  return { admin, calls };
}

function deps(userAdmin?: UserAdmin): ApiDeps {
  return {
    bucket: 'b',
    sharedS3: {} as never,
    getTenantS3: async () => ({}) as never,
    draftCase: async () => '',
    enqueueJob: async () => {},
    hasher: { hash: (i: string) => `h(${i})`, randomToken: () => 'tok' },
    ...(userAdmin ? { userAdmin } : {}),
  } as unknown as ApiDeps;
}

const req = (method: string, path: string, body?: unknown, email = ME, admin = true) => ({
  method,
  path,
  claims: claims(email, admin),
  ...(body !== undefined ? { body } : {}),
}) as never;

describe('成員管理:權限閘', () => {
  test('非管理員不能列成員', async () => {
    const res = await handleRequest(req('GET', '/users', undefined, ME, false), deps(fakeUserAdmin().admin));
    expect(res.status).toBe(403);
  });

  test('未注入 userAdmin 時回 501', async () => {
    const res = await handleRequest(req('GET', '/users'), deps());
    expect(res.status).toBe(501);
  });
});

describe('成員管理:不能把自己鎖在門外', () => {
  test('不能停用自己', async () => {
    const { admin, calls } = fakeUserAdmin();
    const res = await handleRequest(req('POST', `/users/${ME}/disable`, {}), deps(admin));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('可以停用別人', async () => {
    const { admin, calls } = fakeUserAdmin();
    const res = await handleRequest(req('POST', `/users/${OTHER}/disable`, {}), deps(admin));
    expect(res.status).toBe(200);
    expect(calls).toEqual([`setEnabled:${OTHER}:false`]);
  });

  test('可以啟用自己(不會被鎖門,所以放行)', async () => {
    const { admin, calls } = fakeUserAdmin();
    const res = await handleRequest(req('POST', `/users/${ME}/enable`, {}), deps(admin));
    expect(res.status).toBe(200);
    expect(calls).toEqual([`setEnabled:${ME}:true`]);
  });

  test('不能取消自己的管理員權限', async () => {
    const { admin, calls } = fakeUserAdmin();
    const res = await handleRequest(req('POST', `/users/${ME}/admin`, { admin: false }), deps(admin));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('不能刪自己', async () => {
    const { admin, calls } = fakeUserAdmin();
    const res = await handleRequest(req('DELETE', `/users/${ME}`), deps(admin));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('大小寫不同的 email 也算自己', async () => {
    const { admin } = fakeUserAdmin();
    const res = await handleRequest(req('DELETE', `/users/${ME.toUpperCase()}`), deps(admin));
    expect(res.status).toBe(400);
  });
});

describe('成員管理:其餘動作', () => {
  test('設別人為管理員', async () => {
    const { admin, calls } = fakeUserAdmin();
    const res = await handleRequest(req('POST', `/users/${OTHER}/admin`, { admin: true }), deps(admin));
    expect(res.status).toBe(200);
    expect(calls).toEqual([`setAdmin:${OTHER}:true`]);
  });

  test('重設密碼:太短擋下', async () => {
    const { admin, calls } = fakeUserAdmin();
    const res = await handleRequest(req('POST', `/users/${OTHER}/password`, { password: 'short' }), deps(admin));
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('重設密碼:長度足夠就通過', async () => {
    const { admin, calls } = fakeUserAdmin();
    const res = await handleRequest(req('POST', `/users/${OTHER}/password`, { password: 'Str0ngPassw0rd!' }), deps(admin));
    expect(res.status).toBe(200);
    expect(calls).toEqual([`resetPassword:${OTHER}`]);
  });

  test('改租戶:格式不合擋下(避免寫進 S3 前綴)', async () => {
    const { admin, calls } = fakeUserAdmin();
    for (const bad of ['a', 'has space', 'a/b', '']) {
      const res = await handleRequest(req('PUT', `/users/${OTHER}`, { tenantId: bad }), deps(admin));
      expect(res.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test('改租戶:合法值寫入', async () => {
    const { admin, calls } = fakeUserAdmin();
    const res = await handleRequest(req('PUT', `/users/${OTHER}`, { tenantId: 'acme-eu_2' }), deps(admin));
    expect(res.status).toBe(200);
    expect(calls).toEqual([`setTenant:${OTHER}:acme-eu_2`]);
  });

  test('刪別人', async () => {
    const { admin, calls } = fakeUserAdmin();
    const res = await handleRequest(req('DELETE', `/users/${OTHER}`), deps(admin));
    expect(res.status).toBe(200);
    expect(calls).toEqual([`delete:${OTHER}`]);
  });
});
