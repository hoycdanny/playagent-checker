import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TaskTimeline } from './TaskTimeline.tsx';
import { buildTimeline } from './timeline.ts';

const T0 = Date.UTC(2026, 9, 16, 10, 35, 43, 0);
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const tl = buildTimeline({
  steps: [
    { index: 0, at: iso(0), screen: '開場畫面', action: 'tap', target: 'PLAY', decidedBy: 'agent' },
    { index: 1, at: iso(20_000), screen: '大廳', action: 'tap', target: 'X', decidedBy: 'reflex', durationMs: 4000 },
  ],
  levels: { state: 'on', dt: 0.1, chunks: [{ name: 'rec-0.mp4', t: T0, dur: 30, rms: Array.from({ length: 300 }, () => -50), url: 'u' }] },
});

function setup(cursor: number | null = T0 + 21_500) {
  const onSeek = vi.fn();
  const onTogglePlay = vi.fn();
  render(<TaskTimeline tl={tl} cursor={cursor} onSeek={onSeek} lang="zh" hasVideo playing={false} onTogglePlay={onTogglePlay} />);
  return { onSeek, onTogglePlay };
}

describe('TaskTimeline', () => {
  it('shows the moment under the playhead', () => {
    setup();
    expect(screen.getByText('0:21.500')).toBeTruthy();
    expect(screen.getByText('照記憶')).toBeTruthy();
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toContain('#1 大廳');
  });

  it('typing 0:05.250 jumps there', () => {
    const { onSeek } = setup();
    fireEvent.change(screen.getByPlaceholderText('1:22.001'), { target: { value: '0:05.250' } });
    fireEvent.submit(screen.getByPlaceholderText('1:22.001').closest('form')!);
    expect(onSeek).toHaveBeenLastCalledWith(T0 + 5250, false);
  });

  it('rejects a bad time', () => {
    const { onSeek } = setup();
    fireEvent.change(screen.getByPlaceholderText('1:22.001'), { target: { value: '1:99' } });
    fireEvent.submit(screen.getByPlaceholderText('1:22.001').closest('form')!);
    expect(onSeek).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('keyboard: arrows nudge (Alt = 10 ms), PageUp goes to the step start, Space plays', () => {
    const { onSeek, onTogglePlay } = setup();
    const lanes = screen.getByRole('slider');
    fireEvent.keyDown(lanes, { key: 'ArrowRight' });
    expect(onSeek).toHaveBeenLastCalledWith(T0 + 21_600, false);
    fireEvent.keyDown(lanes, { key: 'ArrowLeft', altKey: true });
    expect(onSeek).toHaveBeenLastCalledWith(T0 + 21_490, false);
    fireEvent.keyDown(lanes, { key: 'PageUp' });
    expect(onSeek).toHaveBeenLastCalledWith(T0 + 20_000, false);
    fireEvent.keyDown(lanes, { key: ' ' });
    expect(onTogglePlay).toHaveBeenCalled();
  });

  it('next-step button seeks to the following step', () => {
    const { onSeek } = setup(T0 + 3000);
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(onSeek).toHaveBeenLastCalledWith(T0 + 20_000, false);
  });
});
