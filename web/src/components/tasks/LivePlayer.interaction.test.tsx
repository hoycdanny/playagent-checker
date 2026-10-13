import { beforeAll, describe, expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { LivePlayer, type PickPoint } from './LivePlayer.tsx';

// jsdom 沒有 PointerEvent:用 MouseEvent 補(帶 pointerId),讓 clientX/clientY/button 照常傳入。
beforeAll(() => {
  // jsdom 沒實作 <video> 的 load/pause(播放器卸載/重置時會呼叫)。
  HTMLMediaElement.prototype.load = () => {};
  HTMLMediaElement.prototype.pause = () => {};
  if (!('PointerEvent' in window)) {
    class PE extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (window as unknown as { PointerEvent: typeof PE }).PointerEvent = PE;
  }
});

/** 框 450×1000(與預設比例 9:20 相同 → 沒有黑邊),左上角在 (0,0)。 */
function setup() {
  const onPick = vi.fn<(p: PickPoint) => void>();
  const { container } = render(<LivePlayer jobId="job-1" isLive={false} alt="screen" onPick={onPick} />);
  const box = container.querySelector('.liveplayer') as HTMLDivElement;
  box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 450, height: 1000, right: 450, bottom: 1000, x: 0, y: 0, toJSON: () => ({}) });
  return { box, onPick, container };
}

describe('LivePlayer pick gestures', () => {
  test('click without moving → tap point', () => {
    const { box, onPick } = setup();
    fireEvent.pointerDown(box, { clientX: 225, clientY: 500, button: 0, pointerId: 1 });
    fireEvent.pointerUp(box, { clientX: 227, clientY: 501, button: 0, pointerId: 1 });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toEqual({ x: 0.5, y: 0.5 });
  });

  test('press, drag and release → drag from start to end, with preview arrow while dragging', () => {
    const { box, onPick, container } = setup();
    fireEvent.pointerDown(box, { clientX: 90, clientY: 800, button: 0, pointerId: 7 });
    fireEvent.pointerMove(box, { clientX: 300, clientY: 400, pointerId: 7 });
    expect(container.querySelector('.liveplayer__drag line')).not.toBeNull(); // 拖曳中即時顯示路徑
    fireEvent.pointerMove(box, { clientX: 600, clientY: 200, pointerId: 7 }); // 拖出框外 → 夾在邊緣
    fireEvent.pointerUp(box, { clientX: 600, clientY: 200, pointerId: 7 });
    const p = onPick.mock.calls[0]![0];
    expect(p.x).toBeCloseTo(0.2, 3);
    expect(p.y).toBeCloseTo(0.8, 3);
    expect(p.to).toEqual({ x: 1, y: 0.2 });
    expect(p.ms).toBeGreaterThanOrEqual(100);
    expect(container.querySelector('.liveplayer__drag')).toBeNull(); // 放開後預覽消失(由外層 marker 接手)
  });

  test('cancelled pointer (e.g. touch interrupted) sends nothing', () => {
    const { box, onPick } = setup();
    fireEvent.pointerDown(box, { clientX: 90, clientY: 800, button: 0, pointerId: 2 });
    fireEvent.pointerMove(box, { clientX: 300, clientY: 400, pointerId: 2 });
    fireEvent.pointerCancel(box, { pointerId: 2 });
    fireEvent.pointerUp(box, { clientX: 300, clientY: 400, pointerId: 2 });
    expect(onPick).not.toHaveBeenCalled();
  });

  test('a selected drag is drawn as an arrow marker', () => {
    const { container } = render(
      <LivePlayer jobId="job-1" isLive={false} alt="screen" onPick={() => {}} marker={{ x: 0.2, y: 0.8, to: { x: 0.7, y: 0.3 }, ms: 800 }} />,
    );
    // 第一次渲染時 boxRef 尚未掛上;重新渲染一次(實際上由 resize/狀態更新觸發)。
    const box = container.querySelector('.liveplayer') as HTMLDivElement;
    box.getBoundingClientRect = () => ({ left: 0, top: 0, width: 450, height: 1000, right: 450, bottom: 1000, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent(window, new Event('resize'));
    const line = container.querySelector('.liveplayer__drag-line');
    expect(line?.getAttribute('x1')).toBe('90');
    expect(line?.getAttribute('y2')).toBe('300');
    expect(container.querySelector('.liveplayer__marker.is-drag')).not.toBeNull();
  });
});
