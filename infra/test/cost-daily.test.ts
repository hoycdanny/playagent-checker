import { describe, expect, test } from 'vitest';
import { buildDailyCost, jobIdFromSessionName, taipeiDate } from '../lambda/api/cost.js';
import type { TaskListItem } from '../lambda/api/tasks.js';

const task = (jobId: string, appId: string, createdAt: string, spend?: number): TaskListItem => ({
  jobId, appId, caseId: 'c', backend: 'devicefarm', locality: 'cloud', category: 'test', state: 'pass', createdAt,
  ...(spend !== undefined ? { billableSpendUsd: spend } : {}),
});

describe('daily cost by app', () => {
  test('session name → jobId', () => {
    expect(jobIdFromSessionName('pa-job-mutm18ke-7w5bnm-1791105642347')).toBe('job-mutm18ke-7w5bnm');
    expect(jobIdFromSessionName('perfprobe3-1791090912923')).toBeUndefined();
  });

  test('Taipei day boundary', () => {
    expect(taipeiDate('2026-10-03T15:59:59Z')).toBe('2026-10-03');
    expect(taipeiDate('2026-10-03T16:00:00Z')).toBe('2026-10-04');
  });

  test('model + Device Farm minutes, grouped by Taipei day and app', () => {
    const now = new Date('2026-10-04T12:00:00Z');
    const tasks = [
      task('job-a-1', 'appA', '2026-10-04T01:00:00Z', 1),
      task('job-a-2', 'appA', '2026-10-03T17:00:00Z', 0.5), // 台北 10/04 01:00
      task('job-b-1', 'appB', '2026-10-03T02:00:00Z'), // 無模型費用,只有裝置
      task('job-old', 'appA', '2026-08-01T00:00:00Z', 9), // 區間外
    ];
    const sessions = [
      { name: 'pa-job-a-1-1', jobId: 'job-a-1', meteredMinutes: 10, totalMinutes: 10.5 },
      { name: 'pa-job-b-1-1', jobId: 'job-b-1', meteredMinutes: 20, totalMinutes: 20 },
      { name: 'perfprobe-1', created: '2026-10-04T03:00:00Z', meteredMinutes: 3, totalMinutes: 3 },
    ];
    const d = buildDailyCost(tasks, sessions, { days: 7, now, includeUnattributed: true });
    expect(d.days).toHaveLength(7);
    expect(d.to).toBe('2026-10-04');
    expect(d.from).toBe('2026-09-28');
    const day4 = d.days.find((x) => x.date === '2026-10-04')!;
    expect(day4.runs).toBe(2);
    expect(day4.byApp['appA']).toBeCloseTo(1 + 10 * 0.17 + 0.5, 6);
    const day3 = d.days.find((x) => x.date === '2026-10-03')!;
    expect(day3.byApp['appB']).toBeCloseTo(20 * 0.17, 6);
    // appB 3.40(全為裝置費)> appA 3.20
    expect(d.byApp.map((a) => a.appId)).toEqual(['appB', 'appA']);
    expect(d.totals.runs).toBe(3);
    expect(d.totals.deviceMinutes).toBe(30);
    expect(d.unattributed).toEqual({ deviceUsd: 0.51, deviceMinutes: 3, sessions: 1 });
    // 非管理員看不到未歸屬用量;Device Farm 取不到時標示
    const d2 = buildDailyCost(tasks, null, { days: 7, now });
    expect(d2.deviceDataAvailable).toBe(false);
    expect(d2.unattributed).toBeUndefined();
    expect(d2.totals.deviceUsd).toBe(0);
  });
});
