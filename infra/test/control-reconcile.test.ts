import { describe, expect, test } from 'vitest';
import { parseCaseControls, reconcileControlsWithText } from '../lambda/api/controlSchemes.js';

describe('reconcileControlsWithText', () => {
  const rtp = [
    'name: 拉霸機 RTP 量測',
    'controls: [tap]',
    'task: |',
    '  7. 長按 SPIN 約 1.5 秒(hold,holdMs 1500),選單出現後選「500」。',
  ].join('\n');

  test('case text asks for a long-press but controls only allow tap → hold is added', () => {
    const ids = parseCaseControls(rtp)!;
    expect(ids).toEqual(['tap']);
    expect(reconcileControlsWithText(rtp, ids)).toEqual({ ids: ['tap', 'hold'], added: ['hold'] });
  });

  test('no long-press in the text → unchanged; never removes what the user picked', () => {
    const y = 'name: x\ncontrols: [tap, swipe]\ntask: 點 SPIN 轉一次';
    expect(reconcileControlsWithText(y, ['tap', 'swipe'])).toEqual({ ids: ['tap', 'swipe'], added: [] });
    expect(reconcileControlsWithText(rtp, ['tap', 'hold'])).toEqual({ ids: ['tap', 'hold'], added: [] });
  });

  test('empty controls (= unrestricted) stays unrestricted', () => {
    expect(reconcileControlsWithText(rtp, [])).toEqual({ ids: [], added: [] });
  });

  test('the word "hold" in the controls list itself does not count as case text', () => {
    const y = 'name: x\ncontrols:\n  - tap\ntask: 點 SPIN';
    expect(reconcileControlsWithText(y, ['tap']).added).toEqual([]);
  });
});
