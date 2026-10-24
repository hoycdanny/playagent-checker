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
