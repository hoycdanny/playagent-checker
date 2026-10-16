import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTER, applyFilter, buildFeed, deciderOf, feedCounts, type FeedFilter } from './feed.ts';
import { orientationAt, stepOrientation } from './orientation.ts';
import { buildTimeline } from './timeline.ts';

const T0 = Date.UTC(2026, 9, 16, 10, 35, 43, 0);
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const steps = [
  {
    index: 0, at: iso(0), screen: '開場畫面', action: 'tap', target: 'PLAY', decidedBy: 'agent',
    memory: { screen: 'known', page: { priorVisits: 3 } }, plan: { scriptStep: 1, scriptTotal: 2, goal: '點 PLAY' },
    space: { shot: [1000, 466], device: [3088, 1440] },
  },
  {
    index: 1, at: iso(10_000), screen: '大廳', action: 'tap', target: 'X', decidedBy: 'reflex', reflex: { reason: 'popup' },
    plan: { scriptStep: 1, scriptTotal: 2 }, operatorCommands: [{ text: '先關彈窗' }],
  },
  { index: 2, at: iso(20_000), screen: '老虎機', action: 'tap', target: 'SPIN', plan: { scriptStep: 2, scriptTotal: 2 }, space: { device: [1440, 3088] } },
];
const log = `# step=0 at=${T0} pid=7 dev=${(T0 / 1000).toFixed(3)} sent=${T0}\n${((T0 + 5000) / 1000).toFixed(3)}  7  7 E Unity   : boom\n${((T0 + 5100) / 1000).toFixed(3)}  7  7 W qdgralloc : noise\n${((T0 + 15_000) / 1000).toFixed(3)}  7  7 I Unity   : ok\n`;
const tl = buildTimeline({
  steps,
  logChunks: [{ text: log }],
  traces: [{ index: 0, seat: 'vlm', at: iso(4000), ms: 3000, ok: true, modelId: 'gpt' }, { index: 1, seat: 'agent', at: iso(12_000), ms: 1000, ok: false }],
});
const feed = buildFeed({ tl, steps, sounds: [{ kind: 'game', t: T0 + 6000, title: 'spin.wav' }], lang: 'zh' });
const f = (patch: Partial<FeedFilter>): FeedFilter => ({ ...DEFAULT_FILTER, subs: {}, windowMs: 0, ...patch });

describe('buildFeed', () => {
  it('merges steps, AI calls, memory, script, logs, sound and commands in time order', () => {
    expect(feed.map((e) => `${e.kind}:${e.sub}`)).toEqual([
      'step:agent', 'memory:known', 'script:progress', 'ai:vlm', 'log:E', 'log:W', 'sound:game',
      'step:reflex', 'memory:reflex', 'operator:command', 'ai:agent', 'log:I', 'step:agent', 'script:progress',
    ]);
    expect(feed.find((e) => e.kind === 'script')?.title).toContain('1/2');
    expect(feed.filter((e) => e.kind === 'script')).toHaveLength(2); // 同一項不重複記
    expect(feed.find((e) => e.kind === 'ai' && e.sub === 'agent')?.tone).toBe('bad');
    expect(deciderOf({ operatorGesture: 'tap', decidedBy: 'agent' })).toBe('operator');
  });

  it('filters layer by layer: kind → type → tag → keyword → window → step', () => {
    expect(applyFilter(feed, f({ kinds: ['log'] }), null).map((e) => e.title)).toEqual(['boom', 'noise', 'ok']);
    expect(applyFilter(feed, f({ kinds: ['log'], subs: { log: ['E', 'W'] } }), null).map((e) => e.title)).toEqual(['boom', 'noise']);
    expect(applyFilter(feed, f({ kinds: ['log'], excludeTags: ['qdgralloc'] }), null).map((e) => e.title)).toEqual(['boom', 'ok']);
    expect(applyFilter(feed, f({ kinds: ['log'], tags: ['Unity'], query: 'bo' }), null).map((e) => e.title)).toEqual(['boom']);
    expect(applyFilter(feed, f({ windowMs: 1000 }), T0 + 5500).map((e) => e.kind)).toEqual(['log', 'log', 'sound']);
    expect(applyFilter(feed, f({ kinds: ['step', 'memory', 'operator'], step: 1 }), null).map((e) => `${e.kind}:${e.sub}`)).toEqual(['step:reflex', 'memory:reflex', 'operator:command']);
  });

  it('counts per kind / type / tag within the window', () => {
    const c = feedCounts(feed, null, 0);
    expect(c.kinds.log).toBe(3);
    expect(c.subs['step:reflex']).toBe(1);
    expect(c.tags).toEqual([['Unity', 2], ['qdgralloc', 1]]);
  });
});

describe('app orientation', () => {
  it('reads the step coordinate space and carries it forward', () => {
    expect(stepOrientation(steps[0])).toBe('landscape');
    expect(stepOrientation(steps[1])).toBeNull();
    expect(orientationAt(steps, 1)).toBe('landscape'); // 沿用前一步
    expect(orientationAt(steps, 2)).toBe('portrait'); // 進遊戲變直向
    expect(orientationAt(steps, null)).toBe('portrait');
    expect(orientationAt([{ index: 0 }, { index: 1, space: { device: [400, 800] } }], 0)).toBe('portrait'); // 開頭沒有 → 往後找
    expect(orientationAt([{ index: 0 }], null)).toBeNull();
  });
});
