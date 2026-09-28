import { describe, it, expect, vi } from 'vitest';
import {
  AttachedProvider,
  type AgentChannel,
  type Decider,
  type CancelCheck,
  type StepSink,
  type AgentCommand,
} from '../lambda/engine/attachedProvider.js';
import type { AcquireSpec } from '../lambda/engine/deviceProvider.js';

const SPEC: AcquireSpec = { tenantId: 't1', jobId: 'job-1' };

function build(opts: {
  connectedSeq?: boolean[];
  cancelled?: boolean;
  commands?: AgentCommand[];
  sendOk?: boolean;
}) {
  const written: Array<Record<string, unknown>> = [];
  let connCall = 0;
  const channel: AgentChannel = {
    isConnected: vi.fn(async () => {
      const seq = opts.connectedSeq;
      if (!seq) return true;
      return seq[connCall++] ?? seq[seq.length - 1] ?? true;
    }),
    requestScreenshot: vi.fn(async () => 'base64shot'),
    sendCommand: vi.fn(async () => opts.sendOk ?? true),
  };
  let decideCall = 0;
  const decider: Decider = {
    decide: vi.fn(async (): Promise<AgentCommand> => {
      const cmds = opts.commands ?? [{ index: 0, action: 'done' }];
      return cmds[decideCall++] ?? { index: decideCall, action: 'done' };
    }),
  };
  const cancel: CancelCheck = {
    isCancelled: vi.fn(async () => opts.cancelled ?? false),
  };
  const steps: StepSink = {
    writeStep: vi.fn(async (_s3, _spec, step) => {
      written.push(step);
    }),
  };
  const provider = new AttachedProvider({
    s3: {} as never,
    channel,
    decider,
    cancel,
    steps,
    maxSteps: 5,
  });
  return { provider, channel, decider, cancel, steps, written };
}

describe('AttachedProvider(Req 13)', () => {
  it('acquire 要求代理在線,lease.hostOrigin=attached(絕不被回收路徑終結)', async () => {
    const { provider } = build({});
    const lease = await provider.acquire(SPEC);
    expect(lease.hostOrigin).toBe('attached');
    expect(lease.viewUrl).toContain('attached://');
  });

  it('代理未連線時 acquire 拋錯', async () => {
    const { provider } = build({ connectedSeq: [false] });
    await expect(provider.acquire(SPEC)).rejects.toThrow(/未連線/);
  });

  it('done 指令 → pass,且 step 標記 decidedInCloud(決策恆雲端 Req 13.3)', async () => {
    const { provider, written } = build({
      commands: [{ index: 0, action: 'done' }],
    });
    const lease = await provider.acquire(SPEC);
    const res = await provider.run(lease, SPEC);
    expect(res.state).toBe('pass');
    expect(written[0]!.decidedInCloud).toBe(true);
  });

  it('執行中偵測到取消 → cancelled(Req 13.7)', async () => {
    const { provider } = build({ cancelled: true });
    const lease = await provider.acquire(SPEC);
    const res = await provider.run(lease, SPEC);
    expect(res.state).toBe('cancelled');
  });

  it('迴圈中斷線 → error(連線中斷不算通過 Req 13.6)', async () => {
    // acquire 需在線(true);run 第一步 isConnected 回 false。
    const { provider } = build({ connectedSeq: [true, false] });
    const lease = await provider.acquire(SPEC);
    const res = await provider.run(lease, SPEC);
    expect(res.state).toBe('error');
    expect(res.message).toContain('斷線');
  });

  it('指令下發失敗 → error', async () => {
    const { provider } = build({
      commands: [{ index: 0, action: 'tap', x: 1, y: 2 }],
      sendOk: false,
    });
    const lease = await provider.acquire(SPEC);
    const res = await provider.run(lease, SPEC);
    expect(res.state).toBe('error');
  });

  it('達步數上限未完成 → fail(非 error)', async () => {
    const { provider } = build({
      commands: Array.from({ length: 6 }, (_, i) => ({
        index: i,
        action: 'tap' as const,
        x: 0,
        y: 0,
      })),
    });
    const lease = await provider.acquire(SPEC);
    const res = await provider.run(lease, SPEC);
    expect(res.state).toBe('fail');
    expect(res.steps).toBe(5);
  });

  it('release 不終結 attached 主機(使用者的機器,Req 4.5)', async () => {
    const { provider } = build({});
    const lease = await provider.acquire(SPEC);
    await expect(provider.release(lease)).resolves.toBeUndefined();
  });
});
