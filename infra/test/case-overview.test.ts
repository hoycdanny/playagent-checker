import { describe, expect, test } from 'vitest';
import { parseCase, runStats, splitSteps } from '../lambda/api/caseOverview.js';
import type { TaskListItem } from '../lambda/api/tasks.js';

const SLOT = `name: 拉霸機遊戲測試-進入遊戲並玩10次
controls: [tap]
app: app-muj6cp8t-0g90vh
priority: P1
task: |
  1. 啟動應用並等待載入完成
  2. 在遊戲大廳中找到拉霸機遊戲入口
  3. 點擊進入拉霸機遊戲
     (若有公告先關閉)
assertions:
  - 成功進入拉霸機遊戲場景
  - "完成10次拉霸遊戲操作"
timeoutMin: 30
`;

describe('case YAML parsing', () => {
  test('steps, assertions, controls, extra keys', () => {
    const p = parseCase(SLOT);
    expect(p.steps).toEqual(['啟動應用並等待載入完成', '在遊戲大廳中找到拉霸機遊戲入口', '點擊進入拉霸機遊戲 (若有公告先關閉)']);
    expect(p.assertions).toEqual(['成功進入拉霸機遊戲場景', '完成10次拉霸遊戲操作']);
    expect(p.controls).toEqual(['tap']);
    expect(p.priority).toBe('P1');
    expect(p.extra).toEqual({ timeoutMin: '30' });
  });
  test('plain one-line task is a single step; block list controls', () => {
    const p = parseCase('name: open\ntask: log in and finish level 1\ncontrols:\n  - tap\n  - joystick\n');
    expect(p.steps).toEqual(['log in and finish level 1']);
    expect(p.controls).toEqual(['tap', 'joystick']);
    expect(p.assertions).toEqual([]);
    expect(splitSteps(undefined)).toEqual([]);
  });
});

describe('run stats', () => {
  const j = (id: string, state: string, at: string, v?: string, spend?: number): TaskListItem => ({
    jobId: id, appId: 'a', caseId: 'c', backend: 'devicefarm', locality: 'cloud', category: 'test',
    state: state as TaskListItem['state'], createdAt: at, finishedAt: new Date(Date.parse(at) + 60_000).toISOString(), stepCount: 10,
    ...(v ? { caseVersion: v } : {}), ...(spend !== undefined ? { billableSpendUsd: spend } : {}),
  });
  test('counts, pass rate, last result, current-version runs', () => {
    const s = runStats(
      [j('j3', 'cancelled', '2026-10-03T00:00:00Z', 'v2'), j('j1', 'pass', '2026-10-01T00:00:00Z', 'v1', 1), j('j2', 'fail', '2026-10-02T00:00:00Z', 'v2', 0.5)],
      'v2',
      (t) => t.billableSpendUsd ?? 0,
    );
    expect(s.runs).toBe(3);
    expect(s.passRate).toBe(50);
    expect(s.last?.jobId).toBe('j3');
    expect(s.lastResult?.jobId).toBe('j2');
    expect(s.recent.map((r) => r.jobId)).toEqual(['j1', 'j2', 'j3']);
    expect(s.runsOnCurrentVersion).toBe(2);
    expect(s.versionsRun).toBe(2);
    expect(s.costUsd).toBe(1.5);
    expect(s.avgDurationMs).toBe(60_000);
  });
});
