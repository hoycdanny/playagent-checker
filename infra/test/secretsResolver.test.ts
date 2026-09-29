import { describe, it, expect } from 'vitest';

// runner 端憑證解析:substituteText 只在 type 的 text 上替換,明文不進 TASK/trace。
// 設定 PA_TENANT/PA_APP 後動態 import(模組載入時讀 env)。獨立機密讀取以 stub 注入,避免真實網路。
process.env.PA_TENANT = 'globex-us';
process.env.PA_APP = 'app-1';
process.env.PA_DATA_REGION = 'us-east-2';

const PREFIX = 'playagent/tenant/globex-us/';
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const mod = await import('../../agent/secretsResolver.mjs');

// stub:只有明確登記的機密名回值,其餘回 null(模擬找不到)。
function stubGetter(map: Record<string, string>) {
  return async (name: string) => (name in map ? map[name] : null);
}

describe('runner substituteText — App 憑證表(${key})', () => {
  it('${key} 用 App 憑證表的值替換', async () => {
    const creds = { 帳號: '123455', 密碼: '654321', 伺服器名稱: 'daily-aws' };
    const r = await mod.substituteText('帳號輸入 ${帳號} 密碼輸入 ${密碼}', creds, stubGetter({}));
    expect(r.text).toBe('帳號輸入 123455 密碼輸入 654321');
    expect(r.resolved).toBe(2);
    expect(r.missing).toEqual([]);
  });

  it('App 憑證表沒有 → 退回本租戶獨立機密', async () => {
    const r = await mod.substituteText('填 ${TOKEN}', {}, stubGetter({ [`${PREFIX}TOKEN`]: 'abc' }));
    expect(r.text).toBe('填 abc');
    expect(r.resolved).toBe(1);
  });

  it('缺 key 且無獨立機密 → 保留原佔位符並記 missing', async () => {
    const r = await mod.substituteText('填 ${不存在}', {}, stubGetter({}));
    expect(r.text).toBe('填 ${不存在}');
    expect(r.resolved).toBe(0);
    expect(r.missing).toContain('${不存在}');
  });

  it('secretRef:本租戶全名 → 替換;跨租戶 → 保留(不撈)', async () => {
    const good = `secretRef:${PREFIX}pw`;
    const bad = 'secretRef:playagent/tenant/acme-tw/pw';
    const getter = stubGetter({ [`${PREFIX}pw`]: 's3cr3t', 'playagent/tenant/acme-tw/pw': 'LEAK' });
    const r = await mod.substituteText(`${good} 與 ${bad}`, {}, getter);
    expect(r.text).toContain('s3cr3t');
    expect(r.text).toContain(bad); // 跨租戶保留原樣,未替換
    expect(r.text).not.toContain('LEAK');
  });

  it('無佔位符 / 非字串 → 安全回', async () => {
    expect((await mod.substituteText('點擊開始', { 帳號: 'x' }, stubGetter({}))).resolved).toBe(0);
    expect((await mod.substituteText(undefined, {}, stubGetter({}))).resolved).toBe(0);
  });
});
