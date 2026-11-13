import { pr, type RLang } from '../report/reportText.ts';
import { SILENT_DB, type WindowSound } from './audioLevels.ts';

/** 執行軌跡每步的音效小波形:有聲 / 突發音效(♪)/ 靜音 / 未錄到(錄音空檔)。 */
export function StepSound({ s, lang }: { s: WindowSound; lang: RLang }) {
  if (!s.covered) {
    return <span className="dsound is-none" title={pr(['這一步落在錄音空檔,沒有錄到聲音', 'Not recorded (gap between sound clips)', '这一步落在录音空档,没有录到声音', 'このステップは録音の空白部分にあたり、音声が録音されていません', '이 단계는 녹음 공백에 해당하여 소리가 녹음되지 않았습니다'], lang)}>—</span>;
  }
  const silent = (s.peakDb ?? -120) <= SILENT_DB;
  const label = silent
    ? pr(['靜音', 'Silent', '静音', '無音', '무음'], lang)
    : s.onsets > 0
      ? pr([`${s.onsets} 個音效`, `${s.onsets} sound${s.onsets > 1 ? 's' : ''}`, `${s.onsets} 个音效`, `効果音 ${s.onsets} 件`, `효과음 ${s.onsets}개`], lang)
      : pr(['有聲音', 'Sound', '有声音', '音声あり', '소리 있음'], lang);
  const title = [
    pr([`最大音量 ${s.peakDb} dB`, `Peak ${s.peakDb} dB`, `最大音量 ${s.peakDb} dB`, `最大音量 ${s.peakDb} dB`, `최대 음량 ${s.peakDb} dB`], lang),
    s.onsets > 0 ? (pr([`偵測到 ${s.onsets} 個突發音效(如金幣、按鈕音)`, `${s.onsets} sound effect(s) detected`, `侦测到 ${s.onsets} 个突发音效(如金币、按钮音)`, `突発的な効果音を ${s.onsets} 件検出(コイン音、ボタン音など)`, `돌발 효과음 ${s.onsets}개 감지(동전 소리, 버튼 소리 등)`], lang)) : '',
    s.coverage < 0.95 ? (pr([`錄到 ${Math.round(s.coverage * 100)}%`, `${Math.round(s.coverage * 100)}% recorded`, `录到 ${Math.round(s.coverage * 100)}%`, `${Math.round(s.coverage * 100)}% を録音`, `${Math.round(s.coverage * 100)}% 녹음됨`], lang)) : '',
  ].filter(Boolean).join(' · ');
  return (
    <span className={`dsound ${silent ? 'is-silent' : s.onsets > 0 ? 'is-fx' : 'is-on'}`} title={title}>
      <svg width="34" height="12" viewBox="0 0 34 12" aria-hidden="true" focusable="false">
        {s.bars.map((b, i) => {
          const hgt = Math.max(1, Math.round(b * 12));
          return <rect key={i} x={i * (34 / s.bars.length)} y={12 - hgt} width={Math.max(1, 34 / s.bars.length - 0.6)} height={hgt} rx={0.5} />;
        })}
      </svg>
      <span>{s.onsets > 0 ? '♪ ' : ''}{label}</span>
    </span>
  );
}
