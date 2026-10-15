import { describe, expect, test } from 'vitest';
import { operatorDirectNote } from '../../agent/operatorMemory.mjs';

describe('operatorDirectNote(測試人員直接操作裝置後告知控制遊戲 Agent)', () => {
  const tap = { kind: 'tap', shot: { x: 1064, y: 490 }, device: { x: 1544, y: 720 }, space: { shot: [2128, 980], device: [3088, 1440] } };

  test('pixel model: reports screenshot pixels and device pixels', () => {
    const s = operatorDirectNote(tap, false);
    expect(s).toContain('已執行完畢,不經 AI');
    expect(s).toContain('(1064, 490)(截圖像素)');
    expect(s).toContain('裝置像素 (1544, 720)');
    expect(s).toContain('不要重複這個操作');
  });

  test('norm1000 model: converts to the model’s own 0–1000 space', () => {
    const s = operatorDirectNote(tap, true);
    expect(s).toContain('(500, 500)(0~1000 相對座標)');
    expect(s).toContain('裝置像素 (1544, 720)');
  });

  test('drag: start → end in both spaces, plus the tester’s words', () => {
    const drag = {
      kind: 'drag',
      shot: { x: 0, y: 0, x2: 2128, y2: 980 },
      device: { x: 0, y: 0, x2: 3088, y2: 1440 },
      space: { shot: [2128, 980], device: [3088, 1440] },
      said: '把寶石拖到右下',
    };
    const s = operatorDirectNote(drag, true);
    expect(s).toContain('(0, 0) 按住拖到 (1000, 1000)');
    expect(s).toContain('(0, 0) → (3088, 1440)');
    expect(s).toContain('「把寶石拖到右下」');
  });
});
