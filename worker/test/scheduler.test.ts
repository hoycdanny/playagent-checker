import { describe, expect, test } from 'vitest';
import { pickWorker, release, requirementFor, reserve, type WorkerCapacity } from '../src/scheduler/Scheduler.js';

const w = (id: string, patch: Partial<WorkerCapacity> = {}): WorkerCapacity => ({
  workerId: id, platform: 'windows', instanceType: 'g6.2xlarge', purchase: 'on-demand', healthy: true, draining: false,
  cpu: { total: 8, reserved: 0 }, ramMb: { total: 32768, reserved: 0 }, gpu: { total: 1, reserved: 0 },
  maxSessions: 1, activeSessions: 0, resolutions: [[1080, 4096], [1080, 1920]], ...patch,
});
const req = requirementFor({ platform: 'windows', display: { width: 1080, height: 4096, orientation: 'portrait', refreshRate: 60 }, allowSpot: true });

describe('scheduler', () => {
  test('prefers Spot, then lower load', () => {
    expect(pickWorker([w('a'), w('b', { purchase: 'spot' })], req)).toEqual({ ok: true, workerId: 'b', purchase: 'spot' });
  });
  test('skips unhealthy, draining (Spot notice), full and wrong-platform workers', () => {
    const r = pickWorker([
      w('sick', { healthy: false }), w('drain', { draining: true }), w('full', { activeSessions: 1 }),
      w('linux', { platform: 'linux' }), w('ok'),
    ], req);
    expect(r).toEqual({ ok: true, workerId: 'ok', purchase: 'on-demand' });
  });
  test('reports why nothing fits and whether to scale out', () => {
    expect(pickWorker([], req)).toEqual({ ok: false, reason: 'no_worker_for_platform', scaleOut: true });
    expect(pickWorker([w('a', { resolutions: [[1920, 1080]] })], req)).toEqual({ ok: false, reason: 'resolution_unsupported', scaleOut: false });
    expect(pickWorker([w('a', { gpu: { total: 1, reserved: 1 } })], req)).toEqual({ ok: false, reason: 'no_capacity', scaleOut: true });
    expect(pickWorker([w('spot', { purchase: 'spot' })], { ...req, allowSpot: false }).ok).toBe(false);
  });
  test('reserve / release keep capacity consistent', () => {
    const r = reserve(w('a', { maxSessions: 2, gpu: { total: 2, reserved: 0 } }), req);
    expect(r).toMatchObject({ activeSessions: 1, gpu: { reserved: 1 }, cpu: { reserved: 4 } });
    expect(() => reserve(w('a'), { ...req, gpu: 2 })).toThrow();
    expect(release(r, req)).toMatchObject({ activeSessions: 0, gpu: { reserved: 0 } });
  });
});
