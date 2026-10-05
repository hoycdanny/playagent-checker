import type { RLang } from '../report/reportText.ts';
import { SILENT_DB, type WindowSound } from './audioLevels.ts';

/** 執行軌跡每步的音效小波形:有聲 / 突發音效(♪)/ 靜音 / 未錄到(錄音空檔)。 */
export function StepSound({ s, lang }: { s: WindowSound; lang: RLang }) {
  const zh = lang === 'zh';
  if (!s.covered) {
    return <span className="dsound is-none" title={zh ? '這一步落在錄音空檔,沒有錄到聲音' : 'Not recorded (gap between sound clips)'}>—</span>;
  }
  const silent = (s.peakDb ?? -120) <= SILENT_DB;
  const label = silent
    ? zh ? '靜音' : 'Silent'
    : s.onsets > 0
      ? zh ? `${s.onsets} 個音效` : `${s.onsets} sound${s.onsets > 1 ? 's' : ''}`
      : zh ? '有聲音' : 'Sound';
  const title = [
    zh ? `最大音量 ${s.peakDb} dB` : `Peak ${s.peakDb} dB`,
    s.onsets > 0 ? (zh ? `偵測到 ${s.onsets} 個突發音效(如金幣、按鈕音)` : `${s.onsets} sound effect(s) detected`) : '',
    s.coverage < 0.95 ? (zh ? `錄到 ${Math.round(s.coverage * 100)}%` : `${Math.round(s.coverage * 100)}% recorded`) : '',
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
