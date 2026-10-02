import './RtpChart.css';

export interface RtpSeriesPoint {
  n: number;
  rtp: number;
}

export interface RtpStats {
  sampleCount: number;
  totalBet: number;
  totalWin: number;
  rtpPercent: number;
  series: RtpSeriesPoint[];
}

/**
 * RTP(Return To Player)折線圖 —— 顯示累積 RTP 百分比隨取樣次數(spin 數)收斂的趨勢。
 * 手刻輕量 SVG(對齊 NavGraph 的做法),不額外引入圖表函式庫。
 */
export function RtpChart({ stats }: { stats: RtpStats }) {
  const { series, rtpPercent, totalBet, totalWin, sampleCount } = stats;
  if (series.length === 0) return null;

  const width = 640;
  const height = 240;
  const padL = 48;
  const padB = 28;
  const padT = 16;
  const padR = 16;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const rtpValues = series.map((p) => p.rtp);
  const yMin = Math.min(80, Math.floor(Math.min(...rtpValues) / 10) * 10);
  const yMax = Math.max(120, Math.ceil(Math.max(...rtpValues) / 10) * 10);
  const xMax = series[series.length - 1]!.n;

  const xOf = (n: number) => padL + (xMax <= 1 ? 0 : ((n - 1) / (xMax - 1)) * plotW);
  const yOf = (rtp: number) => padT + plotH - ((rtp - yMin) / (yMax - yMin)) * plotH;

  const pathD = series
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(p.n).toFixed(1)} ${yOf(p.rtp).toFixed(1)}`)
    .join(' ');

  // 100% 參考線(理論平衡點)落在圖內才畫。
  const show100 = yMin <= 100 && 100 <= yMax;
  const y100 = yOf(100);

  // Y 軸刻度:每 10% 一條。
  const yTicks: number[] = [];
  for (let v = yMin; v <= yMax; v += 10) yTicks.push(v);

  return (
    <div className="rtpchart">
      <div className="rtpchart__summary">
        <div className="rtpchart__summary-item rtpchart__summary-item--main">
          <span className="rtpchart__summary-label">RTP</span>
          <span className="rtpchart__summary-value">{rtpPercent.toFixed(2)}%</span>
        </div>
        <div className="rtpchart__summary-item">
          <span className="rtpchart__summary-label">取樣次數</span>
          <span className="rtpchart__summary-value">{sampleCount.toLocaleString()}</span>
        </div>
        <div className="rtpchart__summary-item">
          <span className="rtpchart__summary-label">總下注</span>
          <span className="rtpchart__summary-value">{totalBet.toLocaleString()}</span>
        </div>
        <div className="rtpchart__summary-item">
          <span className="rtpchart__summary-label">總派彩</span>
          <span className="rtpchart__summary-value">{totalWin.toLocaleString()}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ maxWidth: width }} role="img" aria-label={`RTP 累積趨勢圖,目前 RTP ${rtpPercent.toFixed(2)}%`}>
        {/* Y 軸格線 + 刻度文字 */}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={padL} y1={yOf(v)} x2={width - padR} y2={yOf(v)} className="rtpchart__gridline" />
            <text x={padL - 8} y={yOf(v)} className="rtpchart__ytick" textAnchor="end" dominantBaseline="middle">
              {v}%
            </text>
          </g>
        ))}
        {/* 100% 參考線(理論平衡點) */}
        {show100 && (
          <line x1={padL} y1={y100} x2={width - padR} y2={y100} className="rtpchart__refline" />
        )}
        {/* RTP 累積趨勢線 */}
        <path d={pathD} className="rtpchart__line" fill="none" />
        {/* X 軸標籤 */}
        <text x={padL} y={height - 6} className="rtpchart__xtick">1</text>
        <text x={width - padR} y={height - 6} className="rtpchart__xtick" textAnchor="end">
          {xMax}
        </text>
        <text x={(padL + width - padR) / 2} y={height - 6} className="rtpchart__xtick" textAnchor="middle">
          取樣次數
        </text>
      </svg>
    </div>
  );
}
