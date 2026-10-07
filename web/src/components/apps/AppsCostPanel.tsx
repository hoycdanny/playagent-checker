import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import { SERIES_COLORS, StackedBarChart, type StackSeries } from '../charts/StackedBarChart.tsx';
import Sparkline from '../charts/Sparkline.tsx';
import './AppsCostPanel.css';

export interface DailyCost {
  from: string;
  to: string;
  days: Array<{ date: string; totalUsd: number; modelUsd: number; deviceUsd: number; runs: number; byApp: Record<string, number> }>;
  byApp: Array<{ appId: string; totalUsd: number; modelUsd: number; deviceUsd: number; deviceMinutes: number; runs: number }>;
  totals: { totalUsd: number; modelUsd: number; deviceUsd: number; deviceMinutes: number; runs: number };
}
export interface CostResponse { daily?: DailyCost }

const OPEN_KEY = 'playagent.apps.costOpen';
const usd = (n: number) => `$${n < 1 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;
const mmdd = (iso: string) => iso.slice(5);

/**
 * AppsCostPanel —— 應用管理頁的成本分析區。
 *
 * 和「成本分析」整頁的分工:這裡只回答「哪個應用花得多、走勢往哪走」,
 * 刻意不放 AWS 帳單、模型明細、每日表格(那些在 /cost)。資料同一支
 * `GET /cost?days=30`,useQuery 的 key 也刻意用 `cost:30` —— 和成本分析頁
 * 共用快取,所以兩頁之間來回不會重打後端(那支 API 要掃全部任務)。
 */
export default function AppsCostPanel({
  daily,
  names,
  days = 30,
}: {
  daily: DailyCost | undefined;
  /** appId → 顯示名稱(已刪除的應用仍可能有歷史花費,沒有名稱就顯示 id)。 */
  names: Map<string, string>;
  days?: number;
}) {
  const { t } = useI18n();
  // 預設收合:應用管理頁的主角是應用卡片,成本是輔助資訊。
  // 展開狀態記在 localStorage,每次進頁不用重新點開。
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  function toggle() {
    setOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? '0' : '1');
      } catch { /* 隱私模式下寫不了,不影響功能 */ }
      return !v;
    });
  }

  const rows = useMemo(() => {
    const list = (daily?.byApp ?? []).filter((x) => x.totalUsd > 0 || x.runs > 0);
    return [...list].sort((a, b) => b.totalUsd - a.totalUsd);
  }, [daily]);

  // 堆疊圖只畫花費前 8 名的應用,其餘併成「其他」——
  // 應用一多,圖例會比圖還高,而且相近的顏色根本分不出來。
  const { series, values, categories } = useMemo(() => {
    const d = daily?.days ?? [];
    const top = rows.slice(0, 8).map((x) => x.appId);
    const hasRest = rows.length > top.length;
    const ser: StackSeries[] = top.map((appId, i) => ({
      key: appId,
      label: names.get(appId) ?? appId,
      color: SERIES_COLORS[i % SERIES_COLORS.length]!,
    }));
    // 「其他」沿用 genre.other 的翻譯(五語都是「其他/Other」),不另外加鍵。
    if (hasRest) ser.push({ key: '__rest', label: t('genre.other'), color: '#94a3b8' });
    const vals = d.map((day) => {
      const row: Record<string, number> = {};
      let rest = 0;
      for (const [appId, v] of Object.entries(day.byApp ?? {})) {
        if (top.includes(appId)) row[appId] = (row[appId] ?? 0) + v;
        else rest += v;
      }
      if (hasRest) row['__rest'] = rest;
      return row;
    });
    return { series: ser, values: vals, categories: d.map((x) => x.date) };
  }, [daily, rows, names, t]);

  const totals = daily?.totals;
  const perRun = totals && totals.runs > 0 ? totals.totalUsd / totals.runs : null;

  // 每個應用的日花費序列(走勢圖用);沒有該應用當天資料就是 0。
  const seriesByApp = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const r of rows) {
      m.set(r.appId, (daily?.days ?? []).map((d) => d.byApp?.[r.appId] ?? 0));
    }
    return m;
  }, [rows, daily]);

  return (
    <section className={`acost${open ? ' acost--open' : ''}`}>
      {/* 收合時只有一行:標題 + 總花費/次數/平均,把版面讓給應用卡片 */}
      <header className="acost__head">
        <button
          type="button"
          className="acost__toggle"
          aria-expanded={open}
          onClick={toggle}
          title={open ? t('apps.costCollapse') : t('apps.costExpand')}
        >
          <span className="acost__caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="acost__title">{t('apps.costTitle')}</span>
          <span className="acost__summary">
            {usd(totals?.totalUsd ?? 0)}
            <span className="acost__dot" aria-hidden="true">·</span>
            {totals?.runs ?? 0} {t('apps.kpiRuns')}
            {perRun !== null && (
              <>
                <span className="acost__dot" aria-hidden="true">·</span>
                {t('apps.costPerRun')} {usd(perRun)}
              </>
            )}
            <span className="acost__range">{t('apps.costRange').replace('{n}', String(days))}</span>
          </span>
        </button>
        <Link to="/cost" className="acost__link">{t('apps.costOpen')} →</Link>
      </header>

      {!open ? null : (
      <>
      <p className="acost__desc">{t('apps.costDesc')}</p>

      <div className="acost__kpis">
        <div className="acost__kpi">
          <span className="acost__kpi-label">{t('apps.costTotal')}</span>
          <b>{usd(totals?.totalUsd ?? 0)}</b>
          <span className="acost__kpi-sub">{t('apps.costRange').replace('{n}', String(days))}</span>
        </div>
        <div className="acost__kpi">
          <span className="acost__kpi-label">{t('apps.kpiRuns')}</span>
          <b>{totals?.runs ?? 0}</b>
        </div>
        <div className="acost__kpi">
          <span className="acost__kpi-label">{t('apps.costPerRun')}</span>
          <b>{perRun === null ? '—' : usd(perRun)}</b>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="acost__empty">{t('apps.costNoData')}</p>
      ) : (
        <>
          <h3 className="acost__sub">{t('apps.costDaily')}</h3>
          <StackedBarChart
            categories={categories}
            categoryLabel={mmdd}
            series={series}
            values={values}
            format={usd}
            ariaLabel={t('apps.costDaily')}
            height={220}
            emptyText={t('apps.costNoData')}
          />

          <h3 className="acost__sub">{t('apps.costByApp')}</h3>
          <ul className="acost__rows">
            {rows.map((r, i) => {
              const share = totals && totals.totalUsd > 0 ? (r.totalUsd / totals.totalUsd) * 100 : 0;
              const color = SERIES_COLORS[i % SERIES_COLORS.length]!;
              return (
                <li key={r.appId} className="acost__row">
                  <Link to={`/apps/${encodeURIComponent(r.appId)}`} className="acost__row-name">
                    <span className="acost__swatch" style={{ background: color }} aria-hidden="true" />
                    {names.get(r.appId) ?? r.appId}
                  </Link>
                  {/* 占比條:看相對大小比看數字快 */}
                  <span className="acost__bar" aria-hidden="true">
                    <span className="acost__bar-fill" style={{ width: `${share.toFixed(1)}%`, background: color }} />
                  </span>
                  <Sparkline
                    values={seriesByApp.get(r.appId) ?? []}
                    color={color}
                    format={usd}
                    ariaLabel={`${names.get(r.appId) ?? r.appId} ${t('apps.costTrend')}`}
                  />
                  <span className="acost__row-amount">{usd(r.totalUsd)}</span>
                  <span className="acost__row-runs">{r.runs} {t('apps.kpiRuns')}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      </>
      )}
    </section>
  );
}
