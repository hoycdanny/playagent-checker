/** 型別宣告:agent/audioEvidence.mjs。 */

/**
 * 可主張的結論強度。
 *   audible —— 量到聲音:可主張有音訊輸出,且知道出現在哪些時刻
 *   silent  —— 擷取鏈已驗但整段無聲:可主張無音訊輸出(缺陷線索)
 *   unknown —— 擷取鏈未驗且整段無聲:分不出是遊戲沒聲音還是沒抓到,不下結論
 */
export type AudioVerdict = 'audible' | 'silent' | 'unknown';

/** 音訊證據摘要(寫進 report.audioEvidence)。 */
export interface AudioEvidence {
  source: 'recording' | 'host_meter';
  /** 是否擷取到音訊軌(錄影路徑才有軌;主機音量表只有讀數)。 */
  trackCaptured: boolean;
  /**
   * 擷取鏈是否確定可用。
   * 這一欄決定「整段無聲」能不能當結論 —— 未驗證的靜音不可寫成「無音效」。
   */
  chainVerified: boolean;
  /** 量到聲音的時間(或步數)佔比。 */
  audibleRatio: number;
  verdict: AudioVerdict;
  /** verdict 為 unknown 時說明為什麼不下結論。 */
  unknownReason?: string;
  thresholdDb?: number;
  durationSec?: number;
  audibleSec?: number;
  longestSilenceSec?: number;
  peakRmsDb?: number | null;
  segments?: number;
  stepsSampled?: number;
  stepsHeard?: number;
  peakLinear?: number;
}

/** 判定「有聲音」的 RMS 門檻(dB);保守的地板值,不是音量大小的判斷。 */
export const AUDIBLE_RMS_DB: number;

/** 從錄影的 RMS 時間序列彙整;沒有任何錄影段回 null。 */
export function fromRecording(
  chunks: Array<{ name?: string; t?: number; dur?: number; rms?: number[]; bytes?: number }> | null | undefined,
  opts?: { dt?: number; thresholdDb?: number },
): AudioEvidence | null;

/** 從主機音量表的逐步取樣彙整;完全沒量到回 null。 */
export function fromHostMeter(
  samples: Array<{ ok?: boolean; heard?: boolean; peak?: number } | null> | null | undefined,
  opts?: { chainVerified?: boolean },
): AudioEvidence | null;

/** 給報告看的一行摘要;沒有證據回 null。 */
export function describeAudio(ev: AudioEvidence | null | undefined): string | null;
