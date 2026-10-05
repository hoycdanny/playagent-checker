import { describe, expect, test } from 'vitest';
import { soundInWindow, type AudioLevels } from './audioLevels.ts';

const T0 = 1_000_000;
// 4 秒:BGM -25 dB,第 2 秒有一聲 -8 dB 的金幣音(持續 0.3 秒)
const rms = Array.from({ length: 40 }, (_, i) => (i >= 20 && i < 23 ? -8 : -25));
const L: AudioLevels = { state: 'on', dt: 0.1, chunks: [{ name: 'a', t: T0, dur: 4, rms }] };

describe('soundInWindow', () => {
  test('detects a coin-like onset over background music', () => {
    const s = soundInWindow(L, T0, T0 + 4000, 10);
    expect(s.covered).toBe(true);
    expect(s.coverage).toBeCloseTo(1);
    expect(s.peakDb).toBe(-8);
    expect(s.onsets).toBe(1);
    expect(s.bars).toHaveLength(10);
    expect(Math.max(...s.bars)).toBeGreaterThan(s.bars[0]!);
  });

  test('window without the effect has no onset; outside recording is not covered', () => {
    expect(soundInWindow(L, T0, T0 + 1500).onsets).toBe(0);
    expect(soundInWindow(L, T0 + 10_000, T0 + 12_000).covered).toBe(false);
    expect(soundInWindow(null, T0, T0 + 1).covered).toBe(false);
  });

  test('silence stays silent', () => {
    const quiet: AudioLevels = { state: 'on', dt: 0.1, chunks: [{ name: 'q', t: T0, dur: 2, rms: Array(20).fill(-120) }] };
    const s = soundInWindow(quiet, T0, T0 + 2000);
    expect(s.peakDb).toBe(-120);
    expect(s.onsets).toBe(0);
    expect(s.bars.every((b) => b === 0)).toBe(true);
  });
});
