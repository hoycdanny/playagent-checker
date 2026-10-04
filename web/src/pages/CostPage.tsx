import { useMemo, useState } from 'react';
import { apiGet } from '../api/client.ts';
import { useQuery } from '../api/useQuery.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { modelLabel } from '../components/modelProvider.ts';
import AppBadge, { useAppLookup } from '../components/AppRef.tsx';
import { SERIES_COLORS, StackedBarChart, type StackSeries } from '../components/charts/StackedBarChart.tsx';
import { reportLang, type RLang } from '../components/report/reportText.ts';
import './ListPage.css';
import './CostPage.css';

interface CostBucket { key: string; amountUsd: number }
interface MonthlyCost { month: string; amountUsd: number }
interface RealCost {
  available: boolean;
  start: string;
  end: string;
  currency: string;
  totalUsd: number;
  byService: CostBucket[];
  byComponent: CostBucket[];
  byMonth: MonthlyCost[];
  byDay?: Array<{ date: string; totalUsd: number; byService: Record<string, number> }>;
  projectFilter?: { key: string; value: string };
  includedServices?: string[];
  note?: string;
}
interface EstimatedCost {
  totalUsd: number;
  taskCount: number;
  pricedTaskCount: number;
  byApp: CostBucket[];
  byModel: CostBucket[];
  byMonth: MonthlyCost[];
}
interface DailyCost {
  from: string;
  to: string;
  days: Array<{ date: string; totalUsd: number; modelUsd: number; deviceUsd: number; runs: number; byApp: Record<string, number> }>;
  byApp: Array<{ appId: string; totalUsd: number; modelUsd: number; deviceUsd: number; deviceMinutes: number; runs: number }>;
  totals: { totalUsd: number; modelUsd: number; deviceUsd: number; deviceMinutes: number; runs: number };
  deviceDataAvailable: boolean;
  unattributed?: { deviceUsd: number; deviceMinutes: number; sessions: number };
  pricing: { deviceFarmUsdPerMinute: number };
}
interface CostResponse { real: RealCost; estimated: EstimatedCost; daily?: DailyCost }

const T = {
  intro: [
    '依天、依測試的應用統計測試花費。每次測試的費用 = AI 模型費用(token × 單價)+ Device Farm 真機實際計量分鐘 × US$0.17。',
    'Testing spend by day and by app under test. Each run = AI model cost (tokens × price) + Device Farm metered device minutes × US$0.17.',
  ],
  tabTest: ['測試費用(依應用)', 'Testing cost (by app)'],
  tabReal: ['AWS 帳單(實際)', 'AWS bill (actual)'],
  range: ['區間', 'Range'],
  days: ['近 {n} 天', 'Last {n} days'],
  app: ['應用', 'App'],
  allApps: ['全部應用', 'All apps'],
  total: ['區間總費用', 'Total in range'],
  model: ['AI 模型', 'AI models'],
  device: ['真機(Device Farm)', 'Real devices (Device Farm)'],
  runs: ['測試次數', 'Runs'],
  perRun: ['平均每次', 'Avg per run'],
  minutes: ['{n} 分鐘', '{n} min'],
  dailyTitle: ['每日費用(依應用堆疊)', 'Daily cost (stacked by app)'],
  dailyComp: ['每日費用(模型 vs 真機)', 'Daily cost (models vs devices)'],
  byStack: ['堆疊方式', 'Stack by'],
  stackApp: ['應用', 'App'],
  stackComp: ['費用類型', 'Cost type'],
  byAppTitle: ['各應用費用', 'Cost by app'],
  colApp: ['應用', 'App'],
  colRuns: ['次數', 'Runs'],
  colMinutes: ['真機分鐘', 'Device min'],
  colModel: ['模型費用', 'Model'],
  colDevice: ['真機費用', 'Device'],
  colTotal: ['總計', 'Total'],
  colShare: ['占比', 'Share'],
  colAvg: ['平均每次', 'Avg / run'],
  byModelTitle: ['模型費用(依模型,全部期間)', 'Model cost by model (all time)'],
  dayTable: ['每日明細', 'Daily breakdown'],
  colDate: ['日期', 'Date'],
  noData: ['此區間沒有測試費用。', 'No testing cost in this range.'],
  method: [
    '計算方式:模型費用以每次任務的 token 用量 × 官方單價估算;真機費用取 Device Farm 每個 session 的實際計量分鐘(session 由任務建立,名稱帶任務編號),× US$0.17/分鐘。日期以台北時間、任務建立時間為準。不含 Fargate、S3、API 等基礎設施(見「AWS 帳單」分頁)。',
    'Method: model cost = tokens per run × list price; device cost = each Device Farm session’s actual metered minutes (sessions are named after the run) × US$0.17/min. Days use Taipei time of run creation. Infrastructure (Fargate, S3, API) is excluded — see the AWS bill tab.',
  ],
  deviceMissing: ['無法讀取 Device Farm 用量,真機費用暫未計入。', 'Device Farm usage could not be read; device cost is not included.'],
  unattributed: ['另有 {n} 個非任務的 Device Farm session(手動測試等)共 {m} 分鐘、{usd},不歸屬任何應用(僅管理員可見)。', '{n} non-run Device Farm session(s) (manual tests etc.) used {m} min, {usd}; not attributed to any app (admins only).'],
  realTotal: ['帳單總額', 'Billed total'],
  realDaily: ['每日帳單(依服務,UTC 日界線)', 'Daily bill by service (UTC days)'],
  realNote: [
    '來自 AWS Cost Explorer 的實際帳單:本專案標籤(project)的資源,加上無法貼標的 {svc}。資料約有 24 小時延遲;Amazon Bedrock 為帳號共用服務無法區分專案,模型費用請看「測試費用」分頁。',
    'Actual AWS bill from Cost Explorer: resources tagged with the project tag, plus untaggable {svc}. Data lags ~24h. Amazon Bedrock is account-wide and cannot be split by project; see the Testing cost tab for model spend.',
  ],
  byMonth: ['每月', 'Monthly'],
  byService: ['依服務', 'By service'],
  byComponent: ['依元件標籤', 'By component tag'],
  unavailable: ['AWS 帳單資料暫時無法取得。', 'AWS billing data is unavailable.'],
  retry: ['重試', 'Retry'],
  loadError: ['載入失敗', 'Failed to load'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];

const RANGES = [7, 14, 30, 90] as const;

function usd(n: number): string {
  if (n === 0) return '$0';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const shortDate = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;

export default function CostPage() {
  const { t, locale } = useI18n();
  const lang = reportLang(locale);
  const [days, setDays] = useState<number>(30);
  const [appFilter, setAppFilter] = useState<string>('all');
  const [stack, setStack] = useState<'app' | 'type'>('app');
  const [tab, setTab] = useState<'test' | 'real'>('test');
  const { data, loading, error, refetch } = useQuery<CostResponse>(`cost:${days}`, () => apiGet<CostResponse>(`/cost?days=${days}`));
  const { lookup } = useAppLookup();
  const appName = (id: string) => lookup(id)?.name ?? id;

  const daily = data?.daily;
  const real = data?.real;

  // 應用篩選後的資料。
  const view = useMemo(() => {
    if (!daily) return null;
    const apps = appFilter === 'all' ? daily.byApp : daily.byApp.filter((a) => a.appId === appFilter);
    const ids = new Set(apps.map((a) => a.appId));
    const totals = apps.reduce(
      (s, a) => ({ totalUsd: s.totalUsd + a.totalUsd, modelUsd: s.modelUsd + a.modelUsd, deviceUsd: s.deviceUsd + a.deviceUsd, deviceMinutes: s.deviceMinutes + a.deviceMinutes, runs: s.runs + a.runs }),
      { totalUsd: 0, modelUsd: 0, deviceUsd: 0, deviceMinutes: 0, runs: 0 },
    );
    const rows = daily.days.map((d) => {
      const byApp = Object.fromEntries(Object.entries(d.byApp).filter(([k]) => ids.has(k)));
      return { date: d.date, byApp, total: Object.values(byApp).reduce((a, b) => a + b, 0) };
    });
    return { apps, totals, rows };
  }, [daily, appFilter]);

  const appSeries: StackSeries[] = useMemo(
    () => (view?.apps ?? []).map((a, i) => ({ key: a.appId, label: appName(a.appId), color: SERIES_COLORS[i % SERIES_COLORS.length]! })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, lookup],
  );
  const typeSeries: StackSeries[] = [
    { key: 'model', label: tx('model', lang), color: SERIES_COLORS[0]! },
    { key: 'device', label: tx('device', lang), color: SERIES_COLORS[2]! },
  ];
  // 依費用類型堆疊只在「全部應用」時精確(每日模型/真機拆分是全應用彙總)。
  const typeValues = (daily?.days ?? []).map((d) => ({ model: d.modelUsd, device: d.deviceUsd }));

  const realServices = useMemo(() => {
    const totals = new Map<string, number>();
    for (const d of real?.byDay ?? []) for (const [k, v] of Object.entries(d.byService)) totals.set(k, (totals.get(k) ?? 0) + v);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k], i) => ({ key: k, label: k, color: SERIES_COLORS[i % SERIES_COLORS.length]! }));
  }, [real]);

  return (
    <section className="listpage listpage--wide cost">
      <header className="listpage__header cost__header">
        <div>
          <h1 className="listpage__title">{t('page.cost.title')}</h1>
          <p className="cost__intro">{tx('intro', lang)}</p>
        </div>
        <div className="cost__controls">
          <div className="cost__seg" role="group" aria-label={tx('range', lang)}>
            {RANGES.map((n) => (
              <button key={n} type="button" className={`cost__seg-btn ${days === n ? 'is-active' : ''}`} aria-pressed={days === n} onClick={() => setDays(n)}>
                {tx('days', lang).replace('{n}', String(n))}
              </button>
            ))}
          </div>
          {tab === 'test' && (
            <label className="cost__select">
              <span className="visually-hidden">{tx('app', lang)}</span>
              <select value={appFilter} onChange={(e) => setAppFilter(e.target.value)}>
                <option value="all">{tx('allApps', lang)}</option>
                {(daily?.byApp ?? []).map((a) => <option key={a.appId} value={a.appId}>{appName(a.appId)}</option>)}
              </select>
            </label>
          )}
        </div>
      </header>

      <div className="cost__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'test'} className={`cost__tab${tab === 'test' ? ' cost__tab--active' : ''}`} onClick={() => setTab('test')}>{tx('tabTest', lang)}</button>
        <button type="button" role="tab" aria-selected={tab === 'real'} className={`cost__tab${tab === 'real' ? ' cost__tab--active' : ''}`} onClick={() => setTab('real')}>{tx('tabReal', lang)}</button>
      </div>

      {loading && !data ? (
        <div className="listpage__skeleton" aria-hidden="true"><div className="listpage__skeleton-row" /><div className="listpage__skeleton-row" /></div>
      ) : error && !data ? (
        <div className="listpage__error" role="alert">
          {tx('loadError', lang)}
          <button type="button" className="cost__retry" onClick={refetch}>{tx('retry', lang)}</button>
        </div>
      ) : tab === 'test' ? (
        daily && view ? (
          <div className="cost__panel">
            <div className="cost__kpis">
              <div className="cost__kpi cost__kpi--main"><span>{tx('total', lang)}</span><strong>{usd(view.totals.totalUsd)}</strong><small>{daily.from} ~ {daily.to}</small></div>
              <div className="cost__kpi"><span>{tx('model', lang)}</span><strong>{usd(view.totals.modelUsd)}</strong></div>
              <div className="cost__kpi"><span>{tx('device', lang)}</span><strong>{usd(view.totals.deviceUsd)}</strong><small>{tx('minutes', lang).replace('{n}', view.totals.deviceMinutes.toFixed(1))}</small></div>
              <div className="cost__kpi"><span>{tx('runs', lang)}</span><strong>{view.totals.runs}</strong></div>
              <div className="cost__kpi"><span>{tx('perRun', lang)}</span><strong>{view.totals.runs ? usd(view.totals.totalUsd / view.totals.runs) : '—'}</strong></div>
            </div>
            {!daily.deviceDataAvailable && <p className="cost__note cost__note--warn" role="status">{tx('deviceMissing', lang)}</p>}

            <div className="cost__card">
              <div className="cost__card-head">
                <h2 className="cost__section-title">{stack === 'app' || appFilter !== 'all' ? tx('dailyTitle', lang) : tx('dailyComp', lang)}</h2>
                {appFilter === 'all' && (
                  <div className="cost__seg cost__seg--sm" role="group" aria-label={tx('byStack', lang)}>
                    <button type="button" className={`cost__seg-btn ${stack === 'app' ? 'is-active' : ''}`} aria-pressed={stack === 'app'} onClick={() => setStack('app')}>{tx('stackApp', lang)}</button>
                    <button type="button" className={`cost__seg-btn ${stack === 'type' ? 'is-active' : ''}`} aria-pressed={stack === 'type'} onClick={() => setStack('type')}>{tx('stackComp', lang)}</button>
                  </div>
                )}
              </div>
              {stack === 'type' && appFilter === 'all' ? (
                <StackedBarChart categories={daily.days.map((d) => d.date)} categoryLabel={shortDate} series={typeSeries} values={typeValues} format={usd} ariaLabel={tx('dailyComp', lang)} emptyText={tx('noData', lang)} />
              ) : (
                <StackedBarChart categories={view.rows.map((r) => r.date)} categoryLabel={shortDate} series={appSeries} values={view.rows.map((r) => r.byApp)} format={usd} ariaLabel={tx('dailyTitle', lang)} emptyText={tx('noData', lang)} />
              )}
            </div>

            <div className="cost__card">
              <h2 className="cost__section-title">{tx('byAppTitle', lang)}</h2>
              {view.apps.length === 0 ? <p className="cost__muted">{tx('noData', lang)}</p> : (
                <div className="cost__table-wrap">
                  <table className="cost__table">
                    <thead>
                      <tr>
                        <th scope="col">{tx('colApp', lang)}</th>
                        <th scope="col" className="num">{tx('colRuns', lang)}</th>
                        <th scope="col" className="num">{tx('colMinutes', lang)}</th>
                        <th scope="col" className="num">{tx('colModel', lang)}</th>
                        <th scope="col" className="num">{tx('colDevice', lang)}</th>
                        <th scope="col" className="num">{tx('colTotal', lang)}</th>
                        <th scope="col" className="num">{tx('colAvg', lang)}</th>
                        <th scope="col">{tx('colShare', lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.apps.map((a, i) => {
                        const share = view.totals.totalUsd > 0 ? (a.totalUsd / view.totals.totalUsd) * 100 : 0;
                        return (
                          <tr key={a.appId}>
                            <th scope="row">
                              <span className="cost__app">
                                <span className="cost__swatch" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} aria-hidden="true" />
                                <AppBadge app={lookup(a.appId)} fallbackId={a.appId} />
                              </span>
                            </th>
                            <td className="num">{a.runs}</td>
                            <td className="num">{a.deviceMinutes.toFixed(1)}</td>
                            <td className="num">{usd(a.modelUsd)}</td>
                            <td className="num">{usd(a.deviceUsd)}</td>
                            <td className="num"><strong>{usd(a.totalUsd)}</strong></td>
                            <td className="num">{a.runs ? usd(a.totalUsd / a.runs) : '—'}</td>
                            <td>
                              <span className="cost__share">
                                <span className="cost__share-track" aria-hidden="true"><span style={{ width: `${share}%`, background: SERIES_COLORS[i % SERIES_COLORS.length] }} /></span>
                                {share.toFixed(1)}%
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <details className="cost__card cost__details">
              <summary>{tx('dayTable', lang)}</summary>
              <div className="cost__table-wrap">
                <table className="cost__table">
                  <thead>
                    <tr>
                      <th scope="col">{tx('colDate', lang)}</th>
                      <th scope="col" className="num">{tx('colRuns', lang)}</th>
                      {appFilter === 'all' && <th scope="col" className="num">{tx('colModel', lang)}</th>}
                      {appFilter === 'all' && <th scope="col" className="num">{tx('colDevice', lang)}</th>}
                      <th scope="col" className="num">{tx('colTotal', lang)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...view.rows].reverse().filter((r) => r.total > 0).map((row) => {
                      const d = daily.days.find((x) => x.date === row.date)!;
                      return (
                        <tr key={d.date}>
                          <th scope="row">{d.date}</th>
                          <td className="num">{appFilter === 'all' ? d.runs : '—'}</td>
                          {appFilter === 'all' && <td className="num">{usd(d.modelUsd)}</td>}
                          {appFilter === 'all' && <td className="num">{usd(d.deviceUsd)}</td>}
                          <td className="num"><strong>{usd(row.total)}</strong></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>

            {data?.estimated && data.estimated.byModel.length > 0 && (
              <div className="cost__card">
                <h2 className="cost__section-title">{tx('byModelTitle', lang)}</h2>
                <BarList items={data.estimated.byModel} labelOf={(k) => (k === '(未知)' ? k : modelLabel(k))} />
              </div>
            )}

            {daily.unattributed && (
              <p className="cost__note">
                {tx('unattributed', lang)
                  .replace('{n}', String(daily.unattributed.sessions))
                  .replace('{m}', daily.unattributed.deviceMinutes.toFixed(1))
                  .replace('{usd}', usd(daily.unattributed.deviceUsd))}
              </p>
            )}
            <p className="cost__note">{tx('method', lang)}</p>
          </div>
        ) : null
      ) : real?.available ? (
        <div className="cost__panel">
          <div className="cost__kpis">
            <div className="cost__kpi cost__kpi--main"><span>{tx('realTotal', lang)}</span><strong>{usd(real.totalUsd)}</strong><small>{real.start} ~ {real.end}</small></div>
          </div>
          <p className="cost__note">{tx('realNote', lang).replace('{svc}', (real.includedServices ?? []).join(', ') || '—')}</p>
          {real.byDay && real.byDay.length > 0 && (
            <div className="cost__card">
              <h2 className="cost__section-title">{tx('realDaily', lang)}</h2>
              <StackedBarChart
                categories={real.byDay.map((d) => d.date)}
                categoryLabel={shortDate}
                series={realServices}
                values={real.byDay.map((d) => d.byService)}
                format={usd}
                ariaLabel={tx('realDaily', lang)}
                emptyText={tx('noData', lang)}
              />
            </div>
          )}
          <div className="cost__grid2">
            <div className="cost__card">
              <h2 className="cost__section-title">{tx('byService', lang)}</h2>
              <BarList items={real.byService} />
            </div>
            <div className="cost__card">
              <h2 className="cost__section-title">{tx('byMonth', lang)}</h2>
              <BarList items={real.byMonth.map((m) => ({ key: m.month, amountUsd: m.amountUsd }))} />
              <h2 className="cost__section-title">{tx('byComponent', lang)}</h2>
              <BarList items={real.byComponent} />
            </div>
          </div>
        </div>
      ) : (
        <div className="cost__unavailable">
          <p>{tx('unavailable', lang)}</p>
          <ol className="cost__enable-steps">
            <li>{t('cost.enableStep1')}</li>
            <li>{t('cost.enableStep2')}</li>
            <li>{t('cost.enableStep3')}</li>
          </ol>
          {real?.note && <p className="cost__error-detail">{real.note}</p>}
        </div>
      )}
    </section>
  );
}

/** 水平長條:依最大值等比,顯示 label + 金額。 */
function BarList({ items, labelOf }: { items: CostBucket[]; labelOf?: (key: string) => string }) {
  const max = Math.max(1e-9, ...items.map((i) => i.amountUsd));
  if (items.length === 0) return null;
  return (
    <ul className="cost__bars">
      {items.map((it) => (
        <li key={it.key} className="cost__bar-row">
          <span className="cost__bar-label" title={it.key}>{labelOf ? labelOf(it.key) : it.key}</span>
          <span className="cost__bar-track" aria-hidden="true">
            <span className="cost__bar-fill" style={{ width: `${Math.max(2, (it.amountUsd / max) * 100)}%` }} />
          </span>
          <span className="cost__bar-amount">{usd(it.amountUsd)}</span>
        </li>
      ))}
    </ul>
  );
}
