import { describe, expect, test } from 'vitest';
import { modelInputSize, toDevice, toModel, CoordinateError } from '../src/domain/coordinates.js';
import { createJobStateMachine, createWorkerStateMachine, InvalidTransitionError, toTaskState } from '../src/domain/stateMachine.js';
import { parseAction } from '../src/domain/action.js';
import { parseJobConfig } from '../src/domain/job.js';
import { framebufferMatches } from '../src/domain/display.js';
import { RetryBudget } from '../src/domain/retry.js';
import { artifactKey } from '../src/domain/artifact.js';
import { minimumHostCost, runCost, spotSavings } from '../src/domain/cost.js';
import { createLogger } from '../src/domain/log.js';

describe('coordinate transform', () => {
  test('1080×4096 shown to the model at 540×2048: (270,1800) → (540,3600)', () => {
    expect(toDevice({ x: 270, y: 1800 }, { width: 540, height: 2048 }, { width: 1080, height: 4096 })).toEqual({ x: 540, y: 3600 });
  });
  test('rounds and clamps into the device; round-trips through model space', () => {
    expect(toDevice({ x: 540, y: 2048 }, { width: 540, height: 2048 }, { width: 1080, height: 4096 })).toEqual({ x: 1079, y: 4095 });
    expect(toDevice({ x: 0.4, y: 0.4 }, { width: 100, height: 100 }, { width: 1000, height: 1000 })).toEqual({ x: 4, y: 4 });
    const d = toDevice({ x: 333, y: 777 }, { width: 952, height: 2156 }, { width: 1440, height: 3088 });
    const m = toModel(d, { width: 1440, height: 3088 }, { width: 952, height: 2156 });
    expect(Math.abs(m.x - 333)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.y - 777)).toBeLessThanOrEqual(1);
  });
  test('model input size keeps the aspect ratio, never upscales', () => {
    expect(modelInputSize({ width: 1080, height: 4096 })).toEqual({ width: 540, height: 2048 });
    expect(modelInputSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });
  test('invalid sizes / points throw', () => {
    expect(() => toDevice({ x: 1, y: 1 }, { width: 0, height: 10 }, { width: 10, height: 10 })).toThrow(CoordinateError);
    expect(() => toDevice({ x: Number.NaN, y: 1 }, { width: 10, height: 10 }, { width: 10, height: 10 })).toThrow(CoordinateError);
  });
});

describe('state machines', () => {
  test('job: happy path, terminal states absorb, environment error ≠ test failure', () => {
    const j = createJobStateMachine();
    for (const s of ['ALLOCATING', 'PREPARING', 'RUNNING', 'PASSED'] as const) j.transition(s);
    expect(j.isTerminal).toBe(true);
    expect(() => j.transition('FAILED')).toThrow(InvalidTransitionError);
    expect(toTaskState('ENVIRONMENT_ERROR')).toBe('error');
    expect(toTaskState('FAILED')).toBe('fail');
    expect(toTaskState('TIMEOUT')).toBe('dead');
    expect(toTaskState('RETRYING')).toBe('running');
  });
  test('job: Spot interruption → RETRYING → ALLOCATING on another worker', () => {
    const j = createJobStateMachine();
    for (const s of ['ALLOCATING', 'PREPARING', 'RUNNING', 'RETRYING', 'ALLOCATING'] as const) j.transition(s);
    expect(j.history.map((h) => h.to)).toEqual(['ALLOCATING', 'PREPARING', 'RUNNING', 'RETRYING', 'ALLOCATING']);
  });
  test('worker: cannot skip collecting artifacts before COMPLETED', () => {
    const w = createWorkerStateMachine();
    for (const s of ['BOOTING', 'READY', 'PREPARING', 'INSTALLING', 'RUNNING'] as const) w.transition(s);
    expect(w.can('COMPLETED')).toBe(false);
    w.transition('COLLECTING_ARTIFACTS');
    w.transition('COMPLETED');
    w.transition('READY'); // 同一台接下一個 session
    expect(w.state).toBe('READY');
  });
});

describe('action schema', () => {
  test('valid actions parse with defaults; garbage is rejected', () => {
    expect(parseAction({ action: 'tap', x: 532, y: 3801, confidence: 0.96, reason: 'Spin button detected' })).toMatchObject({ action: 'tap', x: 532, y: 3801 });
    expect(parseAction({ action: 'longPress', x: 1, y: 2 })).toMatchObject({ durationMs: 800 });
    expect(parseAction({ action: 'tap', x: -1, y: 2 })).toBeNull();
    expect(parseAction({ action: 'hotkey', keys: ['ctrl', 'rm -rf'] })).toBeNull();
    expect(parseAction({ action: 'explode' })).toBeNull();
  });
});

describe('job config', () => {
  const base = {
    jobId: 'job-1', tenantId: 'acme', appId: 'app-1', platform: 'windows', gameType: 'slot',
    build: { kind: 'win-zip', artifactKey: 'tenants/acme/artifacts/art-1/game.zip', entry: 'Game/Slot.exe' },
    display: { width: 1080, height: 4096, orientation: 'portrait' },
    durationMinutes: 480, timeoutMinutes: 500, testCases: ['spin 100 times'], ai: { vlmModel: 'us.anthropic.claude-sonnet-4-5' },
  };
  test('1080×4096 portrait Windows job is valid; defaults are filled', () => {
    const r = parseJobConfig(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.job.display.refreshRate).toBe(60);
      expect(r.job.retry).toEqual({ action: 3, app: 2, worker: 1 });
      expect(r.job.recording.mode).toBe('FULL');
    }
  });
  test('rejects: wrong build kind, unsupported resolution, timeout < duration, orientation mismatch, path traversal', () => {
    const bad = (patch: Record<string, unknown>) => parseJobConfig({ ...base, ...patch });
    expect(bad({ build: { ...base.build, kind: 'apk' } }).ok).toBe(false);
    expect(bad({ display: { width: 1000, height: 4000, orientation: 'portrait' } }).ok).toBe(false);
    expect(bad({ timeoutMinutes: 10 }).ok).toBe(false);
    expect(bad({ display: { width: 1080, height: 4096, orientation: 'landscape' } }).ok).toBe(false);
    expect(bad({ build: { ...base.build, entry: '../evil.exe' } }).ok).toBe(false);
    expect(bad({ build: { ...base.build, artifactKey: 'https://evil/x.zip' } }).ok).toBe(false);
  });
  test('iOS never goes to Spot', () => {
    const r = parseJobConfig({ ...base, platform: 'ios', build: { ...base.build, kind: 'ios-sim-app', entry: 'com.acme.slot' }, display: { width: 1179, height: 2556, orientation: 'portrait' } });
    expect(r.ok && r.job.allowSpot).toBe(false);
  });
  test('framebuffer must match exactly', () => {
    expect(framebufferMatches({ width: 1080, height: 4096 }, { width: 1080, height: 4096 })).toBe(true);
    expect(framebufferMatches({ width: 1080, height: 4096 }, { width: 1920, height: 1080 })).toBe(false);
  });
});

describe('retry / artifacts / cost / log', () => {
  test('retry budget is finite per kind; action budget resets after success', () => {
    const b = new RetryBudget({ action: 2, app: 1, worker: 0 });
    expect([b.consume('action'), b.consume('action'), b.consume('action')]).toEqual([true, true, false]);
    b.resetAction();
    expect(b.consume('action')).toBe(true);
    expect([b.consume('app'), b.consume('app')]).toEqual([true, false]);
    expect(b.consume('worker')).toBe(false);
  });
  test('artifact keys follow the existing S3 layout and reject traversal', () => {
    expect(artifactKey('acme', 'job-1', 'recording', 'rec-0.mp4')).toBe('tenants/acme/jobs/job-1/audio/rec-0.mp4');
    expect(artifactKey('acme', 'job-1', 'report', 'report.json')).toBe('tenants/acme/jobs/job-1/report.json');
    expect(() => artifactKey('acme', 'job-1', 'log', '../../x')).toThrow();
    expect(() => artifactKey('a/b', 'job-1', 'log', 'x')).toThrow();
  });
  test('cost: per job, per minute, shared host, EC2 Mac minimum, Spot savings', () => {
    const price = { platform: 'windows' as const, instanceType: 'g6.2xlarge', purchase: 'on-demand' as const, usdPerHour: 1.2 };
    expect(runCost({ price, minutes: 60, sessionsOnWorker: 2, aiUsd: 0.5 })).toEqual({ computeUsd: 0.6, aiUsd: 0.5, totalUsd: 1.1, costPerMinute: 0.0183 });
    expect(minimumHostCost({ platform: 'ios', instanceType: 'mac2.metal', purchase: 'on-demand', usdPerHour: 0.65, minimumBilledHours: 24 })).toBe(15.6);
    expect(spotSavings(price, { ...price, purchase: 'spot', usdPerHour: 0.5 }, 120)).toBe(1.4);
  });
  test('structured log line has the required fields', () => {
    const lines: string[] = [];
    createLogger({ jobId: 'job-1', workerId: 'w-1', platform: 'windows', testCaseId: 'tc-1' }, (l) => lines.push(l), () => new Date('2026-10-06T00:00:00Z'))
      .log('INFO', 'Spin button clicked', { stepId: 12 });
    expect(JSON.parse(lines[0]!)).toEqual({ timestamp: '2026-10-06T00:00:00.000Z', jobId: 'job-1', workerId: 'w-1', platform: 'windows', testCaseId: 'tc-1', stepId: 12, severity: 'INFO', message: 'Spin button clicked' });
  });
});
