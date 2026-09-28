import { describe, it, expect, vi } from 'vitest';
import {
  parseSecretRef,
  extractSecretRefs,
  tenantSecretPrefix,
  SecretRefError,
} from '../lambda/api/secretRefs.js';
import { DeviceFarmProvider } from '../lambda/engine/deviceFarmProvider.js';

const TENANT = 'acme-tw';
const OTHER = 'globex-us';

describe('機密引用 — 租戶範圍(Req 14.3)', () => {
  it('secretRef 落本租戶前綴 → 解析通過', () => {
    const ref = parseSecretRef(
      `secretRef:${tenantSecretPrefix(TENANT)}game-login`,
      TENANT,
    );
    expect(ref.name).toBe(`${tenantSecretPrefix(TENANT)}game-login`);
  });

  it('引用他租戶前綴 → 拒絕(跨租戶隔離)', () => {
    expect(() =>
      parseSecretRef(`secretRef:${tenantSecretPrefix(OTHER)}game-login`, TENANT),
    ).toThrow(SecretRefError);
  });

  it('ARN 形式落本租戶前綴 → 通過;他租戶 → 拒絕', () => {
    const arn = `arn:aws:secretsmanager:us-east-2:111111111111:secret:${tenantSecretPrefix(TENANT)}pw-AbCdEf`;
    const ref = parseSecretRef(arn, TENANT);
    expect(ref.name).toBe(`${tenantSecretPrefix(TENANT)}pw`);

    const otherArn = `arn:aws:secretsmanager:us-east-2:111111111111:secret:${tenantSecretPrefix(OTHER)}pw-AbCdEf`;
    expect(() => parseSecretRef(otherArn, TENANT)).toThrow(SecretRefError);
  });

  it('非機密引用字面量 → 拒絕', () => {
    expect(() => parseSecretRef('hunter2', TENANT)).toThrow(SecretRefError);
  });

  it('extractSecretRefs 去重且對任一跨租戶引用整體拋錯', () => {
    const yaml = `steps:\n  - login: secretRef:${tenantSecretPrefix(TENANT)}pw\n  - again: secretRef:${tenantSecretPrefix(TENANT)}pw\n`;
    const refs = extractSecretRefs(yaml, TENANT);
    expect(refs).toHaveLength(1);

    const bad = `login: secretRef:${tenantSecretPrefix(OTHER)}pw`;
    expect(() => extractSecretRefs(bad, TENANT)).toThrow(SecretRefError);
  });
});

describe('DeviceFarmProvider — 被測身分注入(Req 14.2/14.5)', () => {
  function makeProvider(opts: {
    yaml: string;
    secretValues: Record<string, string | null>;
  }) {
    const executed: Array<Map<string, string>> = [];
    const secrets = {
      getSecretValue: vi.fn(async (name: string) => opts.secretValues[name] ?? null),
    };
    const farm = {
      startRun: vi.fn(async () => ({ runArn: 'arn:run:123' })),
      execute: vi.fn(async (_arn, _spec, injected: Map<string, string>) => {
        // 記錄 execute 當下拿到的注入(拷貝,因 run 結束會 clear)。
        executed.push(new Map(injected));
        return { state: 'pass' as const, steps: 1, message: 'ok' };
      }),
      stopRun: vi.fn(async () => {}),
    };
    const provider = new DeviceFarmProvider({
      secrets,
      farm,
      readCaseYaml: async () => opts.yaml,
    });
    return { provider, secrets, farm, executed };
  }

  it('花費前解析本租戶機密並於 session 內注入', async () => {
    const name = `${tenantSecretPrefix(TENANT)}game-login`;
    const { provider, farm, executed } = makeProvider({
      yaml: `login: secretRef:${name}`,
      secretValues: { [name]: 's3cr3t!' },
    });
    const lease = await provider.acquire({ tenantId: TENANT, jobId: 'job-1' });
    const res = await provider.run(lease, { tenantId: TENANT, jobId: 'job-1' });
    expect(res.state).toBe('pass');
    expect(farm.execute).toHaveBeenCalledOnce();
    // execute 當下確有注入該機密。
    expect(executed[0]!.get(name)).toBe('s3cr3t!');
  });

  it('機密缺失 → 花費前失敗(不呼叫 execute)', async () => {
    const name = `${tenantSecretPrefix(TENANT)}missing`;
    const { provider, farm } = makeProvider({
      yaml: `login: secretRef:${name}`,
      secretValues: {}, // 找不到
    });
    const lease = await provider.acquire({ tenantId: TENANT, jobId: 'job-2' });
    await expect(
      provider.run(lease, { tenantId: TENANT, jobId: 'job-2' }),
    ).rejects.toThrow(SecretRefError);
    expect(farm.execute).not.toHaveBeenCalled();
  });

  it('引用他租戶機密 → 花費前拒絕(不呼叫 execute)', async () => {
    const { provider, farm } = makeProvider({
      yaml: `login: secretRef:${tenantSecretPrefix(OTHER)}pw`,
      secretValues: { [`${tenantSecretPrefix(OTHER)}pw`]: 'x' },
    });
    const lease = await provider.acquire({ tenantId: TENANT, jobId: 'job-3' });
    await expect(
      provider.run(lease, { tenantId: TENANT, jobId: 'job-3' }),
    ).rejects.toThrow(SecretRefError);
    expect(farm.execute).not.toHaveBeenCalled();
  });
});
