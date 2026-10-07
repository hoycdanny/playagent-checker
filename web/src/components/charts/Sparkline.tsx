import { useId, useMemo } from 'react';
import './Sparkline.css';

/**
 * Sparkline —— 極簡走勢圖(純 SVG,無外部相依,與 StackedBarChart 同一套作法)。
 *
 * 用途:在卡片／表格列裡放一條「這個應用近 N 天的花費走勢」。
 * 刻意不畫座標軸與刻度 —— 這種尺寸讀不出精確數值,它要回答的是
 * 「在漲還是在跌、有沒有突然暴衝」。精確數字由旁邊的 KPI 文字給。
 *
 * 無障礙:圖形本身 aria-hidden,旁邊給一段隱藏文字描述(起/迄/最大值),
 * 讓螢幕報讀不必去解析 path。
 */
export default function Sparkline({
  values,
  color = '#2f6df6',
  width = 120,
  height = 32,
  format,
  ariaLabel,
  fluid = false,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  /** 把數值轉成可讀文字(給隱藏的無障礙描述用)。 */
  format?: (v: number) => string;
  ariaLabel: string;
  /** 撐滿容器寬度(width 仍作為 viewBox 的座標基準)。 */
  fluid?: boolean;
}) {
  const gid = useId().replace(/:/g, '');
  const n = values.length;
  const max = Math.max(0, ...values);

  const { line, area, lastY } = useMemo(() => {
    if (n === 0) return { line: '', area: '', lastY: height / 2 };
    const padY = 2;
    const plotH = height - padY * 2;
    // 只有一個點時畫一條水平線(x 間距為 0 會變成不可見的點)。
    const dx = n > 1 ? width / (n - 1) : 0;
    const y = (v: number) => padY + plotH - (max > 0 ? (v / max) * plotH : 0);
    const pts = values.map((v, i) => `${(dx * i).toFixed(2)},${y(v).toFixed(2)}`);
    const l = n === 1 ? `M0,${y(values[0]!).toFixed(2)} L${width},${y(values[0]!).toFixed(2)}` : `M${pts.join(' L')}`;
    const a = `${l} L${width},${height} L0,${height} Z`;
    return { line: l, area: a, lastY: y(values[n - 1]!) };
  }, [values, n, max, width, height]);

  const fmt = format ?? ((v: number) => String(v));
  const last = n > 0 ? values[n - 1]! : 0;

  // fluid:寬度交給 CSS(viewBox 仍用 width 當座標基準),高度固定。
  const box = fluid ? { width: '100%', height } : { width, height };
  const svgSize = fluid
    ? { preserveAspectRatio: 'none' as const, height }
    : { width, height };

  if (n === 0 || max <= 0) {
    // 全為 0(例如這個應用這段期間沒花錢)→ 畫一條底線,不要留一塊空白。
    return (
      <span className="spark spark--empty" style={box} aria-hidden="true">
        <svg viewBox={`0 0 ${width} ${height}`} {...svgSize}>
          <line x1="0" x2={width} y1={height - 2} y2={height - 2} />
        </svg>
      </span>
    );
  }

  return (
    <span className="spark" style={box}>
      <svg viewBox={`0 0 ${width} ${height}`} {...svgSize} aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`spark-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#spark-${gid})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
        {/* 最後一點加圓點:視線容易找到「現在」在哪 */}
        <circle cx={width} cy={lastY} r="2.2" fill={color} />
      </svg>
      <span className="visually-hidden">
        {ariaLabel}:{fmt(last)}({fmt(max)} max)
      </span>
    </span>
  );
}
