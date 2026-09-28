import { useEffect, useState } from 'react';
import { apiGet } from '../api/client.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import './CaseTrendBadge.css';

interface CaseTrend {
  recent: Array<{ jobId: string; state: string; createdAt: string }>;
  total: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  passRate: number | null;
  flaky: boolean;
}

/** 每個狀態的符號(形狀編碼,不只靠顏色,Req 11.4)。 */
const STATE_SYMBOL: Record<string, string> = {
  pass: '✓',
  fail: '✕',
  error: '!',
  cancelled: '–',
  queued: '·',
  running: '·',
};

/**
 * 案例趨勢徽章(Req 12.1/12.2)。非同步載入某案例的歷史趨勢,
 * 顯示最近結果序列 + flaky/穩定標記。flaky 與確定性 fail 明確區分呈現。
 */
export function CaseTrendBadge({ app, caseId }: { app: string; caseId: string }) {
  const { t } = useI18n();
  const [trend, setTrend] = useState<CaseTrend | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<CaseTrend>(`/trends?app=${encodeURIComponent(app)}&case=${encodeURIComponent(caseId)}`)
      .then((r) => {
        if (!cancelled) setTrend(r);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [app, caseId]);

  if (!loaded) return <span className="trend trend--loading" aria-hidden="true" />;
  if (!trend || trend.total === 0) {
    return <span className="trend trend--none">{t('trend.none')}</span>;
  }

  const rate =
    trend.passRate !== null ? `${Math.round(trend.passRate * 100)}%` : '—';

  return (
    <span className="trend" aria-label={`${t('trend.title')}: ${trend.total} ${t('trend.runs')}`}>
      {/* 最近結果序列:符號(形狀)+ 顏色雙編碼 */}
      <span className="trend__dots">
        {trend.recent.map((r) => (
          <span
            key={r.jobId}
            className={`trend__dot trend__dot--${r.state}`}
            title={r.state}
            aria-label={r.state}
          >
            {STATE_SYMBOL[r.state] ?? '·'}
          </span>
        ))}
      </span>
      <span className="trend__rate">
        {t('trend.passRate')} {rate}
      </span>
      {/* flaky vs 穩定:文字 + 顏色 + 圖示三重編碼 */}
      {trend.flaky ? (
        <span className="trend__flag trend__flag--flaky" title={t('trend.flakyHint')}>
          ⚠ {t('trend.flaky')}
        </span>
      ) : (
        <span className="trend__flag trend__flag--stable">✓ {t('trend.stable')}</span>
      )}
    </span>
  );
}
