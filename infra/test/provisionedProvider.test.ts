import { describe, it, expect, vi } from 'vitest';
import {
  ProvisionedProvider,
  type HostControl,
  type HostRunner,
  type ProvisionedKind,
} from '../lambda/engine/provisionedProvider.js';
import type { DeviceLease, RunResult } from '../lambda/engine/deviceProvider.js';

function makeProvider(
  kind: ProvisionedKind,
  overrides: {
    isTerminated?: boolean;
    onTerminate?: (id: string) => void;
  } = {},
) {
  const terminated = new Set<string>();
  const host: HostControl = {
    provisionHost: vi.fn(async (_spec, k) => ({
      instanceId: `i-${k}-123`,
      endpoint: `10.0.0.5:${k === 'emulator' ? 5555 : 4725}`,
    })),
    terminateHost: vi.fn(async (id: string) => {
      overrides.onTerminate?.(id);
      if (overrides.isTerminated !== false) terminated.add(id);
    }),
    isTerminated: vi.fn(async (id: string) =>
      overrides.isTerminated ?? terminated.has(id),
    ),
  };
  const runner: HostRunner = {
    runOnHost: vi.fn(
      async (): Promise<RunResult> => ({ state: 'pass', steps: 3, message: 'ok' }),
    ),
  };
  const provider = new ProvisionedProvider(kind, {
    s3: {} as never,
    host,
    runner,
  });
  return { provider, host, runner };
}

describe('ProvisionedProvider — 生命週期(Req 4.3/4.5/4.6)', () => {
  it('acquire 起專屬主機,lease.hostOrigin=provisioned 且帶 instanceId', async () => {
    const { provider, host } = makeProvider('emulator');
    const lease = await provider.acquire({ tenantId: 't1', jobId: 'job-1' });
    expect(host.provisionHost).toHaveBeenCalledOnce();
    expect(lease.hostOrigin).toBe('provisioned');
    expect(lease.resourceId).toBe('i-emulator-123');
    // 無畫面串流骨架先給 null(Req 5.3)。
    expect(lease.viewUrl).toBeNull();
  });

  it('終局 release 終結 provisioned 主機並確認終結後才完成(Req 4.6)', async () => {
    const { provider, host } = makeProvider('windows');
    const lease = await provider.acquire({ tenantId: 't1', jobId: 'job-2' });
    await provider.release(lease);
    expect(host.terminateHost).toHaveBeenCalledWith('i-windows-123');
    expect(host.isTerminated).toHaveBeenCalledWith('i-windows-123');
  });

  it('未確認終結時 release 拋錯(併發槽不釋放,避免殭屍主機)', async () => {
    const { provider } = makeProvider('emulator', { isTerminated: false });
    const lease = await provider.acquire({ tenantId: 't1', jobId: 'job-3' });
    await expect(provider.release(lease)).rejects.toThrow(/尚未確認終結/);
  });

  it('常駐/attached 主機不被 release 終結(Req 4.5)', async () => {
    const { provider, host } = makeProvider('emulator');
    const attachedLease: DeviceLease = {
      endpoint: 'conn-abc',
      viewUrl: null,
      hostOrigin: 'attached',
      resourceId: 'i-should-not-terminate',
    };
    await provider.release(attachedLease);
    expect(host.terminateHost).not.toHaveBeenCalled();
  });

  it('run 委派給 HostRunner 回終態', async () => {
    const { provider, runner } = makeProvider('emulator');
    const lease = await provider.acquire({ tenantId: 't1', jobId: 'job-4' });
    const res = await provider.run(lease, { tenantId: 't1', jobId: 'job-4' });
    expect(runner.runOnHost).toHaveBeenCalledOnce();
    expect(res.state).toBe('pass');
  });
});
