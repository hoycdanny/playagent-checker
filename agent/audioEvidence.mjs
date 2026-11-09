/**
 * 音訊證據的彙整 —— 從已經收集到的量測,算出報告可以主張什麼。
 *
 * 平台本來就收了兩種音訊量測,但都沒有進 report.json,所以報告一直把音訊範疇
 * 標成「未擷取音訊軌」。那是低報:證據收了卻沒送到判定端,跟高估一樣是準確性問題。
 *
 * 兩個來源:
 *   recording  —— Android 的整場錄影(含聲音),ffmpeg 算每 0.1 秒 RMS(dB)
 *   host_meter —— Windows 主機每步一次的輸出音量峰值(WASAPI)
 *
 * **核心紀律:量到聲音是強證據,量不到不是。**
 *   量到聲音 → 可以確定擷取鏈是通的,而且知道聲音出現在哪些時刻。
 *   整段都沒量到 → 兩種可能完全不同的原因:遊戲真的沒出聲(是缺陷),
 *   或擷取鏈沒抓到音訊(是工具問題)。Android 的錄影路徑沒有自我檢查可以分辨,
 *   所以這種情況一律回報「未能判定」,不可寫成「無音效」—— 那會憑空生出一個缺陷。
 *   (Windows 那條有 audioSelfTest 驗過鏈路,所以它的靜音是可信的;來源不同,
 *   結論強度也不同,因此 chainVerified 要分開記。)
 *
 * 而且就算量到了聲音,也只能主張「有聲音、在這些時刻」。
 * 「音效是否正確」需要參考音軌可對照,平台沒有 —— 跟語系文案是同一種缺口。
 */

/**
 * 判定「有聲音」的 RMS 門檻(dB)。
 *
 * 取 -50 是保守的地板值:目的是把「數位靜音與極低底噪」跟「真的有聲音」分開,
 * 不是在判斷音量夠不夠大。遊戲正常音量的 RMS 大致在 -30 ~ -15 dBFS,
 * 而 ffmpeg 對無聲段回 -inf(mediaAudio 把它夾成 -120)。
 */
export const AUDIBLE_RMS_DB = -50;

/**
 * 從錄影的 RMS 時間序列彙整音訊證據。
 *
 * @param chunks mediaAudio 的 doc.chunks:{ name, t, dur, rms[], bytes }
 * @param opts.dt         每個 RMS 取樣代表幾秒(mediaAudio 用 0.1)
 * @param opts.thresholdDb 有聲門檻
 * @returns {object|null} 沒有任何錄影段時回 null(等同沒有這項證據)
 */
export function fromRecording(chunks, { dt = 0.1, thresholdDb = AUDIBLE_RMS_DB } = {}) {
  const list = Array.isArray(chunks) ? chunks.filter((c) => c && Array.isArray(c.rms)) : [];
  if (list.length === 0) return null;

  let samples = 0;
  let audible = 0;
  let longestSilentRun = 0;
  let run = 0;
  let peakDb = -Infinity;

  // 段與段之間不連續(中間重開過錄影),所以最長靜音只在同一段內計算 ——
  // 跨段累計會把「錄影換段的空隙」算成遊戲靜音。
  for (const c of list) {
    run = 0;
    for (const v of c.rms) {
      const db = Number(v);
      if (!Number.isFinite(db)) continue;
      samples += 1;
      if (db > peakDb) peakDb = db;
      if (db > thresholdDb) {
        audible += 1;
        run = 0;
      } else {
        run += 1;
        if (run > longestSilentRun) longestSilentRun = run;
      }
    }
  }

  if (samples === 0) return null;
  const audibleRatio = audible / samples;
  return {
    source: 'recording',
    trackCaptured: true,
    // 擷取鏈是否確定可用:量到過聲音才算確定。這一欄決定「靜音」能不能當結論。
    chainVerified: audible > 0,
    durationSec: round1(samples * dt),
    audibleRatio: round3(audibleRatio),
    audibleSec: round1(audible * dt),
    longestSilenceSec: round1(longestSilentRun * dt),
    peakRmsDb: Number.isFinite(peakDb) ? round1(peakDb) : null,
    thresholdDb,
    segments: list.length,
    ...verdictOf(audible > 0, audibleRatio),
  };
}

/**
 * 從主機音量表的逐步取樣彙整(Windows)。
 *
 * @param samples 每步一筆 parseAudioSample() 的結果(null = 該步沒量到)
 * @param opts.chainVerified audioSelfTest 是否驗過擷取鏈
 */
export function fromHostMeter(samples, { chainVerified = false } = {}) {
  const list = Array.isArray(samples) ? samples : [];
  const measured = list.filter((s) => s && s.ok === true);
  if (measured.length === 0) return null;
  const heard = measured.filter((s) => s.heard === true).length;
  const ratio = heard / measured.length;
  const peak = measured.reduce((m, s) => (Number.isFinite(s.peak) && s.peak > m ? s.peak : m), 0);
  return {
    source: 'host_meter',
    trackCaptured: false,
    // 自我檢查通過,或實際聽到過聲音,都算擷取鏈確定可用。
    chainVerified: Boolean(chainVerified) || heard > 0,
    stepsSampled: measured.length,
    stepsHeard: heard,
    audibleRatio: round3(ratio),
    peakLinear: round3(peak),
    ...verdictOf(Boolean(chainVerified) || heard > 0, ratio),
  };
}

/**
 * 從證據得出可主張的結論。
 *
 * 三種結論,強度完全不同:
 *   audible    量到聲音 —— 可主張「有音訊輸出,且知道出現在哪些時刻」
 *   silent     擷取鏈已驗但整段無聲 —— 可主張「無音訊輸出」(是個缺陷線索)
 *   unknown    擷取鏈未驗且整段無聲 —— 分不出是遊戲沒聲音還是沒抓到,不得下任何結論
 */
function verdictOf(chainVerified, audibleRatio) {
  if (audibleRatio > 0) return { verdict: 'audible' };
  if (chainVerified) return { verdict: 'silent' };
  return {
    verdict: 'unknown',
    unknownReason: '整段都沒量到聲音,但擷取鏈未經驗證;分不出是遊戲沒有音訊輸出還是擷取沒抓到,因此不下結論',
  };
}

/** 給報告看的一行摘要;沒有證據回 null。 */
export function describeAudio(ev) {
  if (!ev) return null;
  const where = ev.source === 'recording' ? '整場錄影' : '主機音量表逐步取樣';
  if (ev.verdict === 'audible') {
    const pct = Math.round(ev.audibleRatio * 100);
    return ev.source === 'recording'
      ? `${where}:有音訊輸出,${pct}% 的時間量到聲音,最長連續無聲 ${ev.longestSilenceSec} 秒`
      : `${where}:有音訊輸出,${ev.stepsHeard}/${ev.stepsSampled} 步量到聲音`;
  }
  if (ev.verdict === 'silent') return `${where}:擷取鏈已驗證,但整段沒有量到任何音訊輸出`;
  return `${where}:整段沒有量到聲音,且擷取鏈未經驗證,無法判定遊戲是否有音訊輸出`;
}

const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;
