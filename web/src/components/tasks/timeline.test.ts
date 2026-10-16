import { describe, expect, it } from 'vitest';
import {
  adjacentStep,
  alignLogcat,
  alignedChunkStart,
  buildTimeline,
  chunkAt,
  fmtClock,
  levelAt,
  logBins,
  logsBetween,
  parseClock,
  stepAt,
  tickStep,
  tracesAt,
  waveBins,
} from './timeline.ts';

const T0 = Date.UTC(2026, 9, 16, 10, 35, 43, 0);
const iso = (ms: number) => new Date(T0 + ms).toISOString();

describe('clock format', () => {
  it('formats and parses m:ss.mmm', () => {
    expect(fmtClock(82_001)).toBe('1:22.001');
    expect(fmtClock(0)).toBe('0:00.000');
    expect(fmtClock(3_723_004)).toBe('1:02:03.004');
    expect(fmtClock(-1500)).toBe('-0:01.500');
    expect(parseClock('1:22.001')).toBe(82_001);
    expect(parseClock('1:22.5')).toBe(82_500);
    expect(parseClock('82')).toBe(82_000);
    expect(parseClock('0:01:22')).toBe(82_000);
    expect(parseClock('1：22，001')).toBe(82_001);
    expect(parseClock('1:75')).toBeNull();
    expect(parseClock('abc')).toBeNull();
  });
  it('picks readable tick steps', () => {
    expect(tickStep(1000)).toBe(100);
    expect(tickStep(60_000)).toBe(5000);
    expect(tickStep(600_000)).toBe(60_000);
  });
});

describe('recording start alignment', () => {
  it('uses the real video length for chunks ended by stop(), keeps auto-ended ones', () => {
    // runner: t = stopAt - 227.0 s(音量長度);影片真正 228.0 s → 開始時間早 1 秒。
    const c = { t: T0, dur: 227 };
    expect(alignedChunkStart(c, undefined, 228)).toBe(T0 - 1000);
    expect(alignedChunkStart(c, { t: T0 + 227_000 + 5000 }, 228)).toBe(T0); // 長度上限自己結束,下一段 5 秒後接上
    expect(alignedChunkStart(c, undefined, undefined)).toBe(T0);
  });
});

describe('buildTimeline', () => {
  const steps = [
    { index: 0, at: iso(2000), screen: '開場畫面', action: 'tap', target: 'PLAY', decidedBy: 'agent', durationMs: 13_000 },
    { index: 1, at: iso(20_000), screen: '載入中', action: 'wait', decidedBy: 'reflex' },
    { index: 2, at: iso(40_000), screen: '大廳', action: 'tap', durationMs: 5000 },
  ];
  const levels = { state: 'on' as const, dt: 0.1, chunks: [{ name: 'rec-0.mp4', t: T0, dur: 60, rms: Array.from({ length: 600 }, (_, i) => (i === 205 ? -10 : -80)), url: 'u' }] };
  const devSec = (T0 - 1234) / 1000; // 裝置時鐘慢 1.234 秒
  const log = `# step=3 at=${T0} pid=4242 dev=${devSec.toFixed(3)} sent=${T0}\n${((T0 - 1234 + 20_500) / 1000).toFixed(3)}  4242  4300 E Unity   : NullReferenceException\n${((T0 - 1234 + 21_000) / 1000).toFixed(3)}  4242  4300 W Unity   : slow frame\n`;
  const traces = [
    { index: 0, seat: 'vlm', at: iso(9000), ms: 6000, ok: true, modelId: 'm1' },
    { index: 0, seat: 'agent', at: iso(12_000), ms: 2500, ok: false },
    { index: 1, seat: 'vlm', at: iso(25_000) },
  ];
  const tl = buildTimeline({ steps, levels, logChunks: [{ text: log }], traces });

  it('origin = recording start, steps run until the next step', () => {
    expect(tl.origin).toBe(T0);
    expect(tl.end).toBe(T0 + 60_000);
    expect(tl.steps.map((s) => [s.index, s.t - T0, s.end - T0])).toEqual([[0, 2000, 20_000], [1, 20_000, 40_000], [2, 40_000, 45_000]]);
    expect(tl.steps[1]).toMatchObject({ decidedBy: 'reflex', screen: '載入中' });
  });

  it('finds what happens at a moment', () => {
    expect(stepAt(tl, T0 + 1000)).toBeNull();
    expect(stepAt(tl, T0 + 20_500)?.index).toBe(1);
    expect(chunkAt(tl, T0 + 20_500)).toMatchObject({ index: 0, sec: 20.5 });
    expect(chunkAt(tl, T0 + 61_000)).toBeNull();
    expect(levelAt(tl, T0 + 20_550)).toBe(-10);
    expect(tracesAt(tl, T0 + 4000).map((x) => x.seat)).toEqual(['vlm']);
    expect(tracesAt(tl, T0 + 10_000).map((x) => [x.seat, x.ok])).toEqual([['agent', false]]);
    expect(tracesAt(tl, T0 + 25_300).map((x) => x.index)).toEqual([1]); // 沒有耗時:結束前後 0.5 秒
  });

  it('device log is converted to the runner clock', () => {
    expect(tl.logs.map((l) => [l.t - T0, l.level, l.dev - T0])).toEqual([[20_500, 'E', 20_500 - 1234], [21_000, 'W', 21_000 - 1234]]);
    expect(logsBetween(tl, T0 + 19_600, T0 + 21_500).map((l) => l.msg)).toEqual(['NullReferenceException', 'slow frame']);
    expect(logsBetween(tl, T0 + 20_600, T0 + 20_900)).toEqual([]);
    const bins = logBins(tl.logs, T0, T0 + 60_000, 60);
    expect(bins[20]).toEqual({ count: 1, level: 'E' });
    expect(bins[21]).toEqual({ count: 1, level: 'W' });
  });

  it('waveform bins show loud moments and gaps', () => {
    const w = waveBins(tl, T0, T0 + 60_000, 60);
    expect(w[20]).toBe(-10);
    expect(w[30]).toBe(-80);
    const out = waveBins(tl, T0 + 55_000, T0 + 70_000, 15);
    expect(out[0]).toBe(-80);
    expect(out[14]).toBeNull();
  });

  it('previous / next step', () => {
    expect(adjacentStep(tl, T0 + 25_000, 1)?.index).toBe(2);
    expect(adjacentStep(tl, T0 + 25_000, -1)?.index).toBe(1); // 在第 1 步中間 → 回到第 1 步開頭
    expect(adjacentStep(tl, T0 + 20_000, -1)?.index).toBe(0); // 剛好在開頭 → 上一步
    expect(adjacentStep(tl, T0 + 40_000, 1)).toBeNull();
  });

  it('without a recording the timeline starts at the first step; live runs extend to now', () => {
    const live = buildTimeline({ steps, now: T0 + 90_000 });
    expect(live.origin).toBe(T0 + 2000);
    expect(live.end).toBe(T0 + 90_000);
    expect(live.steps[2]!.end).toBe(T0 + 90_000);
  });

  it('alignLogcat without a header keeps device time', () => {
    const l = alignLogcat([{ text: '1760610943.500  1  2 I Tag : hi' }]);
    expect(l[0]).toMatchObject({ t: 1760610943500, dev: 1760610943500, msg: 'hi' });
  });
});
