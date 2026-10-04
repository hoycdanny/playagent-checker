import type { ChartData } from './reportTypes.ts';

/**
 * 通用報告圖表(line / bar / donut)—— 圖表定義與資料由後端 ChartDefinition 決定,
 * 前端不寫死任何類型專屬圖。手刻輕量 SVG(對齊 RtpChart/NavGraph,不引入圖表庫)。
 * 每張圖都附「資料表」給螢幕報讀器,圖本身 aria-hidden。
 */

const PALETTE = ['var(--arch-blue)', 'var(--arch-orange)', 'var(--arch-green)', 'var(--arch-purple)', 'var(--arch-pink)', 'var(--arch-teal)', 'var(--arch-slate)'];
const SEMANTIC: Record<string, string> = {
  pass: 'var(--status-pass)',
  fail: 'var(--status-fail)',
  unclear: 'var(--status-cancelled)',
  win: 'var(--status-pass)',
  loss: 'var(--status-cancelled)',
  critical: 'var(--status-fail)',
  high: 'var(--status-error)',
  medium: 'var(--arch-purple)',
  low: 'var(--status-cancelled)',
  GAME_FAILURE: 'var(--status-fail)',
  AI_TEST_FAILURE: 'var(--arch-purple)',
  ENVIRONMENT: 'var(--status-error)',
  NEEDS_TRIAGE: 'var(--status-cancelled)',
};
const colorOf = (key: string, i: number) => SEMANTIC[key] ?? PALETTE[i % PALETTE.length]!;

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function ReportChart({ chart, lang, labelOf }: { chart: ChartData; lang: 'zh' | 'en'; labelOf?: (x: string) => string }) {
  const title = chart.title[lang];
  const lbl = (x: number | string) => (typeof x === 'string' && labelOf ? labelOf(x) : String(x));
  return (
    <figure className="rchart">
      <figcaption className="rchart__title">{title}</figcaption>
      {chart.type === 'line' && <LineSvg chart={chart} />}
      {chart.type === 'line' && chart.series.length > 1 && (
        <ul className="rchart__legend rchart__legend--row">
          {chart.series.map((s, i) => (
            <li key={i}><span className="rchart__swatch" style={{ background: colorOf('', i) }} />{s.name[lang]}</li>
          ))}
        </ul>
      )}
      {chart.type === 'bar' && <BarSvg chart={chart} lbl={lbl} />}
      {chart.type === 'donut' && <DonutSvg chart={chart} lbl={lbl} />}
      <table className="visually-hidden">
        <caption>{title}</caption>
        <tbody>
          {(chart.series.length > 1 ? chart.series : chart.series.slice(0, 1)).flatMap((s, si) =>
            s.points.map((p, i) => (
              <tr key={`${si}-${i}`}><th scope="row">{chart.series.length > 1 ? `${s.name[lang]} ` : ''}{lbl(p.x)}</th><td>{p.y}</td></tr>
            )),
          )}
        </tbody>
      </table>
    </figure>
  );
}

function LineSvg({ chart }: { chart: ChartData }) {
  const W = 420, H = 180, padL = 44, padR = 10, padT = 10, padB = 22;
  const all = chart.series.flatMap((s) => s.points).filter((p) => typeof p.x === 'number') as Array<{ x: number; y: number }>;
  if (all.length < 2) return null;
  const ys = all.map((p) => p.y).concat(chart.threshold !== undefined ? [chart.threshold] : []);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const xMin = Math.min(...all.map((p) => p.x)), xMax = Math.max(...all.map((p) => p.x));
  const xOf = (x: number) => padL + (xMax === xMin ? 0 : ((x - xMin) / (xMax - xMin)) * (W - padL - padR));
  const yOf = (y: number) => padT + (H - padT - padB) - ((y - yMin) / (yMax - yMin)) * (H - padT - padB);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rchart__svg" aria-hidden="true">
      {[yMin, (yMin + yMax) / 2, yMax].map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={yOf(v)} y2={yOf(v)} className="rchart__grid" />
          <text x={padL - 6} y={yOf(v)} className="rchart__tick" textAnchor="end" dominantBaseline="middle">{fmt(v)}</text>
        </g>
      ))}
      {chart.threshold !== undefined && (
        <line x1={padL} x2={W - padR} y1={yOf(chart.threshold)} y2={yOf(chart.threshold)} className="rchart__threshold" />
      )}
      {chart.series.map((s, si) => {
        const p = (s.points.filter((q) => typeof q.x === 'number') as Array<{ x: number; y: number }>).sort((a, b) => a.x - b.x);
        const d = p.map((q, i) => `${i ? 'L' : 'M'}${xOf(q.x).toFixed(1)} ${yOf(q.y).toFixed(1)}`).join(' ');
        return <path key={si} d={d} fill="none" stroke={colorOf('', si)} strokeWidth={2} />;
      })}
      <text x={padL} y={H - 4} className="rchart__tick">{fmt(xMin)}</text>
      <text x={W - padR} y={H - 4} className="rchart__tick" textAnchor="end">{fmt(xMax)}</text>
    </svg>
  );
}

function BarSvg({ chart, lbl }: { chart: ChartData; lbl: (x: number | string) => string }) {
  const pts = chart.series[0]?.points ?? [];
  if (!pts.length) return null;
  const max = Math.max(1, ...pts.map((p) => p.y));
  return (
    <div className="rchart__bars" aria-hidden="true">
      {pts.map((p, i) => (
        <div key={i} className="rchart__bar-row">
          <span className="rchart__bar-label" title={lbl(p.x)}>{lbl(p.x)}</span>
          <span className="rchart__bar-track">
            <span className="rchart__bar-fill" style={{ width: `${(p.y / max) * 100}%`, background: colorOf(String(p.x), i) }} />
          </span>
          <span className="rchart__bar-value">{fmt(p.y)}</span>
        </div>
      ))}
    </div>
  );
}

function DonutSvg({ chart, lbl }: { chart: ChartData; lbl: (x: number | string) => string }) {
  const pts = (chart.series[0]?.points ?? []).filter((p) => p.y > 0);
  const total = pts.reduce((a, p) => a + p.y, 0);
  if (!total) return null;
  const R = 50, r = 30, C = 60;
  let acc = 0;
  const arcs = pts.map((p, i) => {
    const a0 = (acc / total) * Math.PI * 2;
    acc += p.y;
    const a1 = (acc / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const pt = (rad: number, a: number) => `${C + rad * Math.sin(a)} ${C - rad * Math.cos(a)}`;
    const d = pts.length === 1
      ? `M ${C} ${C - R} A ${R} ${R} 0 1 1 ${C - 0.01} ${C - R} L ${C - 0.01} ${C - r} A ${r} ${r} 0 1 0 ${C} ${C - r} Z`
      : `M ${pt(R, a0)} A ${R} ${R} 0 ${large} 1 ${pt(R, a1)} L ${pt(r, a1)} A ${r} ${r} 0 ${large} 0 ${pt(r, a0)} Z`;
    return <path key={i} d={d} fill={colorOf(String(p.x), i)} />;
  });
  return (
    <div className="rchart__donut" aria-hidden="true">
      <svg viewBox="0 0 120 120" width={120} height={120}>
        {arcs}
        <text x={C} y={C} textAnchor="middle" dominantBaseline="middle" className="rchart__donut-total">{fmt(total)}</text>
      </svg>
      <ul className="rchart__legend">
        {pts.map((p, i) => (
          <li key={i}>
            <span className="rchart__swatch" style={{ background: colorOf(String(p.x), i) }} />
            {lbl(p.x)} <strong>{fmt(p.y)}</strong> ({((p.y / total) * 100).toFixed(0)}%)
          </li>
        ))}
      </ul>
    </div>
  );
}
