import { useEffect, useState } from 'react';
import { apiGet } from '../api/client.ts';
import { useI18n } from '../i18n/I18nProvider.tsx';
import './CaseTrendBadge.css';

/** 趨勢分析的結果訊號(對齊後端 trends.ts)。 */
type RunOutcome = 'pass' | 'fail' | 'blocked' | 'none';
/** 這個訊號是依測試結論算的,還是沒有結論只好退回執行結果。 */
type OutcomeBasis = 'verdict' | 'execution_state';

interface CaseTrend {
  recent: Array<{
    jobId: string;
    state: string;
    createdAt: string;
    /** 測試結論。舊版後端沒有此欄位。 */
    outcome?: RunOutcome;
    basis?: OutcomeBasis;
  }>;
  total: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  passRate: number | null;
  flaky: boolean;
  /** flaky 判定說明(含判定依據);後端一律提供,舊版可能為空。 */
  flakyReason?: string;
  /** 受阻次數(不進通過率分母)。舊版後端沒有此欄位。 */
  blockedCount?: number;
  /** 判定依據的組成。舊版後端沒有此欄位。 */
  verdictCoverage?: { withVerdict: number; total: number; note: string };
  /** 修正複驗鏈。舊版後端沒有此欄位。 */
  retest?: {
    links: Array<{ failedVersion: string; retestVersion: string }>;
    unresolved: Array<{ artifactVersion: string }>;
    note: string;
  };
}

/** 每個結論的符號(形狀編碼,不只靠顏色,Req 11.4)。 */
const OUTCOME_SYMBOL: Record<RunOutcome, string> = {
  pass: '✓',
  fail: '✕',
  blocked: '⊘',
  none: '·',
};

/** 舊版後端只回執行結果時的退路。 */
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
 *
 * 結果點畫的是**測試結論**,不是執行結果 —— 「執行完成」不等於通過
 * (見 docs/design/acceptance-standard.md §1),用執行結果畫會讓結論失敗的那次顯示成 ✓。
 * 沒有結論的舊任務會退回執行結果,並在通過率旁標記,因為依據較弱必須看得出來。
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

  const rate = trend.passRate !== null ? `${Math.round(trend.passRate * 100)}%` : '—';
  const coverage = trend.verdictCoverage;
  // 有任何一筆是退回執行結果算的,通過率就要標記:依據不同,強度不同。
  const fallback = coverage ? coverage.withVerdict < coverage.total : false;
  const retested = trend.retest?.links.length ?? 0;
  const unresolved = trend.retest?.unresolved.length ?? 0;

  return (
    <span className="trend" aria-label={`${t('trend.title')}: ${trend.total} ${t('trend.runs')}`}>
      {/* 最近結果序列:符號(形狀)+ 顏色雙編碼;依結論著色,退回執行結果者加虛線框 */}
      <span className="trend__dots">
        {trend.recent.map((r) => {
          const outcome = r.outcome;
          const symbol = outcome ? OUTCOME_SYMBOL[outcome] : STATE_SYMBOL[r.state] ?? '·';
          const label = outcome
            ? outcome === 'blocked'
              ? t('trend.blocked')
              : outcome
            : r.state;
          return (
            <span
              key={r.jobId}
              className={`trend__dot trend__dot--${outcome ?? r.state}${r.basis === 'execution_state' ? ' trend__dot--fallback' : ''}`}
              title={r.basis === 'execution_state' ? `${label} · ${t('trend.fallbackHint')}` : label}
              aria-label={label}
            >
              {symbol}
            </span>
          );
        })}
      </span>

      <span className={`trend__rate${fallback ? ' trend__rate--fallback' : ''}`} title={fallback ? coverage?.note ?? t('trend.fallbackHint') : undefined}>
        {t('trend.passRate')} {rate}{fallback ? '*' : ''}
      </span>

      {(trend.blockedCount ?? 0) > 0 && (
        <span className="trend__flag trend__flag--blocked">⊘ {t('trend.blocked')} {trend.blockedCount}</span>
      )}

      {/* 複驗狀態:客戶品檢最關心的「失敗修好了沒」,原失敗紀錄不被覆寫 */}
      {(retested > 0 || unresolved > 0) && (
        <span className="trend__retest" title={`${trend.retest?.note ?? ''} ${t('trend.retestHint')}`.trim()}>
          {retested > 0 && <span className="trend__flag trend__flag--stable">↻ {t('trend.retested')} {retested}</span>}
          {unresolved > 0 && <span className="trend__flag trend__flag--flaky">⚠ {t('trend.unresolved')} {unresolved}</span>}
        </span>
      )}

      {/* flaky vs 穩定:文字 + 顏色 + 圖示三重編碼 */}
      {trend.flaky ? (
        <span className="trend__flag trend__flag--flaky" title={trend.flakyReason ?? t('trend.flakyHint')}>
          ⚠ {t('trend.flaky')}
        </span>
      ) : (
        <span className="trend__flag trend__flag--stable">✓ {t('trend.stable')}</span>
      )}
    </span>
  );
}
