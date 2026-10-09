import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { apiGet, apiPost, apiPut } from '../api/client.ts';
import { useAuth } from '../auth/AuthProvider.tsx';
import { useI18n } from '../i18n/I18nProvider.tsx';
import './ListPage.css';
import { UitarsPanel } from '../components/system/UitarsPanel.tsx';
import './SystemUpdatePage.css';

/** 與後端 systemUpdate.ts 的回傳型別對齊。 */
interface DeployedVersion {
  ref: string;
  sha: string;
  subject?: string;
  by?: string;
  buildId?: string;
  at?: string;
}
interface RemoteVersion {
  kind: 'release' | 'tag' | 'branch';
  ref: string;
  sha: string;
  subject?: string;
  publishedAt?: string;
  url?: string;
}
interface CommitSummary { sha: string; subject: string; author?: string; at?: string }
interface BuildProgress {
  buildId: string;
  status: string;
  currentPhase?: string;
  startedAt?: string;
  endedAt?: string;
  phases: { name: string; status?: string; seconds?: number }[];
}
interface VersionReport {
  repo: string;
  tokenConfigured: boolean;
  deployed: DeployedVersion | null;
  latest: RemoteVersion | null;
  behind: { count: number; commits: CommitSummary[] };
  updateAvailable: boolean;
  activeRuns: number | null;
  running: BuildProgress | null;
  error?: string;
}
interface HistoryEntry {
  ref: string;
  sha: string;
  subject?: string;
  result: 'success' | 'failed' | 'started';
  by?: string;
  buildId?: string;
  at: string;
}

const TERMINAL = ['SUCCEEDED', 'FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'];
const short = (sha: string) => (sha ? sha.slice(0, 7) : '-');
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '-');

export default function SystemUpdatePage() {
  const { locale } = useI18n();
  const { isAdmin } = useAuth();
  const T = text(locale);

  const [report, setReport] = useState<VersionReport | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 二次確認:要輸入目標版本字串才會啟用「開始更新」。
  const [confirmRef, setConfirmRef] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [token, setToken] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);

  const [build, setBuild] = useState<BuildProgress | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const logNext = useRef<string | undefined>(undefined);
  const logBox = useRef<HTMLPreElement | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [v, h] = await Promise.all([
        apiGet<VersionReport>('/system/version'),
        apiGet<{ items: HistoryEntry[] }>('/system/history'),
      ]);
      setReport(v);
      setHistory(h.items ?? []);
      if (v.running) setBuild(v.running);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  // 更新進行中:每 5 秒拉一次進度,並從上次位置續讀 log。
  useEffect(() => {
    if (!build || TERMINAL.includes(build.status)) return;
    let stop = false;
    const tick = async () => {
      try {
        const next = await apiGet<BuildProgress>(`/system/update/${encodeURIComponent(build.buildId)}`);
        if (stop) return;
        setBuild(next);
        const page = await apiGet<{ lines: string[]; nextToken?: string }>(
          `/system/update/${encodeURIComponent(build.buildId)}/log${logNext.current ? `?next=${encodeURIComponent(logNext.current)}` : ''}`,
        );
        if (stop) return;
        if (page.lines.length > 0) setLogLines((prev) => [...prev, ...page.lines].slice(-800));
        // nextForwardToken 不變代表沒有新資料;照樣存起來,下一輪再從這裡問。
        logNext.current = page.nextToken ?? logNext.current;
        if (TERMINAL.includes(next.status)) void load();
      } catch {
        /* 輪詢失敗不打斷畫面 */
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(id); };
  }, [build, load]);

  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [logLines]);

  if (!isAdmin) {
    return (
      <section className="listpage listpage--wide">
        <header className="listpage__header"><h1 className="listpage__title">{T.title}</h1></header>
        <div className="listpage__empty"><p>{T.adminOnly}</p></div>
      </section>
    );
  }

  async function onSaveToken(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    setTokenBusy(true);
    try {
      await apiPut('/system/github-token', { token: token.trim() });
      setToken('');
      setNotice(T.tokenSaved);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTokenBusy(false);
    }
  }

  async function onUpdate(ref: string, force: boolean) {
    setNotice(null);
    setError(null);
    setBusy(true);
    try {
      const started = await apiPost<{ buildId: string }>('/system/update', { ref, ...(force ? { force: true } : {}) });
      setLogLines([]);
      logNext.current = undefined;
      setBuild({ buildId: started.buildId, status: 'IN_PROGRESS', phases: [] });
      setConfirming(null);
      setConfirmRef('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const latest = report?.latest ?? null;
  const running = build && !TERMINAL.includes(build.status) ? build : null;
  const canUpdate = Boolean(report?.tokenConfigured) && !running && !busy;

  return (
    <section className="listpage listpage--wide">
      <header className="listpage__header">
        <h1 className="listpage__title">{T.title}</h1>
        <button type="button" className="sysupd__refresh" onClick={() => void load()} disabled={loading}>
          {T.refresh}
        </button>
      </header>

      <h2 className="sysupd__section">{T.updateSection}</h2>
      <p className="sysupd__repo">{T.repo}: <code>{report?.repo ?? '-'}</code></p>

      {error && <p className="sysupd__error" role="alert">{error}</p>}
      {notice && <p className="sysupd__ok" role="status">{notice}</p>}

      {/* 沒有 token:顯示引導,其餘功能照常呈現已部署版本 */}
      {report && !report.tokenConfigured && (
        <div className="sysupd__card sysupd__card--warn">
          <h2 className="sysupd__card-title">{T.tokenTitle}</h2>
          <p className="sysupd__hint">{T.tokenHint}</p>
          <form className="sysupd__token-form" onSubmit={onSaveToken}>
            <input
              type="password"
              className="sysupd__token-input"
              value={token}
              placeholder="github_pat_…"
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
              aria-label={T.tokenTitle}
            />
            <button type="submit" className="sysupd__primary" disabled={tokenBusy || token.trim().length < 20}>
              {tokenBusy ? T.saving : T.tokenSave}
            </button>
          </form>
          <p className="sysupd__muted">{T.tokenNote}</p>
        </div>
      )}

      {/* 版本比對 */}
      <div className="sysupd__grid">
        <div className="sysupd__card">
          <h2 className="sysupd__card-title">{T.deployed}</h2>
          {report?.deployed ? (
            <>
              <p className="sysupd__version">{report.deployed.ref} <span className="sysupd__sha">{short(report.deployed.sha)}</span></p>
              {report.deployed.subject && <p className="sysupd__subject">{report.deployed.subject}</p>}
              <p className="sysupd__muted">{when(report.deployed.at)}{report.deployed.by ? ` · ${report.deployed.by}` : ''}</p>
            </>
          ) : (
            <p className="sysupd__hint">{T.noDeployed}</p>
          )}
        </div>

        <div className="sysupd__card">
          <h2 className="sysupd__card-title">{T.latest}</h2>
          {report?.error && <p className="sysupd__error">{report.error}</p>}
          {latest ? (
            <>
              <p className="sysupd__version">
                {latest.ref} <span className="sysupd__sha">{short(latest.sha)}</span>
                <span className="sysupd__kind">{T.kind[latest.kind]}</span>
              </p>
              {latest.subject && <p className="sysupd__subject">{latest.subject}</p>}
              <p className="sysupd__muted">{when(latest.publishedAt)}</p>
            </>
          ) : (
            <p className="sysupd__hint">{report?.tokenConfigured ? T.latestUnknown : T.needToken}</p>
          )}
        </div>
      </div>

      {/* 一鍵更新 */}
      {latest && (
        <div className="sysupd__card">
          <h2 className="sysupd__card-title">{T.actionTitle}</h2>
          {report?.updateAvailable ? (
            <p className="sysupd__behind">
              {report.behind.count > 0
                ? T.behind.replace('{n}', String(report.behind.count))
                : T.behindUnknown}
            </p>
          ) : (
            <p className="sysupd__ok">{T.upToDate}</p>
          )}

          {report && report.activeRuns !== null && report.activeRuns > 0 && (
            <p className="sysupd__warn">{T.activeRuns.replace('{n}', String(report.activeRuns))}</p>
          )}

          <p className="sysupd__danger">{T.riskNote}</p>
          <p className="sysupd__muted">{T.scopeNote}</p>

          {confirming === null ? (
            <button
              type="button"
              className="sysupd__primary"
              disabled={!canUpdate}
              onClick={() => { setConfirming(latest.ref); setConfirmRef(''); }}
            >
              {running ? T.running : T.updateTo.replace('{ref}', latest.ref)}
            </button>
          ) : (
            <div className="sysupd__confirm">
              <p>{T.confirmHint.replace('{ref}', confirming)}</p>
              <input
                className="sysupd__confirm-input"
                value={confirmRef}
                onChange={(e) => setConfirmRef(e.target.value)}
                placeholder={confirming}
                aria-label={T.confirmHint.replace('{ref}', confirming)}
              />
              <div className="sysupd__confirm-actions">
                <button type="button" className="sysupd__secondary" onClick={() => setConfirming(null)}>{T.cancel}</button>
                <button
                  type="button"
                  className="sysupd__danger-btn"
                  disabled={confirmRef.trim() !== confirming || busy}
                  onClick={() => void onUpdate(confirming, (report?.activeRuns ?? 0) > 0)}
                >
                  {busy ? T.starting : T.confirmGo}
                </button>
              </div>
            </div>
          )}

          {/* 落後的 commit 清單 */}
          {report && report.behind.commits.length > 0 && (
            <details className="sysupd__commits">
              <summary>{T.commits.replace('{n}', String(report.behind.commits.length))}</summary>
              <ul>
                {report.behind.commits.map((c) => (
                  <li key={c.sha}>
                    <code>{short(c.sha)}</code> {c.subject}
                    {c.author && <span className="sysupd__muted"> · {c.author}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* 進度 + log */}
      {build && (
        <div className="sysupd__card">
          <h2 className="sysupd__card-title">
            {T.progress} <span className="sysupd__status" data-status={build.status}>{build.status}</span>
          </h2>
          <p className="sysupd__muted">
            {build.buildId}
            {build.currentPhase ? ` · ${build.currentPhase}` : ''}
            {build.startedAt ? ` · ${when(build.startedAt)}` : ''}
          </p>
          {build.phases.length > 0 && (
            <ol className="sysupd__phases">
              {build.phases.map((p) => (
                <li key={p.name} data-status={p.status ?? ''}>
                  {p.name}{typeof p.seconds === 'number' ? ` ${p.seconds}s` : ''}
                </li>
              ))}
            </ol>
          )}
          <pre className="sysupd__log" ref={logBox}>{logLines.join('\n') || T.logEmpty}</pre>
        </div>
      )}

      {/* 歷史 */}
      <div className="sysupd__card">
        <h2 className="sysupd__card-title">{T.history}</h2>
        {history.length === 0 ? (
          <p className="sysupd__hint">{T.historyEmpty}</p>
        ) : (
          <table className="sysupd__table">
            <thead>
              <tr>
                <th>{T.thWhen}</th><th>{T.thRef}</th><th>{T.thResult}</th><th>{T.thBy}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={`${h.buildId ?? h.sha}-${i}`}>
                  <td>{when(h.at)}</td>
                  <td>{h.ref} <code>{short(h.sha)}</code>{h.subject ? <div className="sysupd__muted">{h.subject}</div> : null}</td>
                  <td><span className="sysupd__result" data-result={h.result}>{T.result[h.result]}</span></td>
                  <td>{h.by ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 已設定 token 時,也允許更換 */}
      {report?.tokenConfigured && (
        <details className="sysupd__card">
          <summary className="sysupd__card-title">{T.tokenReplace}</summary>
          <form className="sysupd__token-form" onSubmit={onSaveToken}>
            <input
              type="password"
              className="sysupd__token-input"
              value={token}
              placeholder="github_pat_…"
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
              aria-label={T.tokenReplace}
            />
            <button type="submit" className="sysupd__primary" disabled={tokenBusy || token.trim().length < 20}>
              {tokenBusy ? T.saving : T.tokenSave}
            </button>
          </form>
          <p className="sysupd__muted">{T.tokenNote}</p>
        </details>
      )}

      {/* UI-TARS 定位模型開關(SageMaker GPU,預設關閉) */}
      <UitarsPanel />
    </section>
  );
}

/** [繁中, English, 简中, 日本語, 한국어] */
type L5 = readonly [string, string, string, string, string];
const IDX: Record<string, number> = { 'zh-Hant': 0, en: 1, 'zh-Hans': 2, ja: 3, ko: 4 };
const pick = (t: L5, i: number) => t[i] ?? t[1];

function text(locale: string) {
  const i = IDX[locale] ?? 1;
  const S = {
    title: ['系統管理', 'System admin', '系统管理', 'システム管理', '시스템 관리'] as L5,
    updateSection: ['系統更新', 'System update', '系统更新', 'システム更新', '시스템 업데이트'] as L5,
    adminOnly: ['這頁只有管理員能看。', 'Admins only.', '这页只有管理员能看。', '管理者のみ利用できます。', '관리자만 사용할 수 있습니다.'] as L5,
    refresh: ['重新檢查', 'Check again', '重新检查', '再確認', '다시 확인'] as L5,
    repo: ['倉庫', 'Repository', '仓库', 'リポジトリ', '저장소'] as L5,
    deployed: ['目前部署的版本', 'Deployed version', '目前部署的版本', '現在のバージョン', '현재 배포된 버전'] as L5,
    noDeployed: ['還沒有更新紀錄(平台是以人工部署的)。跑一次更新就會把版本登記起來。', 'No update record yet (the platform was deployed by hand). Running one update records the version.', '还没有更新记录(平台是以人工部署的)。跑一次更新就会把版本登记起来。', '更新履歴がありません(手動デプロイのため)。一度更新すればバージョンが記録されます。', '업데이트 기록이 없습니다(수동 배포). 한 번 업데이트하면 버전이 기록됩니다.'] as L5,
    latest: ['GitHub 上的最新版本', 'Latest on GitHub', 'GitHub 上的最新版本', 'GitHub の最新バージョン', 'GitHub의 최신 버전'] as L5,
    latestUnknown: ['讀不到最新版本。', 'Could not read the latest version.', '读不到最新版本。', '最新バージョンを取得できません。', '최신 버전을 가져올 수 없습니다.'] as L5,
    needToken: ['需要先設定 GitHub token。', 'A GitHub token is required first.', '需要先设定 GitHub token。', 'まず GitHub トークンを設定してください。', '먼저 GitHub 토큰을 설정하세요.'] as L5,
    kind: {
      release: ['Release', 'Release', 'Release', 'Release', 'Release'] as L5,
      tag: ['Tag', 'Tag', 'Tag', 'Tag', 'Tag'] as L5,
      branch: ['分支最新 commit', 'latest commit on branch', '分支最新 commit', 'ブランチ最新コミット', '브랜치 최신 커밋'] as L5,
    },
    actionTitle: ['執行更新', 'Run an update', '执行更新', '更新を実行', '업데이트 실행'] as L5,
    behind: ['落後 {n} 個 commit。', '{n} commit(s) behind.', '落后 {n} 个 commit。', '{n} コミット遅れています。', '{n}개 커밋 뒤처져 있습니다.'] as L5,
    behindUnknown: ['有新版本可以更新。', 'A newer version is available.', '有新版本可以更新。', '新しいバージョンがあります。', '새 버전이 있습니다.'] as L5,
    upToDate: ['已經是最新版本。', 'Already up to date.', '已经是最新版本。', '最新の状態です。', '최신 상태입니다.'] as L5,
    activeRuns: [
      '注意:目前至少有 {n} 個測試任務在執行。更新會重新部署 Lambda 與前端;已經在跑的任務通常不受影響,但保險起見建議等它們結束。要繼續請再確認一次。',
      'Note: at least {n} test run(s) are in progress. An update redeploys the Lambdas and the frontend; runs already started are usually unaffected, but waiting is safer. Confirm again to proceed.',
      '注意:目前至少有 {n} 个测试任务在执行。更新会重新部署 Lambda 与前端;已经在跑的任务通常不受影响,但保险起见建议等它们结束。要继续请再确认一次。',
      '注意:少なくとも {n} 件のテストが実行中です。更新は Lambda とフロントエンドを再デプロイします。実行中のテストは通常影響を受けませんが、終了を待つ方が安全です。続けるには再度確認してください。',
      '참고: 최소 {n}개의 테스트가 실행 중입니다. 업데이트는 Lambda와 프런트엔드를 재배포합니다. 이미 시작된 실행은 보통 영향이 없지만 기다리는 편이 안전합니다. 계속하려면 다시 확인하세요.',
    ] as L5,
    riskNote: [
      '這個動作會用 CloudFormation 重新部署整個平台,包含 IAM 與資源變更,影響範圍是整個 AWS 帳號。測試沒通過就不會部署;部署失敗 CloudFormation 會自動回滾。',
      'This redeploys the whole platform through CloudFormation, including IAM and resource changes, so the blast radius is the entire AWS account. Tests gate the deploy, and CloudFormation rolls back on failure.',
      '这个动作会用 CloudFormation 重新部署整个平台,包含 IAM 与资源变更,影响范围是整个 AWS 账号。测试没通过就不会部署;部署失败 CloudFormation 会自动回滚。',
      'この操作は CloudFormation でプラットフォーム全体(IAM とリソース変更を含む)を再デプロイします。影響範囲は AWS アカウント全体です。テストが通らなければデプロイされず、失敗時は自動ロールバックされます。',
      '이 작업은 CloudFormation으로 플랫폼 전체(IAM 및 리소스 변경 포함)를 재배포합니다. 영향 범위는 AWS 계정 전체입니다. 테스트를 통과하지 못하면 배포되지 않고, 실패 시 자동 롤백됩니다.',
    ] as L5,
    scopeNote: [
      '更新範圍:前端、Lambda、runner 容器映像(只有 agent/ 有變更時才重建)。不包含更新器本身與 Windows 主機的 GameLift 應用套件,那兩個要人工部署。',
      'Covered: frontend, Lambdas, and the runner images (rebuilt only when agent/ changed). Not covered: the updater itself and the GameLift package for the Windows host — those are deployed by hand.',
      '更新范围:前端、Lambda、runner 容器镜像(只有 agent/ 有变更时才重建)。不包含更新器本身与 Windows 主机的 GameLift 应用套件,那两个要人工部署。',
      '対象:フロントエンド、Lambda、runner イメージ(agent/ に変更がある場合のみ再ビルド)。更新機能そのものと Windows ホスト用 GameLift パッケージは手動デプロイです。',
      '포함: 프런트엔드, Lambda, runner 이미지(agent/ 변경 시에만 재빌드). 업데이터 자체와 Windows 호스트용 GameLift 패키지는 수동 배포입니다.',
    ] as L5,
    updateTo: ['更新到 {ref}', 'Update to {ref}', '更新到 {ref}', '{ref} に更新', '{ref}로 업데이트'] as L5,
    running: ['更新進行中…', 'Update in progress…', '更新进行中…', '更新中…', '업데이트 진행 중…'] as L5,
    confirmHint: ['要繼續請輸入版本字串 {ref}', 'Type the version {ref} to continue', '要继续请输入版本字符串 {ref}', '続けるにはバージョン {ref} を入力', '계속하려면 버전 {ref}을 입력하세요'] as L5,
    confirmGo: ['確認更新', 'Confirm update', '确认更新', '更新を確認', '업데이트 확인'] as L5,
    cancel: ['取消', 'Cancel', '取消', 'キャンセル', '취소'] as L5,
    starting: ['啟動中…', 'Starting…', '启动中…', '開始中…', '시작 중…'] as L5,
    commits: ['查看 {n} 個 commit', 'View {n} commit(s)', '查看 {n} 个 commit', '{n} 件のコミットを見る', '{n}개 커밋 보기'] as L5,
    progress: ['更新進度', 'Update progress', '更新进度', '更新の進捗', '업데이트 진행'] as L5,
    logEmpty: ['(還沒有輸出)', '(no output yet)', '(还没有输出)', '(出力はまだありません)', '(출력이 아직 없습니다)'] as L5,
    history: ['更新歷史', 'Update history', '更新历史', '更新履歴', '업데이트 이력'] as L5,
    historyEmpty: ['還沒有更新紀錄。', 'No updates yet.', '还没有更新记录。', '更新履歴はまだありません。', '아직 업데이트 기록이 없습니다.'] as L5,
    thWhen: ['時間', 'When', '时间', '時刻', '시각'] as L5,
    thRef: ['版本', 'Version', '版本', 'バージョン', '버전'] as L5,
    thResult: ['結果', 'Result', '结果', '結果', '결과'] as L5,
    thBy: ['觸發者', 'Triggered by', '触发者', '実行者', '실행자'] as L5,
    result: {
      success: ['成功', 'Success', '成功', '成功', '성공'] as L5,
      failed: ['失敗', 'Failed', '失败', '失敗', '실패'] as L5,
      started: ['進行中', 'Started', '进行中', '実行中', '진행 중'] as L5,
    },
    tokenTitle: ['尚未設定 GitHub token', 'GitHub token not set', '尚未设定 GitHub token', 'GitHub トークン未設定', 'GitHub 토큰 미설정'] as L5,
    tokenHint: [
      '倉庫是私有的,檢查版本與下載程式都需要 token。請建立一組 fine-grained personal access token,只勾選該倉庫的 Contents: Read-only 與 Metadata: Read-only。',
      'The repository is private, so checking versions and cloning both need a token. Create a fine-grained personal access token with only Contents: Read-only and Metadata: Read-only on this repository.',
      '仓库是私有的,检查版本与下载程序都需要 token。请建立一组 fine-grained personal access token,只勾选该仓库的 Contents: Read-only 与 Metadata: Read-only。',
      'リポジトリが非公開のため、バージョン確認とクローンにトークンが必要です。該当リポジトリの Contents: Read-only と Metadata: Read-only のみを付与した fine-grained personal access token を作成してください。',
      '저장소가 비공개이므로 버전 확인과 클론에 토큰이 필요합니다. 해당 저장소에 Contents: Read-only와 Metadata: Read-only만 부여한 fine-grained personal access token을 만드세요.',
    ] as L5,
    tokenSave: ['儲存 token', 'Save token', '保存 token', 'トークンを保存', '토큰 저장'] as L5,
    tokenSaved: ['token 已儲存。', 'Token saved.', 'token 已保存。', 'トークンを保存しました。', '토큰을 저장했습니다.'] as L5,
    tokenReplace: ['更換 GitHub token', 'Replace GitHub token', '更换 GitHub token', 'GitHub トークンを変更', 'GitHub 토큰 교체'] as L5,
    tokenNote: [
      'token 存進 AWS Secrets Manager,不會回傳到瀏覽器也不會寫進 log。',
      'The token is stored in AWS Secrets Manager; it is never returned to the browser or written to logs.',
      'token 存进 AWS Secrets Manager,不会回传到浏览器也不会写进 log。',
      'トークンは AWS Secrets Manager に保存され、ブラウザへ返されることもログに出力されることもありません。',
      '토큰은 AWS Secrets Manager에 저장되며 브라우저로 반환되거나 로그에 기록되지 않습니다.',
    ] as L5,
    saving: ['儲存中…', 'Saving…', '保存中…', '保存中…', '저장 중…'] as L5,
  };
  return {
    title: pick(S.title, i),
    updateSection: pick(S.updateSection, i),
    adminOnly: pick(S.adminOnly, i),
    refresh: pick(S.refresh, i),
    repo: pick(S.repo, i),
    deployed: pick(S.deployed, i),
    noDeployed: pick(S.noDeployed, i),
    latest: pick(S.latest, i),
    latestUnknown: pick(S.latestUnknown, i),
    needToken: pick(S.needToken, i),
    kind: {
      release: pick(S.kind.release, i),
      tag: pick(S.kind.tag, i),
      branch: pick(S.kind.branch, i),
    },
    actionTitle: pick(S.actionTitle, i),
    behind: pick(S.behind, i),
    behindUnknown: pick(S.behindUnknown, i),
    upToDate: pick(S.upToDate, i),
    activeRuns: pick(S.activeRuns, i),
    riskNote: pick(S.riskNote, i),
    scopeNote: pick(S.scopeNote, i),
    updateTo: pick(S.updateTo, i),
    running: pick(S.running, i),
    confirmHint: pick(S.confirmHint, i),
    confirmGo: pick(S.confirmGo, i),
    cancel: pick(S.cancel, i),
    starting: pick(S.starting, i),
    commits: pick(S.commits, i),
    progress: pick(S.progress, i),
    logEmpty: pick(S.logEmpty, i),
    history: pick(S.history, i),
    historyEmpty: pick(S.historyEmpty, i),
    thWhen: pick(S.thWhen, i),
    thRef: pick(S.thRef, i),
    thResult: pick(S.thResult, i),
    thBy: pick(S.thBy, i),
    result: {
      success: pick(S.result.success, i),
      failed: pick(S.result.failed, i),
      started: pick(S.result.started, i),
    },
    tokenTitle: pick(S.tokenTitle, i),
    tokenHint: pick(S.tokenHint, i),
    tokenSave: pick(S.tokenSave, i),
    tokenSaved: pick(S.tokenSaved, i),
    tokenReplace: pick(S.tokenReplace, i),
    tokenNote: pick(S.tokenNote, i),
    saving: pick(S.saving, i),
  };
}
