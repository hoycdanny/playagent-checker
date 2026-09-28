import { describe, it, expect } from 'vitest';
// .mjs runner exports pure helpers; no types needed for the transform math.
// @ts-ignore
import { transformCoordinates, resolveRotation, buildSystemPrompt, makeUserTurn, makeAssistantTurn, pruneImages } from '../lambda/engine/emulatorRunner.mjs';

/**
 * 座標轉換是 emulator runner 的核心正確性:VLM 在「截圖像素空間」判座標,
 * adb input tap 用「裝置邏輯空間」。兩者方向/尺寸不一致時必須旋轉+縮放,
 * 否則點擊落在空白處(使用者實際遇到的 bug)。
 */
describe('emulator 座標轉換', () => {
  describe('resolveRotation', () => {
    it('方向一致(都橫屏)→ none', () => {
      expect(resolveRotation({ w: 1920, h: 1080 }, { w: 1920, h: 1080 }, 0)).toBe('none');
    });
    it('方向一致(都直屏)→ none', () => {
      expect(resolveRotation({ w: 1080, h: 1920 }, { w: 1080, h: 1920 }, 0)).toBe('none');
    });
    it('尺寸吻合(8% 容差內)→ none', () => {
      expect(resolveRotation({ w: 1080, h: 1920 }, { w: 1080, h: 1900 }, 0)).toBe('none');
    });
    it('橫截圖/直裝置 + ROTATION_90 → cw90', () => {
      expect(resolveRotation({ w: 1920, h: 1080 }, { w: 1080, h: 1920 }, 1)).toBe('cw90');
    });
    it('橫截圖/直裝置 + ROTATION_270 → ccw90', () => {
      expect(resolveRotation({ w: 1920, h: 1080 }, { w: 1080, h: 1920 }, 3)).toBe('ccw90');
    });
    it('橫截圖/直裝置 + 無旋轉資訊但 cross-match → cw90(auto)', () => {
      expect(resolveRotation({ w: 1920, h: 1080 }, { w: 1080, h: 1920 }, 0)).toBe('cw90');
    });
    it('180 旋轉', () => {
      expect(resolveRotation({ w: 1920, h: 1080 }, { w: 1080, h: 1920 }, 2)).toBe('180');
    });
  });

  describe('transformCoordinates', () => {
    it('none:純縮放(截圖 1920x1080 → 裝置 960x540,取中心)', () => {
      const [x, y] = transformCoordinates(960, 540, { w: 1920, h: 1080 }, { w: 960, h: 540 }, 0);
      expect(x).toBe(480);
      expect(y).toBe(270);
    });

    it('none:同尺寸直通', () => {
      const [x, y] = transformCoordinates(715, 202, { w: 1920, h: 1080 }, { w: 1920, h: 1080 }, 0);
      expect(x).toBe(715);
      expect(y).toBe(202);
    });

    it('cw90:橫截圖右上角按鈕 → 直裝置座標(使用者 bug 情境)', () => {
      // 截圖 1920x1080(橫),裝置 1080x1920(直),ROTATION_90(cw90)。
      // 截圖右上角 (1900, 50) 的按鈕,轉到裝置空間應落在合理範圍內,而非空白。
      const ss = { w: 1920, h: 1080 };
      const dev = { w: 1080, h: 1920 };
      const [x, y] = transformCoordinates(1900, 50, ss, dev, 1);
      // cw90 公式:x' = (ssH - y) * devW / ssH ; y' = x * devH / ssW
      expect(x).toBe(Math.round((1080 - 50) * 1080 / 1080)); // 1030
      expect(y).toBe(Math.round(1900 * 1920 / 1920)); // 1900
      // 座標必須落在裝置範圍內。
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(dev.w);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(dev.h);
    });

    it('cw90:截圖中心 → 裝置中心', () => {
      const ss = { w: 1920, h: 1080 };
      const dev = { w: 1080, h: 1920 };
      const [x, y] = transformCoordinates(960, 540, ss, dev, 1);
      expect(x).toBe(540);
      expect(y).toBe(960);
    });

    it('ccw90:截圖中心 → 裝置中心', () => {
      const ss = { w: 1920, h: 1080 };
      const dev = { w: 1080, h: 1920 };
      const [x, y] = transformCoordinates(960, 540, ss, dev, 3);
      expect(x).toBe(540);
      expect(y).toBe(960);
    });

    it('tap 空間 == 截圖空間(實測:screencap 與 input tap 同一橫式空間)→ identity', () => {
      // runner 現在把 dev 設為 ss;此時無論方向如何,座標原封不動送 adb tap。
      const ss = { w: 1920, h: 1080 };
      for (const [px, py] of [[1190, 713], [1342, 380], [0, 0], [1919, 1079]]) {
        const [x, y] = transformCoordinates(px, py, ss, ss, 1);
        expect(x).toBe(px);
        expect(y).toBe(py);
      }
    });

    it('轉換後座標恆落在裝置範圍內(各角落 + cw90)', () => {
      const ss = { w: 1920, h: 1080 };
      const dev = { w: 1080, h: 1920 };
      for (const [px, py] of [[0, 0], [1919, 0], [0, 1079], [1919, 1079], [960, 540]]) {
        const [x, y] = transformCoordinates(px, py, ss, dev, 1);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(dev.w);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(dev.h);
      }
    });
  });
});

/**
 * 累積對話(修復「AI 繞圈/卡畫面」的核心):runner 現在把每步的推理鏈與截圖回饋帶進多輪對話,
 * 而非每步無記憶單輪重建。以下驗證對話組裝的純邏輯。
 */
describe('emulator 累積對話', () => {
  it('buildSystemPrompt 含截圖尺寸與「不要重複同座標」指引', () => {
    const p = buildSystemPrompt({ w: 1920, h: 1080 });
    expect(p).toContain('1920x1080');
    expect(p).toContain('不要重複同');
    expect(p).toContain('連續對話'); // 明示模型會記得前幾步
  });

  it('buildSystemPrompt:無知識時不附背景知識段落', () => {
    const p = buildSystemPrompt({ w: 1080, h: 1920 }, '');
    expect(p).not.toContain('類型」的背景知識');
  });

  it('buildSystemPrompt:有知識時附上背景知識段落', () => {
    const p = buildSystemPrompt({ w: 1080, h: 1920 }, '# Slot\n轉軸與 Spin 測試重點');
    expect(p).toContain('類型」的背景知識');
    expect(p).toContain('轉軸與 Spin');
  });

  it('makeUserTurn:多圖 + 文字,略過空圖', () => {
    const turn = makeUserTurn(['imgA', '', 'imgB'], '這是回饋');
    expect(turn.role).toBe('user');
    const imgs = turn.content.filter((c: { type: string }) => c.type === 'image');
    const txt = turn.content.filter((c: { type: string }) => c.type === 'text');
    expect(imgs).toHaveLength(2); // 空字串被略過
    expect(txt).toHaveLength(1);
    expect(txt[0].text).toBe('這是回饋');
  });

  it('makeAssistantTurn 保留模型原始回應(推理鏈)', () => {
    const turn = makeAssistantTurn('我看到主選單', '{"thinking":"我看到主選單","action":"tap"}');
    expect(turn.role).toBe('assistant');
    expect(turn.content[0].text).toContain('主選單');
  });

  it('pruneImages:只保留最後 N 個 user turn 的圖,較舊者只留文字', () => {
    const mk = (t: string) => makeUserTurn(['img'], t);
    const messages = [
      { role: 'system', content: [{ type: 'text', text: 's' }] },
      mk('turn1'),
      makeAssistantTurn('', 'a1'),
      mk('turn2'),
      makeAssistantTurn('', 'a2'),
      mk('turn3'),
    ];
    pruneImages(messages, 2);
    const userTurns = messages.filter((m) => m.role === 'user');
    const hasImg = (m: { content: { type: string }[] }) => m.content.some((c) => c.type === 'image');
    // 最後兩個 user turn 保留圖;第一個(turn1)圖被移除只剩文字。
    expect(hasImg(userTurns[0])).toBe(false);
    expect(hasImg(userTurns[1])).toBe(true);
    expect(hasImg(userTurns[2])).toBe(true);
    // 被移除圖的 turn 仍保有文字(不產生空 content)。
    expect(userTurns[0].content.length).toBeGreaterThan(0);
    // assistant 推理鏈不受影響。
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('pruneImages:user turn 少於 keepLatest 時全部保留', () => {
    const messages = [makeUserTurn(['img'], 'only')];
    pruneImages(messages, 2);
    expect(messages[0].content.some((c: { type: string }) => c.type === 'image')).toBe(true);
  });
});
