import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { RecordingPlayer } from './RecordingPlayer.tsx';
import { downsampleBars, type AudioLevels } from './audioLevels.ts';

describe('downsampleBars', () => {
  it('keeps short loud peaks (max per bucket) and maps dB to 0–1', () => {
    const rms = [-120, -120, -10, -120, -60, -30];
    expect(downsampleBars(rms, 3)).toEqual([0, 50 / 60, 0.5]);
    expect(downsampleBars([], 5)).toEqual([]);
  });
});

describe('RecordingPlayer', () => {
  const levels: AudioLevels = {
    state: 'on',
    dt: 0.1,
    chunks: [{ name: 'rec-0.mp4', t: 1_000_000, dur: 10, rms: Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? -10 : -90)), url: 'https://example/rec-0.mp4' }],
  };
  const steps = [{ index: 0, t: 1_000_000 }, { index: 1, t: 1_004_000 }, { index: 2, t: 9_999_999 }];

  it('renders the video with sound, waveform bars and in-range step markers', () => {
    const { container } = render(<RecordingPlayer levels={levels} steps={steps} lang="zh" />);
    const video = container.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('https://example/rec-0.mp4');
    expect(video.muted).toBe(false);
    expect(container.querySelectorAll('.recplayer__wave rect')).toHaveLength(240);
    expect(container.querySelectorAll('.recplayer__mark')).toHaveLength(2); // 第 3 步不在錄影範圍內
  });

  it('keyboard on the waveform moves the playhead', () => {
    const { getByRole } = render(<RecordingPlayer levels={levels} steps={steps} lang="en" />);
    const wave = getByRole('slider');
    fireEvent.keyDown(wave, { key: 'End' });
    expect(wave.getAttribute('aria-valuenow')).toBe('10');
    fireEvent.keyDown(wave, { key: 'ArrowLeft' });
    expect(wave.getAttribute('aria-valuenow')).toBe('5');
  });

  it('renders nothing when there is no playable recording', () => {
    const { container } = render(<RecordingPlayer levels={{ ...levels, chunks: [{ ...levels.chunks[0]!, url: undefined }] }} steps={[]} lang="zh" />);
    expect(container.firstChild).toBeNull();
  });
});
