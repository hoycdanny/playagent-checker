import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../i18n/I18nProvider.tsx';
import AppBadge, { type AppRef } from '../AppRef.tsx';
import { modelLabel } from '../modelProvider.ts';
import { reportLang, type RLang } from '../report/reportText.ts';
import { CaseVersionBadge } from './CaseVersions.tsx';
import UserTag from '../UserTag.tsx';
import { pick5, type L5 } from '../../i18n/locale5.ts';
import './CaseOverviewTable.css';

/** 後端 GET /cases/overview 的一列(infra/lambda/api/caseOverview.ts)。 */
export interface CaseRunSummary {
  jobId: string;
  state: string;
  createdAt: string;
  finishedAt?: string;
  caseVersion?: string;
  message?: string;
  stepCount?: number;
  deviceModel?: string;
  vlmModel?: string;
  costUsd?: number;
}
export interface CaseOverviewItem {
  id: string;
  app: string;
  name: string;
  version?: string;
  updatedAt?: string;
  /** 最後新增 / 修改 / 切換版本的使用者。 */
  updatedBy?: string;
  versionCount: number;
  parsed: {
    task?: string;
    steps: string[];
    assertions: string[];
    controls?: string[];
    url?: string;
    priority?: string;
    severity?: string;
    module?: string;
    category?: string;
    precondition?: string;
    expected?: string;
    tags: string[];
    extra: Record<string, string>;
  };
  stats: {
    runs: number;
    pass: number;
    fail: number;
    error: number;
    cancelled: number;
    running: number;
    passRate: number | null;
    recent: Array<{ jobId: string; state: string }>;
    last?: CaseRunSummary;
    lastResult?: CaseRunSummary;
    costUsd: number;
    avgDurationMs: number | null;
    avgSteps: number | null;
    runsOnCurrentVersion: number;
    versionsRun: number;
  };
}

const T = {
  cases: ['測試案例', 'Test cases', '测试用例', 'テストケース', '테스트 케이스'],
  runs: ['執行次數', 'Runs', '运行次数', '実行回数', '실행 횟수'],
  passRate: ['通過率', 'Pass rate', '通过率', '合格率', '통과율'],
  failing: ['最近一次失敗', 'Last result failed', '最近一次失败', '直近の結果は不合格', '가장 최근 결과 실패'],
  never: ['尚未執行', 'Never run', '尚未运行', '未実行', '실행 안 함'],
  cost: ['累計費用', 'Total cost', '累计费用', '累計費用', '누적 비용'],
  search: ['搜尋案例名稱、步驟、驗收條件…', 'Search name, steps, acceptance criteria…', '搜索用例名称、步骤、验收条件…', 'ケース名、ステップ、合格条件を検索…', '케이스 이름, 단계, 합격 기준 검색…'],
  allApps: ['全部應用', 'All apps', '全部应用', 'すべてのアプリ', '모든 앱'],
  all: ['全部', 'All', '全部', 'すべて', '전체'],
  pass: ['通過', 'Pass', '通过', '合格', '통과'],
  fail: ['失敗', 'Fail', '失败', '不合格', '실패'],
  colCase: ['測試案例', 'Test case', '测试用例', 'テストケース', '테스트 케이스'],
  colScope: ['內容', 'Scope', '内容', '内容', '내용'],
  colLast: ['最近結果', 'Latest result', '最近结果', '直近の結果', '최근 결과'],
  colRate: ['通過率', 'Pass rate', '通过率', '合格率', '통과율'],
  colTrend: ['近 10 次', 'Last 10', '近 10 次', '直近 10 回', '최근 10회'],
  colRuns: ['次數', 'Runs', '次数', '回数', '횟수'],
  colAvg: ['平均時長 / 步數', 'Avg time / steps', '平均时长 / 步数', '平均所要時間 / ステップ数', '평균 소요 시간 / 단계 수'],
  colCost: ['費用', 'Cost', '费用', '費用', '비용'],
  colActions: ['操作', 'Actions', '操作', '操作', '작업'],
  steps: ['{n} 個步驟', '{n} steps', '{n} 个步骤', '{n} ステップ', '{n}단계'],
  assertions: ['{n} 項驗收', '{n} checks', '{n} 项验收', '{n} 件の合格条件', '합격 기준 {n}개'],
  details: ['詳情', 'Details', '详情', '詳細', '상세'],
  hide: ['收合', 'Hide', '收合', '閉じる', '접기'],
  edit: ['編輯', 'Edit', '编辑', '編集', '편집'],
  del: ['刪除', 'Delete', '删除', '削除', '삭제'],
  testSteps: ['測試步驟', 'Test steps', '测试步骤', 'テストステップ', '테스트 단계'],
  acceptance: ['驗收條件', 'Acceptance criteria', '验收条件', '合格条件', '합격 기준'],
  settings: ['設定', 'Settings', '设置', '設定', '설정'],
  history: ['最近執行', 'Recent runs', '最近运行', '最近の実行', '최근 실행'],
  controls: ['操作行為', 'Controls', '操作行为', '操作方法', '조작 방식'],
  controlsDefault: ['未指定(依遊戲類型建議)', 'Not set (genre default)', '未指定(依游戏类型建议)', '未指定(ゲームジャンルの推奨に従う)', '지정 안 함(게임 장르 권장값 사용)'],
  priority: ['優先級', 'Priority', '优先级', '優先度', '우선순위'],
  severity: ['嚴重度', 'Severity', '严重度', '重大度', '심각도'],
  module: ['模組', 'Module', '模块', 'モジュール', '모듈'],
  category: ['分類', 'Category', '分类', '分類', '분류'],
  url: ['網址', 'URL', '网址', 'URL', 'URL'],
  precondition: ['前置條件', 'Precondition', '前置条件', '前提条件', '사전 조건'],
  expected: ['預期結果', 'Expected result', '预期结果', '期待結果', '기대 결과'],
  tags: ['標籤', 'Tags', '标签', 'タグ', '태그'],
  version: ['目前版本', 'Current version', '目前版本', '現在のバージョン', '현재 버전'],
  versions: ['共 {n} 個版本', '{n} versions', '共 {n} 个版本', '全 {n} バージョン', '총 {n}개 버전'],
  updated: ['最後更新', 'Last updated', '最后更新', '最終更新', '마지막 업데이트'],
  updatedBy: ['最後修改', 'Last edited by', '最后修改', '最終編集者', '마지막 수정자'],
  onVersion: ['此版本已跑 {n} 次', '{n} run(s) on this version', '此版本已跑 {n} 次', 'このバージョンで {n} 回実行', '이 버전에서 {n}회 실행'],
  versionsRun: ['跑過 {n} 個版本', 'Ran on {n} version(s)', '跑过 {n} 个版本', '{n} バージョンで実行', '{n}개 버전에서 실행됨'],
  noSteps: ['案例未寫步驟(task)。', 'No steps (task) written.', '用例未写步骤(task)。', 'ステップ(task)が書かれていません。', '단계(task)가 작성되지 않았습니다.'],
  noAssertions: ['未設定驗收條件,報告將以 AI 判斷目標是否完成。', 'No acceptance criteria; the report relies on AI judging goal completion.', '未设置验收条件,报告将以 AI 判断目标是否完成。', '合格条件が未設定のため、レポートは AI による目標達成の判断に基づきます。', '합격 기준이 설정되지 않아 보고서는 AI의 목표 달성 판단에 따릅니다.'],
  viewReport: ['報告', 'Report', '报告', 'レポート', '보고서'],
  device: ['裝置', 'Device', '设备', 'デバイス', '기기'],
  model: ['模型', 'Model', '模型', 'モデル', '모델'],
  ranWith: ['使用版本', 'Version', '使用版本', '使用バージョン', '사용 버전'],
  empty: ['沒有符合條件的案例。', 'No cases match.', '没有符合条件的用例。', '条件に一致するケースがありません。', '조건에 맞는 케이스가 없습니다.'],
  breakdown: ['通過 {p} · 失敗 {f} · 錯誤 {e} · 取消 {c}', 'Pass {p} · Fail {f} · Error {e} · Cancelled {c}', '通过 {p} · 失败 {f} · 错误 {e} · 取消 {c}', '合格 {p} · 不合格 {f} · エラー {e} · キャンセル {c}', '통과 {p} · 실패 {f} · 오류 {e} · 취소 {c}'],
  runningNow: ['執行中 {n}', '{n} running', '运行中 {n}', '実行中 {n}', '실행 중 {n}'],
  costNote: ['費用 = 模型 token 費用 + Device Farm 真機計量分鐘 × $0.17。', 'Cost = model tokens + Device Farm metered minutes × $0.17.', '费用 = 模型 token 费用 + Device Farm 真机计量分钟 × $0.17。', '費用 = モデルのトークン費用 + Device Farm 実機の実測分数 × $0.17。', '비용 = 모델 토큰 비용 + Device Farm 실제 기기 실측 분 × $0.17.'],
  selectRow: ['選取', 'Select', '选取', '選択', '선택'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => pick5(T[k], lang);

// pass / pass_risk / fail / blocked = 測試結論(後端以驗收標準判定,與報告封面一致);其餘為執行狀態。
const STATE: Record<string, L5> = {
  pass: ['通過', 'Pass', '通过', '合格', '통과'],
  pass_risk: ['通過(有風險)', 'Pass with risk', '通过(有风险)', '合格(リスクあり)', '통과(위험 있음)'],
  fail: ['失敗', 'Fail', '失败', '不合格', '실패'],
  blocked: ['受阻', 'Blocked', '受阻', 'ブロック', '차단됨'],
  error: ['錯誤', 'Error', '错误', 'エラー', '오류'],
  cancelled: ['已取消', 'Cancelled', '已取消', 'キャンセル済み', '취소됨'],
  budget_exceeded: ['超出預算', 'Over budget', '超出预算', '予算超過', '예산 초과'],
  running: ['執行中', 'Running', '运行中', '実行中', '실행 중'],
  queued: ['排隊中', 'Queued', '排队中', '待機中', '대기 중'],
};
const stateText = (s: string, lang: RLang) => (STATE[s] ? pick5(STATE[s]!, lang) : s);

function usd(n: number): string {
  if (!n) return '$0';
  // 每個案例的單次花費多半是幾分錢,顯示到小數點後四位才評估得準;≥ $1 維持兩位好讀。
  return Math.abs(n) < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
function duration(ms: number | null): string {
  if (ms === null) return '—';
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return m ? `${m}m ${s}s` : `${s}s`;
}

type StatusFilter = 'all' | 'pass' | 'fail' | 'never';

export function CaseOverviewTable({
  items,
  appLookup,
  selected,
  onToggleSelect,
  onEdit,
  onDelete,
  busyId,
}: {
  items: CaseOverviewItem[];
  appLookup: (id: string) => AppRef | undefined;
  selected: Set<string>;
  onToggleSelect: (key: string, checked: boolean) => void;
  onEdit: (c: CaseOverviewItem) => void;
  onDelete: (c: CaseOverviewItem) => void;
  busyId?: string | null;
}) {
  const { locale } = useI18n();
  const lang = reportLang(locale);
  const [q, setQ] = useState('');
  const [app, setApp] = useState('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const keyOf = (c: CaseOverviewItem) => `${c.app}/${c.id}`;
  const time = (iso?: string) => (iso ? new Date(iso).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

  const apps = useMemo(() => [...new Set(items.map((c) => c.app))], [items]);
  const kpi = useMemo(() => {
    const runs = items.reduce((a, c) => a + c.stats.runs, 0);
    const pass = items.reduce((a, c) => a + c.stats.pass, 0);
    const fail = items.reduce((a, c) => a + c.stats.fail, 0);
    return {
      cases: items.length,
      runs,
      passRate: pass + fail ? Math.round((pass / (pass + fail)) * 1000) / 10 : null,
      failing: items.filter((c) => c.stats.lastResult?.state === 'fail').length,
      never: items.filter((c) => c.stats.runs === 0).length,
      cost: items.reduce((a, c) => a + c.stats.costUsd, 0),
    };
  }, [items]);

  const rows = items.filter((c) => {
    if (app !== 'all' && c.app !== app) return false;
    if (status === 'never' && c.stats.runs > 0) return false;
    if ((status === 'pass' || status === 'fail') && c.stats.lastResult?.state !== status) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [c.name, c.id, c.version, c.parsed.task, ...c.parsed.assertions, ...c.parsed.tags, appLookup(c.app)?.name]
      .filter(Boolean).join(' ').toLowerCase().includes(needle);
  });

  const toggle = (k: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  return (
    <div className="cov">
      <div className="cov__kpis">
        <div className="cov__kpi"><span>{tx('cases', lang)}</span><strong>{kpi.cases}</strong></div>
        <div className="cov__kpi"><span>{tx('runs', lang)}</span><strong>{kpi.runs}</strong></div>
        <div className="cov__kpi"><span>{tx('passRate', lang)}</span><strong>{kpi.passRate === null ? '—' : `${kpi.passRate}%`}</strong></div>
        <button type="button" className={`cov__kpi cov__kpi--btn ${status === 'fail' ? 'is-active' : ''}`} onClick={() => setStatus(status === 'fail' ? 'all' : 'fail')} aria-pressed={status === 'fail'}>
          <span>{tx('failing', lang)}</span><strong className={kpi.failing ? 'is-fail' : ''}>{kpi.failing}</strong>
        </button>
        <button type="button" className={`cov__kpi cov__kpi--btn ${status === 'never' ? 'is-active' : ''}`} onClick={() => setStatus(status === 'never' ? 'all' : 'never')} aria-pressed={status === 'never'}>
          <span>{tx('never', lang)}</span><strong>{kpi.never}</strong>
        </button>
        <div className="cov__kpi" title={tx('costNote', lang)}><span>{tx('cost', lang)}</span><strong>{usd(kpi.cost)}</strong></div>
      </div>

      <div className="cov__bar">
        <input className="cov__search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx('search', lang)} aria-label={tx('search', lang)} />
        <select className="cov__select" value={app} onChange={(e) => setApp(e.target.value)} aria-label={tx('allApps', lang)}>
          <option value="all">{tx('allApps', lang)}</option>
          {apps.map((a) => <option key={a} value={a}>{appLookup(a)?.name ?? a}</option>)}
        </select>
        <div className="cov__seg" role="group">
          {(['all', 'pass', 'fail', 'never'] as const).map((s) => (
            <button key={s} type="button" className={`cov__seg-btn ${status === s ? 'is-active' : ''}`} aria-pressed={status === s} onClick={() => setStatus(s)}>
              {tx(s === 'never' ? 'never' : s, lang)}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="cov__empty">{tx('empty', lang)}</p>
      ) : (
        <div className="cov__table-wrap">
          <table className="cov__table">
            <thead>
              <tr>
                <th scope="col" className="cov__chk"><span className="visually-hidden">{tx('selectRow', lang)}</span></th>
                <th scope="col">{tx('colCase', lang)}</th>
                <th scope="col">{tx('colScope', lang)}</th>
                <th scope="col">{tx('colLast', lang)}</th>
                <th scope="col">{tx('colRate', lang)}</th>
                <th scope="col">{tx('colTrend', lang)}</th>
                <th scope="col" className="num">{tx('colRuns', lang)}</th>
                <th scope="col" className="num">{tx('colAvg', lang)}</th>
                <th scope="col" className="num">{tx('colCost', lang)}</th>
                <th scope="col" className="cov__actions-h">{tx('colActions', lang)}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const k = keyOf(c);
                const isOpen = open.has(k);
                const s = c.stats;
                const lr = s.lastResult ?? s.last;
                return (
                  <Fragment key={k}>
                    <tr className={`cov__row ${selected.has(k) ? 'is-selected' : ''} ${isOpen ? 'is-open' : ''}`}>
                      <td className="cov__chk">
                        <input type="checkbox" aria-label={`${tx('selectRow', lang)} ${c.name}`} checked={selected.has(k)} onChange={(e) => onToggleSelect(k, e.target.checked)} />
                      </td>
                      <td className="cov__case">
                        <button type="button" className="cov__name" aria-expanded={isOpen} aria-controls={`cov-d-${c.id}`} onClick={() => toggle(k)}>
                          <span aria-hidden="true" className="cov__caret">{isOpen ? '▾' : '▸'}</span>{c.name}
                        </button>
                        <div className="cov__sub">
                          <AppBadge app={appLookup(c.app)} fallbackId={c.app} />
                          <CaseVersionBadge version={c.version} />
                          {c.updatedBy && <UserTag user={c.updatedBy} prefix={tx('updatedBy', lang)} />}
                          {c.parsed.priority && <span className="cov__chip cov__chip--prio">{c.parsed.priority}</span>}
                          {(c.parsed.controls ?? []).map((ctl) => <span key={ctl} className="cov__chip">{ctl}</span>)}
                          {c.parsed.tags.map((tg) => <span key={tg} className="cov__chip cov__chip--tag">#{tg}</span>)}
                        </div>
                      </td>
                      <td className="cov__scope">
                        <span>{tx('steps', lang).replace('{n}', String(c.parsed.steps.length))}</span>
                        <span>{tx('assertions', lang).replace('{n}', String(c.parsed.assertions.length))}</span>
                      </td>
                      <td className="cov__last">
                        {lr ? (
                          <>
                            <Link to={`/reports/${lr.jobId}`} className={`cov__pill cov__pill--${lr.state}`}>{stateText(lr.state, lang)}</Link>
                            <span className="cov__muted">{time(lr.createdAt)}</span>
                            {lr.caseVersion && lr.caseVersion !== c.version && <span className="cov__muted cov__mono" title={tx('ranWith', lang)}>v{lr.caseVersion}</span>}
                          </>
                        ) : <span className="cov__muted">{tx('never', lang)}</span>}
                        {s.running > 0 && <span className="cov__running">{tx('runningNow', lang).replace('{n}', String(s.running))}</span>}
                      </td>
                      <td className="cov__rate" title={tx('breakdown', lang).replace('{p}', String(s.pass)).replace('{f}', String(s.fail)).replace('{e}', String(s.error)).replace('{c}', String(s.cancelled))}>
                        {s.passRate === null ? <span className="cov__muted">—</span> : (
                          <>
                            <span className="cov__rate-v">{s.passRate}%</span>
                            <span className="cov__rate-track" aria-hidden="true"><span style={{ width: `${s.passRate}%` }} /></span>
                            <span className="cov__muted">{s.pass}/{s.pass + s.fail}</span>
                          </>
                        )}
                      </td>
                      <td>
                        <span className="cov__dots" aria-label={s.recent.map((r) => stateText(r.state, lang)).join(', ')}>
                          {s.recent.map((r) => (
                            <Link key={r.jobId} to={`/reports/${r.jobId}`} className={`cov__dot cov__dot--${r.state}`} title={`${stateText(r.state, lang)} · ${r.jobId}`} aria-hidden="true" tabIndex={-1} />
                          ))}
                          {s.recent.length === 0 && <span className="cov__muted">—</span>}
                        </span>
                      </td>
                      <td className="num">{s.runs}</td>
                      <td className="num">{duration(s.avgDurationMs)}<span className="cov__muted"> / {s.avgSteps ?? '—'}</span></td>
                      <td className="num">{usd(s.costUsd)}</td>
                      <td className="cov__actions">
                        <button type="button" className="cov__btn" onClick={() => onEdit(c)} disabled={busyId === c.id}>{tx('edit', lang)}</button>
                        <button type="button" className="cov__btn cov__btn--danger" onClick={() => onDelete(c)} disabled={busyId === c.id}>{tx('del', lang)}</button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="cov__detail-row" id={`cov-d-${c.id}`}>
                        <td colSpan={10}>
                          <div className="cov__detail">
                            <section>
                              <h4>{tx('testSteps', lang)}</h4>
                              {c.parsed.steps.length ? (
                                <ol className="cov__steps">{c.parsed.steps.map((st, i) => <li key={i}>{st}</li>)}</ol>
                              ) : <p className="cov__muted">{tx('noSteps', lang)}</p>}
                            </section>
                            <section>
                              <h4>{tx('acceptance', lang)}</h4>
                              {c.parsed.assertions.length ? (
                                <ul className="cov__checks">{c.parsed.assertions.map((a, i) => <li key={i}><span aria-hidden="true">☐</span>{a}</li>)}</ul>
                              ) : <p className="cov__muted">{tx('noAssertions', lang)}</p>}
                            </section>
                            <section>
                              <h4>{tx('settings', lang)}</h4>
                              <dl className="cov__dl">
                                <div><dt>{tx('version', lang)}</dt><dd><CaseVersionBadge version={c.version} /> <span className="cov__muted">{tx('versions', lang).replace('{n}', String(c.versionCount))}</span></dd></div>
                                <div><dt>{tx('updated', lang)}</dt><dd>{c.updatedAt ? new Date(c.updatedAt).toLocaleString(locale) : '—'}{c.updatedBy && <> · <UserTag user={c.updatedBy} prefix={tx('updatedBy', lang)} /></>}</dd></div>
                                <div><dt>{tx('controls', lang)}</dt><dd>{c.parsed.controls?.length ? c.parsed.controls.join(', ') : tx('controlsDefault', lang)}</dd></div>
                                {c.parsed.priority && <div><dt>{tx('priority', lang)}</dt><dd>{c.parsed.priority}</dd></div>}
                                {c.parsed.severity && <div><dt>{tx('severity', lang)}</dt><dd>{c.parsed.severity}</dd></div>}
                                {c.parsed.module && <div><dt>{tx('module', lang)}</dt><dd>{c.parsed.module}</dd></div>}
                                {c.parsed.category && <div><dt>{tx('category', lang)}</dt><dd>{c.parsed.category}</dd></div>}
                                {c.parsed.url && <div><dt>{tx('url', lang)}</dt><dd className="cov__mono">{c.parsed.url}</dd></div>}
                                {c.parsed.precondition && <div><dt>{tx('precondition', lang)}</dt><dd>{c.parsed.precondition}</dd></div>}
                                {c.parsed.expected && <div><dt>{tx('expected', lang)}</dt><dd>{c.parsed.expected}</dd></div>}
                                {c.parsed.tags.length > 0 && <div><dt>{tx('tags', lang)}</dt><dd>{c.parsed.tags.join(', ')}</dd></div>}
                                {Object.entries(c.parsed.extra).map(([k2, v]) => <div key={k2}><dt className="cov__mono">{k2}</dt><dd>{v}</dd></div>)}
                                <div><dt>{tx('runs', lang)}</dt><dd>
                                  {tx('breakdown', lang).replace('{p}', String(s.pass)).replace('{f}', String(s.fail)).replace('{e}', String(s.error)).replace('{c}', String(s.cancelled))}
                                  {c.version ? ` · ${tx('onVersion', lang).replace('{n}', String(s.runsOnCurrentVersion))}` : ''}
                                  {s.versionsRun > 0 ? ` · ${tx('versionsRun', lang).replace('{n}', String(s.versionsRun))}` : ''}
                                </dd></div>
                              </dl>
                            </section>
                            {s.last && (
                              <section className="cov__detail-wide">
                                <h4>{tx('history', lang)}</h4>
                                <dl className="cov__dl cov__dl--row">
                                  <div><dt>{tx('colLast', lang)}</dt><dd><Link to={`/reports/${s.last.jobId}`} className={`cov__pill cov__pill--${s.last.state}`}>{stateText(s.last.state, lang)}</Link> <span className="cov__mono cov__muted">{s.last.jobId}</span></dd></div>
                                  {s.last.caseVersion && <div><dt>{tx('ranWith', lang)}</dt><dd className="cov__mono">{s.last.caseVersion}</dd></div>}
                                  {s.last.deviceModel && <div><dt>{tx('device', lang)}</dt><dd>{s.last.deviceModel}</dd></div>}
                                  {s.last.vlmModel && <div><dt>{tx('model', lang)}</dt><dd>{modelLabel(s.last.vlmModel)}</dd></div>}
                                  {typeof s.last.costUsd === 'number' && <div><dt>{tx('colCost', lang)}</dt><dd>{usd(s.last.costUsd)}</dd></div>}
                                </dl>
                                {s.last.message && <p className="cov__msg">{s.last.message}</p>}
                              </section>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="cov__note">{tx('costNote', lang)}</p>
    </div>
  );
}
