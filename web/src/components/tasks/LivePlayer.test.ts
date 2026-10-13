import { describe, expect, test } from 'vitest';
import {
  containRect, DRAG_MIN_PX, DRAG_MS_MAX, DRAG_MS_MIN, formatPick, gestureBody, gestureFrom, toContentPoint, toContentPointClamped,
} from './LivePlayer.tsx';

describe('click → screen position (object-fit: contain)', () => {
  test('landscape video in a portrait box: black bars top/bottom are ignored', () => {
    // 框 400×800,影片 2404×1080 → 內容 400×~180,上下各 ~310 黑邊
    const r = containRect(400, 800, 2404, 1080);
    expect(r.width).toBe(400);
    expect(Math.round(r.height)).toBe(180);
    expect(Math.round(r.top)).toBe(310);
    expect(toContentPoint(200, 100, 400, 800, 2404, 1080)).toBeNull(); // 點在上黑邊
    const p = toContentPoint(300, 400, 400, 800, 2404, 1080)!;
    expect(p.x).toBeCloseTo(0.75, 3);
    expect(p.y).toBeCloseTo(0.5, 2);
  });

  test('portrait video in a wide box: bars left/right', () => {
    const p = toContentPoint(500, 790, 1000, 800, 1080, 2400)!; // 內容寬 360,左邊 320 黑邊
    expect(p.x).toBeCloseTo(0.5, 3);
    expect(p.y).toBeCloseTo(0.9875, 3);
    expect(toContentPoint(100, 400, 1000, 800, 1080, 2400)).toBeNull();
  });
});

describe('press-and-drag → drag gesture', () => {
  test('tiny movement is a tap; a real movement is a drag with clamped duration', () => {
    const s = { x: 0.2, y: 0.8 };
    expect(gestureFrom(s, { x: 0.201, y: 0.8 }, DRAG_MIN_PX - 1, 900)).toEqual({ x: 0.2, y: 0.8 });
    expect(gestureFrom(s, { x: 0.7, y: 0.3 }, 120, 850)).toEqual({ x: 0.2, y: 0.8, to: { x: 0.7, y: 0.3 }, ms: 850 });
    expect(gestureFrom(s, { x: 0.7, y: 0.3 }, 120, 20)!.ms).toBe(DRAG_MS_MIN);
    expect(gestureFrom(s, { x: 0.7, y: 0.3 }, 120, 60_000)!.ms).toBe(DRAG_MS_MAX);
    // 移動夠遠但換算後同一點(極小畫面)→ 仍算點一下,不送起終點相同的拖曳。
    expect(gestureFrom(s, { x: 0.2, y: 0.8 }, 50, 500)).toEqual({ x: 0.2, y: 0.8 });
  });

  test('drag end outside the content is clamped to the edge (not dropped)', () => {
    // 框 400×800,影片 2404×1080:內容在 y≈310–490;拖到下黑邊 → y = 1
    const end = toContentPointClamped(450, 700, 400, 800, 2404, 1080);
    expect(end).toEqual({ x: 1, y: 1 });
    const mid = toContentPointClamped(200, 400, 400, 800, 2404, 1080);
    expect(mid.x).toBeCloseTo(0.5, 3);
    expect(mid.y).toBeCloseTo(0.5, 2);
  });

  test('request body and label', () => {
    expect(gestureBody({ x: 0.1, y: 0.2 })).toEqual({ point: { x: 0.1, y: 0.2 } });
    expect(gestureBody({ x: 0.1, y: 0.2, to: { x: 0.9, y: 0.2 }, ms: 700 })).toEqual({ point: { x: 0.1, y: 0.2 }, to: { x: 0.9, y: 0.2 }, dragMs: 700 });
    expect(formatPick({ x: 0.1, y: 0.2 })).toBe('10%, 20%');
    expect(formatPick({ x: 0.1, y: 0.2, to: { x: 0.9, y: 0.25 } })).toBe('10%, 20% → 90%, 25%');
  });
});
