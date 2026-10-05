import { describe, expect, test } from 'vitest';
import { containRect, toContentPoint } from './LivePlayer.tsx';

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
