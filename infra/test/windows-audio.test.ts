import { describe, expect, test } from 'vitest';
// @ts-expect-error 無 .d.ts 的 .mjs 匯入
const w = await import('../../agent/windowsClient.mjs');

/**
 * Windows 的聲音判斷(WASAPI 音量峰值)。
 *
 * 為什麼不是用 ffmpeg 錄一段來分析:ffmpeg 在 Windows 的音訊輸入走 dshow,不暴露
 * WASAPI loopback —— 要錄系統「播放出去」的聲音得先裝虛擬音訊驅動,那是核心模式驅動,
 * 在用完就消失的 stream session 裡裝不了。IAudioMeterInformation 不必裝任何東西,
 * 直接問系統「這個輸出端點現在的峰值是多少」。
 *
 * 本機實測(Windows 11 + 內建音效卡):
 *   靜音    peak 0.00000
 *   播放中  peak 0.13195
 *   停止後  peak 0.00000
 * 門檻取在 0.002,離兩邊都有兩個數量級以上的距離。
 */

describe('解析取樣結果', () => {
  test('正常回應', () => {
    const s = w.parseAudioSample('{"ok":true,"peak":0.13195,"avg":0.0792,"samples":70,"state":1,"device":"{3.0.0}.{abc}"}');
    expect(s).toMatchObject({ ok: true, peak: 0.13195, samples: 70, heard: true });
    expect(s.device).toBe('{3.0.0}.{abc}');
  });

  test('靜音不算有聲音', () => {
    expect(w.parseAudioSample('{"ok":true,"peak":0,"avg":0,"samples":30}').heard).toBe(false);
  });

  test('讀不到音訊裝置:ok=false,而且不能被當成「靜音」', () => {
    // 這兩件事在報告裡的意義完全不同:「沒有聲音」是缺陷,「量不到」只是我們不知道。
    const s = w.parseAudioSample('{"ok":false,"why":"no-endpoint","hr":-2147023728}');
    expect(s.ok).toBe(false);
    expect(s.heard).toBe(false);
    expect(s.why).toBe('no-endpoint');
  });

  test('壞掉的輸出一律回 null(指令失敗 / 逾時 / 不是 JSON)', () => {
    for (const bad of ['', undefined, null, 'not json', '{', '[1,2]', '"text"', 'null']) {
      expect(w.parseAudioSample(bad)).toBeNull();
    }
  });

  test('缺欄位不會變成 NaN', () => {
    const s = w.parseAudioSample('{"ok":true}');
    expect(s.peak).toBe(0);
    expect(s.avg).toBe(0);
    expect(s.samples).toBe(0);
    expect(s.heard).toBe(false);
  });

  test('門檻:剛好在門檻上不算有聲音,超過才算', () => {
    const at = w.parseAudioSample(`{"ok":true,"peak":${w.AUDIO_ON_THRESHOLD}}`);
    const over = w.parseAudioSample(`{"ok":true,"peak":${w.AUDIO_ON_THRESHOLD * 2}}`);
    expect(at.heard).toBe(false);
    expect(over.heard).toBe(true);
  });
});

describe('音效快照(沿用 Android 的 schema,讓前端的音效分頁直接可用)', () => {
  const AT = 1_700_000_000_000;

  test('有聲音 → 一筆 started 播放器(前端據此亮「♪ 播放中」)', () => {
    const s = w.parseAudioSample('{"ok":true,"peak":0.2,"avg":0.1,"samples":25,"device":"d"}');
    const snap = w.audioSnapshot(7, s, AT);
    expect(snap.step).toBe(7);
    expect(snap.at).toBe(AT);
    expect(snap.players).toHaveLength(1);
    expect(snap.players[0]).toMatchObject({ state: 'started', type: 'WASAPI' });
    expect(snap.outputs[0]).toMatchObject({ standby: false, active: 1 });
    expect(snap.playbackRaw).toContain('peak=0.20000');
  });

  test('靜音 → 沒有播放器,輸出標成 standby', () => {
    const s = w.parseAudioSample('{"ok":true,"peak":0,"avg":0,"samples":25,"device":"d"}');
    const snap = w.audioSnapshot(1, s, AT);
    expect(snap.players).toEqual([]);
    expect(snap.outputs[0]).toMatchObject({ standby: true, active: 0 });
  });

  test('讀不到裝置 → 連 outputs 都不給(不要讓前端顯示成「有裝置但待機」)', () => {
    const s = w.parseAudioSample('{"ok":false,"why":"no-endpoint"}');
    const snap = w.audioSnapshot(2, s, AT);
    expect(snap.players).toEqual([]);
    expect(snap.outputs).toEqual([]);
    expect(snap.playbackRaw).toContain('no-endpoint');
  });

  test('取樣完全失敗(沒有回應)也要產出一份可讀的快照', () => {
    const snap = w.audioSnapshot(3, null, AT);
    expect(snap.step).toBe(3);
    expect(snap.players).toEqual([]);
    expect(snap.playbackRaw).toContain('failed');
  });
});

describe('講給模型聽的那句話', () => {
  test('沒取樣就什麼都不加(Android / Device Farm 完全不受影響)', () => {
    expect(w.soundNote(null)).toBe('');
  });

  test('有聲音時帶上峰值', () => {
    const s = w.parseAudioSample('{"ok":true,"peak":0.2}');
    expect(w.soundNote(s)).toContain('有聲音輸出');
    expect(w.soundNote(s)).toContain('0.200');
  });

  test('靜音時要點出「本來該有音效就是缺陷」', () => {
    const s = w.parseAudioSample('{"ok":true,"peak":0}');
    expect(w.soundNote(s)).toContain('沒有聲音輸出');
    expect(w.soundNote(s)).toContain('缺陷');
  });

  test('讀不到音量時要叫模型不要宣稱聽到或沒聽到', () => {
    // 最糟的情況是模型把「量不到」寫成「沒有音效」,那是憑空生出一個缺陷。
    const s = w.parseAudioSample('{"ok":false,"why":"no-endpoint"}');
    const note = w.soundNote(s);
    expect(note).toContain('讀不到');
    expect(note).toContain('no-endpoint');
    expect(note).not.toContain('缺陷');
  });
});

/**
 * 音訊鏈自我檢查。
 *
 * 這是整個功能能不能宣稱可用的關鍵:讀到「有輸出端點」不等於「遊戲的聲音會進到那個
 * 端點」。少了這個檢查,一整場 peak=0 有兩種完全不同的解釋 —— 遊戲真的沒出聲(是個
 * 發現),或音訊鏈根本不通(量測沒有意義)。
 *
 * 失敗時的處理刻意是「停用聲音判斷」而不是「照常回報靜音」:量不準的靜音會被模型寫成
 * 「沒有音效(缺陷)」,那是憑空生出一個缺陷報告;少一項資訊只是少一項。
 *
 * 本機實測(Windows 11):播測試音 peak 0.36618 → 停止後 0.00000。
 */
describe('音訊鏈自我檢查', () => {
  test('測試音聽得到 → 鏈路通', () => {
    const r = w.parseAudioSelfTest(JSON.stringify({
      during: { ok: true, peak: 0.36618, avg: 0.272, samples: 35, device: 'd' },
      after: { ok: true, peak: 0, avg: 0, samples: 20, device: 'd' },
    }));
    expect(r.chainOk).toBe(true);
    expect(r.peak).toBeCloseTo(0.36618, 5);
    expect(r.quiet).toBe(0);
    expect(r.why).toBe('');
  });

  test('有端點但測試音量不到 → 鏈路不通(這正是要抓的情形)', () => {
    const r = w.parseAudioSelfTest(JSON.stringify({
      during: { ok: true, peak: 0, avg: 0, samples: 35, device: 'd' },
      after: { ok: true, peak: 0, avg: 0, samples: 20, device: 'd' },
    }));
    expect(r.chainOk).toBe(false);
    expect(r.why).toBe('test-tone-not-heard');
  });

  test('沒有音訊裝置 → 鏈路不通,而且保留原因', () => {
    const r = w.parseAudioSelfTest(JSON.stringify({
      during: { ok: false, why: 'no-endpoint' },
      after: { ok: false, why: 'no-endpoint' },
    }));
    expect(r.chainOk).toBe(false);
    expect(r.why).toBe('no-endpoint');
  });

  test('播放本身就失敗(例如沒有音訊服務)', () => {
    const r = w.parseAudioSelfTest(JSON.stringify({ error: 'No audio device is available' }));
    expect(r.chainOk).toBe(false);
    expect(r.why).toContain('No audio device');
  });

  test('壞輸出一律是「不通」,不要當成通過', () => {
    for (const bad of ['', undefined, null, 'not json', '{', '[1]', '{}']) {
      const r = w.parseAudioSelfTest(bad);
      expect(r.chainOk).toBe(false);
      expect(r.why).toBeTruthy();
    }
  });
});
