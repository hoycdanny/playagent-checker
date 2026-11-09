import { describe, expect, test } from 'vitest';
import { AUDIBLE_RMS_DB, describeAudio, fromHostMeter, fromRecording } from '../../agent/audioEvidence.mjs';
import { buildStructuredReport } from '../lambda/api/report/engine.js';
import { capabilityOf } from '../lambda/api/report/qaCapability.js';

/**
 * 音訊證據。
 *
 * 這組測試守的核心是一條不對稱的規則:**量到聲音是強證據,量不到不是。**
 * 擷取鏈未驗證的整段無聲分不出是遊戲沒聲音還是沒抓到 —— 把它當成「無音效」
 * 會憑空生出一個缺陷報告,那比少一項資訊糟得多。
 */

type RawStep = Record<string, unknown>;
const st = (i: number, screen: string, action: string, extra: RawStep = {}): RawStep => ({ index: i, screen, action, ...extra });
/**
 * 預設用 rhythm(音樂節奏)類型:它的樣板會選進 audio 範疇,
 * 所以「選定了卻沒證據」這條路徑測得到。slot 不選 audio,那是另一條路徑。
 */
const report = (audioEvidence?: unknown, genre = 'rhythm') =>
  buildStructuredReport({
    raw: {
      state: 'pass', task: '探索遊戲', steps: [st(0, '大廳', 'tap', { x: 5, y: 5 }), st(1, '選單', 'done')],
      ...(audioEvidence ? { audioEvidence } : {}),
    },
    job: { jobId: 'job-test' },
    app: { genre },
  } as never);

/** 每 0.1 秒一筆 RMS;dB 值越高越大聲,-120 是 ffmpeg 的無聲。 */
const chunk = (rms: number[], extra: Record<string, unknown> = {}) => ({ name: 'rec-0.mp4', t: 0, dur: rms.length / 10, rms, ...extra });

describe('fromRecording:從錄影的音量序列彙整', () => {
  test('量到聲音 → audible,並算出有聲佔比與最長連續無聲', () => {
    // 10 筆取樣 = 1 秒;其中 4 筆有聲,最長連續無聲 4 筆 = 0.4 秒
    const ev = fromRecording([chunk([-20, -18, -120, -120, -120, -120, -22, -25, -120, -120])])!;
    expect(ev.verdict).toBe('audible');
    expect(ev.source).toBe('recording');
    expect(ev.trackCaptured).toBe(true);
    expect(ev.audibleRatio).toBe(0.4);
    expect(ev.durationSec).toBe(1);
    expect(ev.longestSilenceSec).toBe(0.4);
    expect(ev.peakRmsDb).toBe(-18);
  });

  test('量到過聲音就代表擷取鏈可用', () => {
    const ev = fromRecording([chunk([-120, -120, -30])])!;
    expect(ev.chainVerified).toBe(true);
  });

  test('整段無聲且擷取鏈未驗證 → unknown,不可當成「無音效」', () => {
    const ev = fromRecording([chunk([-120, -120, -120, -120])])!;
    expect(ev.verdict).toBe('unknown');
    expect(ev.chainVerified).toBe(false);
    expect(ev.audibleRatio).toBe(0);
    expect(ev.unknownReason, '必須說明為什麼不下結論').toBeTruthy();
    expect(ev.unknownReason).toContain('分不出');
  });

  test('門檻是靜音/有聲的地板值,不是音量大小的判斷', () => {
    expect(AUDIBLE_RMS_DB).toBe(-50);
    // 剛好在門檻上不算有聲,略高才算
    expect(fromRecording([chunk([-50, -50])])!.verdict).toBe('unknown');
    expect(fromRecording([chunk([-49, -120])])!.verdict).toBe('audible');
  });

  test('最長無聲只在同一段內計算(跨段的空隙不是遊戲靜音)', () => {
    // 兩段各自結尾 2 筆無聲;跨段累計會算成 0.4 秒,但實際上段與段之間不連續
    const ev = fromRecording([
      chunk([-20, -120, -120]),
      chunk([-120, -120, -20], { name: 'rec-1.mp4' }),
    ])!;
    expect(ev.segments).toBe(2);
    expect(ev.longestSilenceSec).toBe(0.2);
  });

  test('沒有錄影段、或段裡沒有音量資料 → null(等同沒有這項證據)', () => {
    expect(fromRecording([])).toBeNull();
    expect(fromRecording(null)).toBeNull();
    expect(fromRecording(undefined)).toBeNull();
    expect(fromRecording([{ name: 'rec-0.mp4' }])).toBeNull();
    expect(fromRecording([chunk([])])).toBeNull();
  });
});

describe('fromHostMeter:從主機音量表的逐步取樣彙整', () => {
  const s = (ok: boolean, heard: boolean, peak = 0) => ({ ok, heard, peak });

  test('聽到聲音 → audible,記下聽到的步數', () => {
    const ev = fromHostMeter([s(true, true, 0.3), s(true, false), s(true, true, 0.1)])!;
    expect(ev.verdict).toBe('audible');
    expect(ev.source).toBe('host_meter');
    expect(ev.stepsSampled).toBe(3);
    expect(ev.stepsHeard).toBe(2);
    expect(ev.peakLinear).toBe(0.3);
    // 主機音量表只有讀數,沒有音訊軌
    expect(ev.trackCaptured).toBe(false);
  });

  test('自我檢查通過且整段無聲 → silent(這個靜音可信,是缺陷線索)', () => {
    const ev = fromHostMeter([s(true, false), s(true, false)], { chainVerified: true })!;
    expect(ev.verdict).toBe('silent');
    expect(ev.chainVerified).toBe(true);
  });

  test('自我檢查未通過且整段無聲 → unknown(不可寫成缺陷)', () => {
    const ev = fromHostMeter([s(true, false), s(true, false)], { chainVerified: false })!;
    expect(ev.verdict).toBe('unknown');
  });

  test('量測本身失敗的步數不計入(ok=false 不是「沒聲音」)', () => {
    const ev = fromHostMeter([
      { ok: false, heard: false }, { ok: false, heard: false }, s(true, true, 0.2),
    ])!;
    expect(ev.stepsSampled).toBe(1);
    expect(ev.audibleRatio).toBe(1);
  });

  test('完全沒量到 → null', () => {
    expect(fromHostMeter([])).toBeNull();
    expect(fromHostMeter([{ ok: false, heard: false }])).toBeNull();
    expect(fromHostMeter(null)).toBeNull();
  });
});

describe('describeAudio:摘要要講出結論強度', () => {
  test('有聲音時帶出佔比', () => {
    const text = describeAudio(fromRecording([chunk([-20, -120])]))!;
    expect(text).toContain('有音訊輸出');
    expect(text).toContain('50%');
  });

  test('無定論時明說無法判定,不說「沒有音效」', () => {
    const text = describeAudio(fromRecording([chunk([-120, -120])]))!;
    expect(text).toContain('無法判定');
    expect(text).not.toContain('沒有音效');
  });

  test('沒有證據回 null', () => {
    expect(describeAudio(null)).toBeNull();
  });
});

describe('接進報告:音訊範疇不再寫死做不到', () => {
  const scopeOf = (r: ReturnType<typeof report>) => r.scope.find((s) => s.id === 'audio')!;

  test('量到聲音 → 範疇算已執行', () => {
    const sc = scopeOf(report(fromRecording([chunk([-20, -22, -120])])));
    expect(sc.status).toBe('executed');
    expect(sc.detectable).toBe(true);
  });

  test('擷取鏈已驗的整段無聲也算已執行(那是個結論,不是沒測)', () => {
    const ev = fromHostMeter([{ ok: true, heard: false }], { chainVerified: true });
    expect(scopeOf(report(ev)).status).toBe('executed');
  });

  test('無定論 → 未執行,但理由是「本次沒量到」而不是「平台做不到」', () => {
    const sc = scopeOf(report(fromRecording([chunk([-120, -120])])));
    expect(sc.status).toBe('not_executed');
    // 關鍵:detectable 必須是 true —— 裝置後端量得到,說它偵測不到會把一個
    // 可修的設定問題寫成永久限制。
    expect(sc.detectable).toBe(true);
    expect(sc.reason!.zh).not.toContain('平台限制');
    expect(sc.reason!.zh).toContain('無法下結論');
  });

  test('完全沒有音訊證據 → 未執行,理由點明哪些後端沒有擷取', () => {
    const sc = scopeOf(report());
    expect(sc.status).toBe('not_executed');
    expect(sc.detectable).toBe(true);
    expect(sc.reason!.zh).toContain('沒有任何音訊量測');
    expect(sc.reason!.zh).toContain('網頁與容器後端');
  });

  test('樣板根本沒選音訊時,理由是「未選定」而不是「沒量到」', () => {
    // slot 的樣板不測音訊。這時說「本次沒有音訊量測」會把讀者引去查一個
    // 不存在的問題 —— 真正的理由是這個類型不判定音訊。
    const sc = scopeOf(report(undefined, 'slot'));
    expect(sc.status).toBe('not_applicable');
    expect(sc.reason!.zh).toContain('未選定');
    expect(sc.reason!.zh).not.toContain('沒有任何音訊量測');
  });
});

describe('接進報告:適用邊界要收斂主張', () => {
  const noteOf = (audioEvidence?: unknown) => {
    const a = report(audioEvidence).claimScope.notVaried.find((n) => n.id === 'audio');
    expect(a, '音訊必須永遠表態').toBeDefined();
    return a!.note;
  };

  test('量到聲音也不得主張音效正確(沒有參考音軌可對照)', () => {
    const note = noteOf(fromRecording([chunk([-20, -120])]));
    expect(note.zh).toContain('出現時機');
    expect(note.zh).toContain('沒有參考音軌');
    expect(note.zh).toContain('不得主張音效內容正確');
  });

  test('無定論時兩個方向都不准主張', () => {
    const note = noteOf(fromRecording([chunk([-120, -120])]));
    // 既不能說遊戲沒音效,也不能說音效正常
    expect(note.zh).toContain('不得主張遊戲無音效');
    expect(note.zh).toContain('也不得主張音效正常');
  });

  test('沒有量測時什麼都不准主張', () => {
    expect(noteOf().zh).toContain('沒有音訊量測');
  });
});

describe('能力宣告:M08 從「結構性做不到」改為部分可行', () => {
  test('改成 partial,並寫出真的做得到什麼', () => {
    const c = capabilityOf('M08')!;
    // 先前標 not_supported 且寫「音訊軌未擷取」—— 那是低報,證據其實收了
    expect(c.level).toBe('partial');
    expect(c.covers.zh).toContain('含聲音');
    expect(c.covers.zh).toContain('出現時機');
  });

  test('缺口仍要寫清楚:沒有參考音軌、沒有核定文案、兩個後端沒有擷取', () => {
    const c = capabilityOf('M08')!;
    expect(c.gap!.zh).toContain('參考音軌');
    expect(c.gap!.zh).toContain('核定文案');
    expect(c.gap!.zh).toContain('網頁與容器後端');
    // 量不到不等於沒聲音,這條紀律要寫在宣告裡
    expect(c.gap!.zh).toContain('分不出');
  });
});
