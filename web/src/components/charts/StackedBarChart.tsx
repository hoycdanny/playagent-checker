import { useMemo, useState } from 'react';
import './StackedBarChart.css';

export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

/** 依序使用的系列色(深淺主題都可辨識;相鄰色相差大)。 */
export const SERIES_COLORS = ['#2f6df6', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#db2777', '#65a30d', '#7c3aed', '#0d9488', '#ea580c', '#4f46e5'];

/**
 * 堆疊直條圖(SVG,無外部相依)。x = 類別(如日期),每根柱由各系列堆疊。
 * 滑過/聚焦柱子顯示明細;另附隱藏資料表供螢幕報讀。
 */
export function StackedBarChart({
  categories,
  categoryLabel,
  series,
  values,
  format,
  ariaLabel,
  height = 260,
  emptyText,
}: {
  categories: string[];
  /** x 軸顯示文字(預設原值)。 */
  categoryLabel?: (c: string) => string;
  series: StackSeries[];
  /** values[categoryIndex][seriesKey] */
  values: Array<Record<string, number>>;
  format: (v: number) => string;
  ariaLabel: string;
  height?: number;
  emptyText?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = useMemo(
    () => values.map((row) => series.reduce((s, x) => s + (row[x.key] ?? 0), 0)),
    [values, series],
  );
  const max = Math.max(0, ...totals);
  const niceMax = useMemo(() => niceCeil(max), [max]);
  const W = Math.max(480, categories.length * 28 + 70);
  const H = height;
  const padL = 56, padR = 12, padT = 12, padB = 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const slot = plotW / Math.max(1, categories.length);
  const barW = Math.max(4, Math.min(36, slot * 0.66));
  const y = (v: number) => padT + plotH - (niceMax > 0 ? (v / niceMax) * plotH : 0);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * niceMax);
  const labelEvery = Math.max(1, Math.ceil(categories.length / 15));
  const lbl = categoryLabel ?? ((c: string) => c);

  if (max <= 0) {
    return <p className="sbc__empty">{emptyText ?? '—'}</p>;
  }

  return (
    <div className="sbc">
      <div className="sbc__scroll">
        <svg className="sbc__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} style={{ minWidth: Math.min(W, 1400) }}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line className="sbc__grid" x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} />
              <text className="sbc__tick" x={padL - 6} y={y(t) + 3} textAnchor="end">{format(t)}</text>
            </g>
          ))}
          {categories.map((c, i) => {
            const cx = padL + slot * i + slot / 2;
            let acc = 0;
            return (
              <g
                key={c}
                className={`sbc__col ${hover === i ? 'is-hover' : ''}`}
                tabIndex={totals[i]! > 0 ? 0 : -1}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${lbl(c)}: ${format(totals[i]!)}`}
              >
                <rect className="sbc__hit" x={padL + slot * i} y={padT} width={slot} height={plotH} />
                {series.map((s) => {
                  const v = values[i]?.[s.key] ?? 0;
                  if (v <= 0) return null;
                  const y1 = y(acc + v);
                  const h = y(acc) - y1;
                  acc += v;
                  return <rect key={s.key} x={cx - barW / 2} y={y1} width={barW} height={Math.max(1, h)} fill={s.color} rx={1.5} />;
                })}
                {i % labelEvery === 0 && (
                  <text className="sbc__xlabel" x={cx} y={H - padB + 16} textAnchor="middle">{lbl(c)}</text>
                )}
              </g>
            );
          })}
          <line className="sbc__axis" x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} />
        </svg>
      </div>

      <div className="sbc__tip" aria-live="polite">
        {hover !== null ? (
          <>
            <strong>{lbl(categories[hover]!)}</strong>
            <span className="sbc__tip-total">{format(totals[hover]!)}</span>
            {series
              .map((s) => ({ s, v: values[hover]?.[s.key] ?? 0 }))
              .filter((x) => x.v > 0)
              .sort((a, b) => b.v - a.v)
              .map(({ s, v }) => (
                <span key={s.key} className="sbc__tip-item">
                  <span className="sbc__swatch" style={{ background: s.color }} aria-hidden="true" />
                  {s.label} {format(v)}
                </span>
              ))}
          </>
        ) : (
          <span className="sbc__tip-hint">↑</span>
        )}
      </div>

      <ul className="sbc__legend">
        {series.map((s) => (
          <li key={s.key}><span className="sbc__swatch" style={{ background: s.color }} aria-hidden="true" />{s.label}</li>
        ))}
      </ul>

      <table className="visually-hidden">
        <caption>{ariaLabel}</caption>
        <thead><tr><th scope="col">—</th>{series.map((s) => <th key={s.key} scope="col">{s.label}</th>)}</tr></thead>
        <tbody>
          {categories.map((c, i) => (
            <tr key={c}><th scope="row">{lbl(c)}</th>{series.map((s) => <td key={s.key}>{format(values[i]?.[s.key] ?? 0)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 取「好看」的刻度上限(1/2/2.5/5 × 10^n)。 */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
