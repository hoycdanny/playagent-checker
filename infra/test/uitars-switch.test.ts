import { describe, test, expect } from 'vitest';
import {
  getUitarsStatus,
  setUitars,
  toState,
  uitarsAvailable,
  UitarsSwitchError,
  type UitarsAudit,
  type UitarsPorts,
} from '../lambda/api/uitarsSwitch.js';

const CFG = { endpointName: 'ui-tars-playagent', instanceType: 'ml.g6e.xlarge' };

/** 假的 SageMaker:記住 endpoint 狀態與呼叫過的動作。 */
function makePorts(init: { endpoint?: string | null; model?: boolean; config?: boolean } = {}) {
  const st = {
    endpoint: init.endpoint ?? null as string | null,
    model: init.model ?? false,
    config: init.config ?? false,
    calls: [] as string[],
    audit: null as UitarsAudit | null,
  };
  const ports: UitarsPorts = {
    describeEndpoint: async () => (st.endpoint ? { status: st.endpoint } : null),
    modelExists: async () => st.model,
    configExists: async () => st.config,
    createModel: async () => { st.calls.push('createModel'); st.model = true; },
    createConfig: async () => { st.calls.push('createConfig'); st.config = true; },
    createEndpoint: async () => { st.calls.push('createEndpoint'); st.endpoint = 'Creating'; },
    deleteEndpoint: async () => { st.calls.push('deleteEndpoint'); st.endpoint = 'Deleting'; },
    readAudit: async () => st.audit,
    writeAudit: async (a) => { st.audit = a; },
  };
  return { ports, st };
}

describe('toState', () => {
  test('maps SageMaker statuses', () => {
    expect(toState(null)).toBe('off');
    expect(toState('InService')).toBe('on');
    expect(toState('Creating')).toBe('starting');
    expect(toState('Updating')).toBe('starting');
    expect(toState('Deleting')).toBe('stopping');
    expect(toState('Failed')).toBe('failed');
    expect(toState('OutOfService')).toBe('failed');
  });
});

describe('getUitarsStatus', () => {
  test('no endpoint = off (the default)', async () => {
    const { ports } = makePorts();
    const s = await getUitarsStatus(ports, CFG);
    expect(s.state).toBe('off');
    expect(s.endpointStatus).toBeUndefined();
    expect(s.endpointName).toBe('ui-tars-playagent');
  });
});

describe('setUitars(enable)', () => {
  test('first enable creates model, config, endpoint and records who did it', async () => {
    const { ports, st } = makePorts();
    const s = await setUitars(ports, CFG, true, 'admin@x');
    expect(st.calls).toEqual(['createModel', 'createConfig', 'createEndpoint']);
    expect(s.state).toBe('starting');
    expect(st.audit).toMatchObject({ action: 'enable', by: 'admin@x' });
  });

  test('reuses existing model and config', async () => {
    const { ports, st } = makePorts({ model: true, config: true });
    await setUitars(ports, CFG, true, 'a');
    expect(st.calls).toEqual(['createEndpoint']);
  });

  test('idempotent when already on or starting', async () => {
    for (const endpoint of ['InService', 'Creating']) {
      const { ports, st } = makePorts({ endpoint, model: true, config: true });
      await setUitars(ports, CFG, true, 'a');
      expect(st.calls).toEqual([]);
    }
  });

  test('rejects while deleting or after a failure', async () => {
    await expect(setUitars(makePorts({ endpoint: 'Deleting' }).ports, CFG, true, 'a')).rejects.toBeInstanceOf(UitarsSwitchError);
    await expect(setUitars(makePorts({ endpoint: 'Failed' }).ports, CFG, true, 'a')).rejects.toBeInstanceOf(UitarsSwitchError);
  });
});

describe('setUitars(disable)', () => {
  test('deletes only the endpoint (model/config kept, they are free)', async () => {
    const { ports, st } = makePorts({ endpoint: 'InService', model: true, config: true });
    const s = await setUitars(ports, CFG, false, 'a');
    expect(st.calls).toEqual(['deleteEndpoint']);
    expect(s.state).toBe('stopping');
    expect(st.model && st.config).toBe(true);
    expect(st.audit?.action).toBe('disable');
  });

  test('can stop a failed or still-creating endpoint (stops billing)', async () => {
    for (const endpoint of ['Failed', 'Creating']) {
      const { ports, st } = makePorts({ endpoint });
      await setUitars(ports, CFG, false, 'a');
      expect(st.calls).toEqual(['deleteEndpoint']);
    }
  });

  test('idempotent when already off or stopping', async () => {
    for (const endpoint of [null, 'Deleting']) {
      const { ports, st } = makePorts({ endpoint });
      await setUitars(ports, CFG, false, 'a');
      expect(st.calls).toEqual([]);
    }
  });

  test('rejects while updating', async () => {
    await expect(setUitars(makePorts({ endpoint: 'Updating' }).ports, CFG, false, 'a')).rejects.toBeInstanceOf(UitarsSwitchError);
  });
});

describe('uitarsAvailable', () => {
  test('true only when InService; errors count as unavailable', async () => {
    expect(await uitarsAvailable(makePorts({ endpoint: 'InService' }).ports)).toBe(true);
    expect(await uitarsAvailable(makePorts({ endpoint: 'Creating' }).ports)).toBe(false);
    expect(await uitarsAvailable(makePorts().ports)).toBe(false);
    const broken = makePorts().ports;
    broken.describeEndpoint = async () => { throw new Error('AccessDenied'); };
    expect(await uitarsAvailable(broken)).toBe(false);
  });
});
