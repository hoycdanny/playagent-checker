import { describe, test, expect } from 'vitest';
import { effectiveState, STALE_AFTER_MS } from '../lambda/api/status.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('effectiveState (stale running → dead)', () => {
  test('running and recently updated stays running', () => {
    expect(effectiveState({ state: 'running', updatedAt: ago(60_000), message: '第 3 步' }, NOW))
      .toEqual({ state: 'running', message: '第 3 步', stale: false });
  });

  test('running with no update for longer than the limit becomes dead', () => {
    const r = effectiveState({ state: 'running', updatedAt: ago(STALE_AFTER_MS + 1), message: '第 761 步' }, NOW);
    expect(r.state).toBe('dead');
    expect(r.stale).toBe(true);
    expect(r.message).toMatch(/45 分鐘/);
  });

  test('terminal states are never rewritten, however old', () => {
    for (const state of ['pass', 'fail', 'error', 'cancelled', 'budget_exceeded', 'dead']) {
      expect(effectiveState({ state, updatedAt: ago(10 * STALE_AFTER_MS) }, NOW).state).toBe(state);
    }
  });

  test('no status yet = queued; missing updatedAt is not treated as stale', () => {
    expect(effectiveState(null, NOW).state).toBe('queued');
    expect(effectiveState({ state: 'running' }, NOW).state).toBe('running');
  });
});
