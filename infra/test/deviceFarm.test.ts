import { describe, it, expect, vi } from 'vitest';
import {
  listRemoteAccessDevices,
  getOrCreateProject,
  DEVICE_FARM_REGION,
} from '../lambda/engine/deviceFarm.js';

/** 造一個最小的 DeviceFarmClient mock(只實作 send,依 command 名回傳)。 */
function mockClient(handlers: Record<string, (input: unknown) => unknown>) {
  return {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
      const name = cmd.constructor.name;
      const h = handlers[name];
      if (!h) throw new Error(`unhandled command ${name}`);
      return h(cmd.input);
    }),
  } as never;
}

describe('deviceFarm', () => {
  it('region 固定 us-west-2', () => {
    expect(DEVICE_FARM_REGION).toBe('us-west-2');
  });

  it('listRemoteAccessDevices:依 OS 版本降序,並套 min/maxOsVersion 過濾', async () => {
    const client = mockClient({
      ListDevicesCommand: () => ({
        devices: [
          { arn: 'a13', os: '13', name: 'P13' },
          { arn: 'a15', os: '15', name: 'P15' },
          { arn: 'a11', os: '11', name: 'P11' },
        ],
      }),
    });
    // 不過濾:降序 15,13,11
    const all = await listRemoteAccessDevices(client, 'android');
    expect(all.map((d) => d.os)).toEqual(['15', '13', '11']);
    // maxOsVersion=13:只留 <=13,降序 13,11
    const capped = await listRemoteAccessDevices(client, 'android', 13);
    expect(capped.map((d) => d.os)).toEqual(['13', '11']);
  });

  it('listRemoteAccessDevices:過濾後為空則回退不過濾(不整個失敗)', async () => {
    const client = mockClient({
      ListDevicesCommand: () => ({ devices: [{ arn: 'a15', os: '15', name: 'P15' }] }),
    });
    // maxOsVersion=10 會過濾掉唯一的 15,回退回不過濾 → 仍回 15
    const pool = await listRemoteAccessDevices(client, 'android', 10);
    expect(pool.map((d) => d.os)).toEqual(['15']);
  });

  it('getOrCreateProject:同名已存在則複用,不重建', async () => {
    const created: string[] = [];
    const client = mockClient({
      ListProjectsCommand: () => ({ projects: [{ name: 'playagent-checker', arn: 'arn:existing' }] }),
      CreateProjectCommand: (input) => { created.push((input as { name: string }).name); return { project: { arn: 'arn:new' } }; },
      TagResourceCommand: () => ({}),
    });
    const arn = await getOrCreateProject('playagent-checker', client);
    expect(arn).toBe('arn:existing');
    expect(created).toHaveLength(0); // 沒重建
  });

  it('getOrCreateProject:不存在則建立', async () => {
    const client = mockClient({
      ListProjectsCommand: () => ({ projects: [] }),
      CreateProjectCommand: () => ({ project: { arn: 'arn:new' } }),
      TagResourceCommand: () => ({}),
    });
    const arn = await getOrCreateProject('playagent-checker', client);
    expect(arn).toBe('arn:new');
  });
});
