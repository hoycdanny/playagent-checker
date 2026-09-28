import { useMemo, useState } from 'react';
import { apiGet } from '../api/client.ts';
import { useQuery } from '../api/useQuery.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { modelLabel } from '../components/modelProvider.ts';
import './ListPage.css';
import './CostPage.css';

interface CostBucket {
  key: string;
  amountUsd: number;
}
interface MonthlyCost {
  month: string;
  amountUsd: number;
}
interface RealCost {
  available: boolean;
  start: string;
  end: string;
  currency: string;
  totalUsd: number;
  byService: CostBucket[];
  byComponent: CostBucket[];
  byMonth: MonthlyCost[];
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
interface CostResponse {
  real: RealCost;
  estimated: EstimatedCost;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** 水平長條:依最大值等比,顯示 label + 金額。 */
function BarList({
  items,
  labelOf,
}: {
  items: CostBucket[];
  labelOf?: (key: string) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.amountUsd));
  if (items.length === 0) return null;
  return (
    <ul className="cost__bars">
      {items.map((it) => (
        <li key={it.key} className="cost__bar-row">
          <span className="cost__bar-label" title={it.key}>
            {labelOf ? labelOf(it.key) : it.key}
          </span>
          <span className="cost__bar-track" aria-hidden="true">
            <span
              className="cost__bar-fill"
              style={{ width: `${Math.max(2, (it.amountUsd / max) * 100)}%` }}
            />
          </span>
          <span className="cost__bar-amount">{usd(it.amountUsd)}</span>
        </li>
      ))}
    </ul>
  );
}

/** 月趨勢:簡單直條圖。 */
function MonthlyBars({ items }: { items: MonthlyCost[] }) {
  const max = Math.max(1, ...items.map((i) => i.amountUsd));
  if (items.length === 0) return null;
  return (
    <div className="cost__months">
      {items.map((m) => (
        <div key={m.month} className="cost__month" title={`${m.month}: ${usd(m.amountUsd)}`}>
          <div className="cost__month-bar-wrap" aria-hidden="true">
            <div
              className="cost__month-bar"
              style={{ height: `${Math.max(2, (m.amountUsd / max) * 100)}%` }}
            />
          </div>
          <span className="cost__month-amount">{usd(m.amountUsd)}</span>
          <span className="cost__month-label">{m.month}</span>
        </div>
      ))}
    </div>
  );
}

export default function CostPage() {
  const { t } = useI18n();
  const { data, loading, error, refetch } = useQuery<CostResponse>('cost', () =>
    apiGet<CostResponse>('/cost'),
  );
  const [tab, setTab] = useState<'real' | 'estimated'>('real');

  const real = data?.real;
  const estimated = data?.estimated;

  // 真實成本未就緒(未啟用 Cost Explorer / 無權限)時,自動落到估算分頁。
  const effectiveTab = useMemo<'real' | 'estimated'>(() => {
    if (tab === 'real' && real && !real.available) return 'estimated';
    return tab;
  }, [tab, real]);

  return (
    <section className="listpage listpage--wide">
      <header className="listpage__header">
        <h1 className="listpage__title">{t('page.cost.title')}</h1>
        <p className="cost__intro">{t('cost.intro')}</p>
      </header>

      {loading && !data ? (
        <div className="listpage__skeleton" aria-hidden="true">
          <div className="listpage__skeleton-row" />
          <div className="listpage__skeleton-row" />
        </div>
      ) : error ? (
        <div className="listpage__error" role="alert">
          {t('page.loadError')}
          <button type="button" className="cost__retry" onClick={refetch}>
            {t('cost.retry')}
          </button>
        </div>
      ) : (
        <>
          <div className="cost__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={effectiveTab === 'real'}
              className={`cost__tab${effectiveTab === 'real' ? ' cost__tab--active' : ''}`}
              onClick={() => setTab('real')}
            >
              {t('cost.tabReal')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveTab === 'estimated'}
              className={`cost__tab${effectiveTab === 'estimated' ? ' cost__tab--active' : ''}`}
              onClick={() => setTab('estimated')}
            >
              {t('cost.tabEstimated')}
            </button>
          </div>

          {effectiveTab === 'real' &&
            (real?.available ? (
              <div className="cost__panel">
                <div className="cost__summary">
                  <div className="cost__total">
                    <span className="cost__total-label">{t('cost.total')}</span>
                    <span className="cost__total-value">{usd(real.totalUsd)}</span>
                  </div>
                  <span className="cost__range">
                    {real.start} ~ {real.end}
                  </span>
                </div>
                <p className="cost__note">{t('cost.realNote')}</p>

                <h2 className="cost__section-title">{t('cost.byMonth')}</h2>
                <MonthlyBars items={real.byMonth} />

                <h2 className="cost__section-title">{t('cost.byService')}</h2>
                <BarList items={real.byService} />

                <h2 className="cost__section-title">{t('cost.byComponent')}</h2>
                <BarList items={real.byComponent} />
              </div>
            ) : (
              <div className="cost__unavailable">
                <p>{t('cost.realUnavailable')}</p>
                <ol className="cost__enable-steps">
                  <li>{t('cost.enableStep1')}</li>
                  <li>{t('cost.enableStep2')}</li>
                  <li>{t('cost.enableStep3')}</li>
                </ol>
                {real?.note && <p className="cost__error-detail">{real.note}</p>}
              </div>
            ))}

          {effectiveTab === 'estimated' && estimated && (
            <div className="cost__panel">
              <div className="cost__summary">
                <div className="cost__total">
                  <span className="cost__total-label">{t('cost.total')}</span>
                  <span className="cost__total-value">{usd(estimated.totalUsd)}</span>
                </div>
                <span className="cost__range">
                  {t('cost.taskCount')
                    .replace('{priced}', String(estimated.pricedTaskCount))
                    .replace('{total}', String(estimated.taskCount))}
                </span>
              </div>
              <p className="cost__note cost__note--warn">{t('cost.estimatedNote')}</p>

              <h2 className="cost__section-title">{t('cost.byMonth')}</h2>
              <MonthlyBars items={estimated.byMonth} />

              <h2 className="cost__section-title">{t('cost.byApp')}</h2>
              <BarList items={estimated.byApp} />

              <h2 className="cost__section-title">{t('cost.byModel')}</h2>
              <BarList items={estimated.byModel} labelOf={(k) => (k === '(未知)' ? k : modelLabel(k))} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
