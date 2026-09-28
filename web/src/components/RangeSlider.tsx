import { useId } from 'react';
import './RangeSlider.css';

/**
 * 雙把手範圍滑桿:兩個重疊的 <input type="range"> 組成 [min, max] 區間。
 * - 值受控於 value=[lo, hi];拖動時透過 onChange 回傳夾在 [min,max] 內的新區間。
 * - lo 不會超過 hi、hi 不會低於 lo(至少相等)。
 * - format 用於顯示目前選取值(例如加上 $ 或單位)。
 */
export interface RangeSliderProps {
  min: number;
  max: number;
  step?: number;
  value: [number, number];
  onChange: (next: [number, number]) => void;
  /** 顯示用格式化(預設直接轉字串)。 */
  format?: (n: number) => string;
  /** 無障礙標籤(套用到兩個把手,分別加「最小/最大」後綴)。 */
  label?: string;
  minLabel?: string;
  maxLabel?: string;
}

export default function RangeSlider({
  min,
  max,
  step = 1,
  value,
  onChange,
  format = (n) => String(n),
  label,
  minLabel = '最小',
  maxLabel = '最大',
}: RangeSliderProps) {
  const id = useId();
  const [lo, hi] = value;
  // 上下界相同(清單只有一種值或無資料)時,滑桿無可拖動範圍:停用避免除以零。
  const disabled = max <= min;
  const span = max - min || 1;
  const loPct = ((lo - min) / span) * 100;
  const hiPct = ((hi - min) / span) * 100;

  return (
    <div className="rangeslider" data-disabled={disabled || undefined}>
      <div className="rangeslider__track" aria-hidden="true">
        <div
          className="rangeslider__fill"
          style={{ left: `${loPct}%`, right: `${100 - hiPct}%` }}
        />
      </div>
      <input
        type="range"
        className="rangeslider__input"
        min={min}
        max={max}
        step={step}
        value={lo}
        disabled={disabled}
        aria-label={label ? `${label} ${minLabel}` : minLabel}
        id={`${id}-lo`}
        onChange={(e) => {
          const next = Math.min(Number(e.target.value), hi);
          onChange([next, hi]);
        }}
      />
      <input
        type="range"
        className="rangeslider__input"
        min={min}
        max={max}
        step={step}
        value={hi}
        disabled={disabled}
        aria-label={label ? `${label} ${maxLabel}` : maxLabel}
        id={`${id}-hi`}
        onChange={(e) => {
          const next = Math.max(Number(e.target.value), lo);
          onChange([lo, next]);
        }}
      />
      <div className="rangeslider__values">
        <span>{format(lo)}</span>
        <span>{format(hi)}</span>
      </div>
    </div>
  );
}
