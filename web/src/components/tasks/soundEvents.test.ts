import { describe, expect, test } from 'vitest';
import { buildSoundEvents, clipName, eventsFromLogcat, onsetsFromLevels } from './soundEvents.ts';
import type { AudioLevels } from './audioLevels.ts';

// 2026-10-12 真機實測的 Unity log(Galaxy S23 Ultra),dev/sent 標頭把裝置時鐘對到 runner 時鐘(+500ms)。
const CHUNK = [
  '# step=4 at=1791776486000 pid=11522 dev=1791776450.000 sent=1791776450500',
  '1791776452.708 11522 11657 D AAudio  : AAudioStream_requestStop(s#1) called',
  '1791776452.708 11522 11657 D AAudioStream: setState(s#1) from 4 to 9',
  '1791776452.933 11522 11657 D AAudio  : AAudioStream_requestStart(s#1) called --------------',
  '1791776452.948 11522 11657 D AAudio  : AAudioStream_requestStart(s#1) returned 0 ---------',
  '1791776475.765 11522 11657 W Unity   : Can not play a disabled audio source',
  '1791776475.765 11522 11657 W Unity   : UnityEngine.AudioSource:Play()',
  '1791776475.765 11522 11657 W Unity   : AudioCtrlManager:PlaySound(Int32, Boolean, Boolean, Single, Single)',
  '1791776475.765 11522 11657 W Unity   : AudioCtrlManager:PlaySound(AudioClip, Single, Single)',
  '1791776475.765 11522 11657 W Unity   : DragonUIPlaySound:Play()',
  '1791776475.765 11522 11657 W Unity   : DragonUIPlaySound:OnClick()',
  '1791776478.533 11522 11657 I Unity   :  [Play Games Plugin 2.1.0] DEBUG: Starting Auth',
  '1791776480.000 11522 11657 I Unity   : [SFX] win_big.ogg',
  '1791776481.000 999 999 I Unity   : [SFX] other_app.ogg',
].join('\n');

describe('eventsFromLogcat', () => {
  test('Unity fail with call stack, game SFX with name, AAudio stream; other pids ignored', () => {
    const ev = eventsFromLogcat([{ text: CHUNK }]);
    expect(ev.map((e) => e.kind)).toEqual(['stream', 'stream', 'fail', 'game']);
    // 同一刻 AudioTrack stop 不重複列
    expect(eventsFromLogcat([{ text: `${CHUNK}\n1791776490.000 11522 11657 D AAudio  : AAudioStream_requestStop(s#1) called\n1791776490.001 11522 11657 D AudioTrack: stop(34): called with 1 frames delivered` }]).filter((e) => e.kind === 'stream')).toHaveLength(3);
    expect(ev[0]).toMatchObject({ title: 'AAudio stop', t: 1791776453208 });
    expect(ev[1]).toMatchObject({ title: 'AAudio start' });
    expect(ev[2]!.title).toContain('Can not play a disabled audio source');
    expect(ev[2]!.detail).toContain('AudioCtrlManager:PlaySound() ← DragonUIPlaySound:OnClick()');
    expect(ev[3]).toMatchObject({ kind: 'game', title: 'win_big.ogg', t: 1791776480500 });
  });

  test('clipName', () => {
    expect(clipName('[SFX] coin_drop')).toBe('coin_drop');
    expect(clipName('Play clip=jackpot_01 vol=1')).toBe('jackpot_01');
    expect(clipName('loading Audio/bgm_main.mp3')).toBe('bgm_main.mp3');
    expect(clipName('nothing here')).toBeUndefined();
  });
});

describe('onsets + buildSoundEvents', () => {
  const T0 = 1791776478000;
  // 5 秒:BGM -30 dB;第 2.6 秒 -10 dB 的金幣音持續 0.4 秒(遊戲在 2.5 秒呼叫播放)
  const rms = Array.from({ length: 50 }, (_, i) => (i >= 26 && i < 30 ? -10 : -30));
  const levels: AudioLevels = { state: 'on', dt: 0.1, chunks: [{ name: 'rec-0.mp4', t: T0, dur: 5, rms }] };

  test('onset has peak and duration', () => {
    const o = onsetsFromLevels(levels);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ kind: 'onset', t: T0 + 2600, peakDb: -10, durMs: 400 });
  });

  test('game call is checked against the recording and tagged with its step', () => {
    const ev = buildSoundEvents({
      logChunks: [{ text: CHUNK }],
      levels,
      steps: [{ index: 3, t: T0 - 10_000, screen: '大廳' }, { index: 4, t: T0 + 1000, screen: '中獎' }],
    });
    const sfx = ev.find((e) => e.kind === 'game')!;
    expect(sfx.heard).toBe(true); // 呼叫在 T0+2500,錄影在 T0+2600 有聲 → 呼叫後 1 秒內
    expect(sfx.step).toBe(4);
    expect(sfx.screen).toBe('中獎');
    expect(ev.find((e) => e.kind === 'fail')!.heard).toBeUndefined(); // 那時沒有錄影
    expect(ev[0]!.t).toBeGreaterThanOrEqual(ev[ev.length - 1]!.t); // 新 → 舊
  });
});
