/**
 * 系統更新(admin 專用):比對 GitHub 上的版本、觸發一鍵更新、回報進度與歷史。
 *
 * 分工:
 * - 本模組只做「驗證 + 觸發 + 查詢」,實際部署由 CodeBuild 專案執行(見 lib/updater-stack.ts)。
 * - 版本來源是 GitHub Release tag(沒有 release 時退回最新 tag,再退回預設分支最新 commit)。
 * - 倉庫已公開:查版本與下載程式都不需要 GitHub token。token 變成選用(只用來提高 GitHub API
 *   的速率限制);有存就帶、沒存就以未驗證方式呼叫,tokenConfigured 僅供介面顯示。
 *
 * 安全不變式:
 * - token 明文只在本模組記憶體內用於呼叫 GitHub,永不回傳前端、不寫 log。
 * - ref 只接受 tag / 分支 / 40 碼 sha 的安全字元,且必須真的存在於該倉庫,
 *   才會被當成 CodeBuild 環境變數傳下去(避免把任意字串帶進 shell)。
 */

/** 允許的版本字串:tag / 分支 / commit sha。長度與字元都收斂,避免注入。 */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export interface DeployedVersion {
  ref: string;
  sha: string;
  subject?: string;
  by?: string;
  buildId?: string;
  at?: string;
}

export interface RemoteVersion {
  /** 'release' | 'tag' | 'branch' —— 這個版本是怎麼來的。 */
  kind: 'release' | 'tag' | 'branch';
  ref: string;
  sha: string;
  subject?: string;
  publishedAt?: string;
  url?: string;
}

export interface CommitSummary {
  sha: string;
  subject: string;
  author?: string;
  at?: string;
}

export interface UpdateHistoryEntry {
  ref: string;
  sha: string;
  subject?: string;
  result: 'success' | 'failed' | 'started';
  by?: string;
  buildId?: string;
  at: string;
}

export interface BuildProgress {
  buildId: string;
  status: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'FAULT' | 'TIMED_OUT' | 'STOPPED' | string;
  currentPhase?: string;
  startedAt?: string;
  endedAt?: string;
  /** 各階段狀態(給介面畫進度)。 */
  phases: { name: string; status?: string; seconds?: number }[];
  logGroup?: string;
  logStream?: string;
}

/** 注入介面:讓核心邏輯可用 fake 測試,不綁死 AWS SDK 與 fetch。 */
export interface SystemUpdatePorts {
  /** 讀 GitHub token;沒設定回 null。 */
  readToken(): Promise<string | null>;
  /** 寫入 GitHub token(upsert)。 */
  writeToken(token: string): Promise<void>;
  /** 讀「已部署版本」(SSM);沒有回 null。 */
  readDeployed(): Promise<DeployedVersion | null>;
  /** 讀更新歷史(S3);沒有回 []。 */
  readHistory(): Promise<UpdateHistoryEntry[]>;
  /** 寫更新歷史(S3)。 */
  writeHistory(items: UpdateHistoryEntry[]): Promise<void>;
  /** 呼叫 GitHub REST API(path 以 / 開頭),回 { status, body }。 */
  github(path: string, token: string): Promise<{ status: number; body: unknown }>;
  /** 啟動更新 build,回 buildId。 */
  startBuild(env: { ref: string; by: string; runTests: boolean }): Promise<string>;
  /** 查最近一次(或指定)build 的進度。 */
  getBuild(buildId: string): Promise<BuildProgress | null>;
  /** 列出本專案最近的 buildId(新→舊)。 */
  listBuildIds(limit: number): Promise<string[]>;
  /** 讀 build log(回傳行與下一頁 token)。 */
  readLog(logGroup: string, logStream: string, nextToken?: string): Promise<{ lines: string[]; nextToken?: string }>;
  /** 目前是否有任務在執行(更新前警告用);無法判斷回 null。 */
  countActiveRuns?(): Promise<number | null>;
}

export class UpdateError extends Error {}

/** 版本字串驗證(格式層;存在性另外向 GitHub 確認)。 */
export function isValidRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_RE.test(ref) && !ref.includes('..');
}

/** token 是否看起來像 GitHub PAT(只做長度與字元的粗略檢查,不驗證有效性)。 */
export function looksLikeToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 20 && /^[A-Za-z0-9_-]+$/.test(value.trim());
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * 取 GitHub 上的「最新版本」。優先序:latest release → 最新 tag → 預設分支最新 commit。
 * 倉庫沒有 release 也沒有 tag 時(本專案目前就是這樣),就以預設分支的最新 commit 當版本。
 */
export async function fetchRemoteVersion(ports: SystemUpdatePorts, token: string, repo: string): Promise<RemoteVersion> {
  const rel = await ports.github(`/repos/${repo}/releases/latest`, token);
  if (rel.status === 200) {
    const r = asRecord(rel.body);
    const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
    if (tag) {
      const sha = await resolveSha(ports, token, repo, tag);
      return {
        kind: 'release',
        ref: tag,
        sha,
        ...(typeof r.name === 'string' && r.name ? { subject: r.name } : {}),
        ...(typeof r.published_at === 'string' ? { publishedAt: r.published_at } : {}),
        ...(typeof r.html_url === 'string' ? { url: r.html_url } : {}),
      };
    }
  }
  const tags = await ports.github(`/repos/${repo}/tags?per_page=1`, token);
  if (tags.status === 200 && Array.isArray(tags.body) && tags.body.length > 0) {
    const t = asRecord(tags.body[0]);
    const name = typeof t.name === 'string' ? t.name : '';
    const sha = typeof asRecord(t.commit).sha === 'string' ? (asRecord(t.commit).sha as string) : '';
    if (name && sha) return { kind: 'tag', ref: name, sha };
  }
  // 沒有 release / tag:用預設分支。
  const info = await ports.github(`/repos/${repo}`, token);
  if (info.status !== 200) throw new UpdateError(githubErrorMessage(info.status));
  const branch = typeof asRecord(info.body).default_branch === 'string' ? (asRecord(info.body).default_branch as string) : 'main';
  const commits = await ports.github(`/repos/${repo}/commits/${branch}`, token);
  if (commits.status !== 200) throw new UpdateError(githubErrorMessage(commits.status));
  const c = asRecord(commits.body);
  const commit = asRecord(c.commit);
  return {
    kind: 'branch',
    ref: branch,
    sha: typeof c.sha === 'string' ? c.sha : '',
    ...(typeof commit.message === 'string' ? { subject: String(commit.message).split('\n')[0]! } : {}),
    ...(typeof c.html_url === 'string' ? { url: c.html_url } : {}),
  };
}

async function resolveSha(ports: SystemUpdatePorts, token: string, repo: string, ref: string): Promise<string> {
  const r = await ports.github(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, token);
  if (r.status !== 200) return '';
  const sha = asRecord(r.body).sha;
  return typeof sha === 'string' ? sha : '';
}

/** 落後的 commit 清單(目前版本 → 最新版本)。取不到比較結果時回 []。 */
export async function fetchBehind(
  ports: SystemUpdatePorts,
  token: string,
  repo: string,
  base: string,
  head: string,
): Promise<{ count: number; commits: CommitSummary[] }> {
  if (!base || !head || base === head) return { count: 0, commits: [] };
  const r = await ports.github(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, token);
  if (r.status !== 200) return { count: 0, commits: [] };
  const body = asRecord(r.body);
  const raw = Array.isArray(body.commits) ? body.commits : [];
  const commits: CommitSummary[] = raw.slice(-30).reverse().map((item) => {
    const c = asRecord(item);
    const commit = asRecord(c.commit);
    const author = asRecord(commit.author);
    return {
      sha: typeof c.sha === 'string' ? c.sha : '',
      subject: typeof commit.message === 'string' ? String(commit.message).split('\n')[0]! : '',
      ...(typeof author.name === 'string' ? { author: author.name } : {}),
      ...(typeof author.date === 'string' ? { at: author.date } : {}),
    };
  });
  const count = typeof body.ahead_by === 'number' ? body.ahead_by : commits.length;
  return { count, commits };
}

function githubErrorMessage(status: number): string {
  if (status === 401) return 'GitHub token 無效或已過期';
  if (status === 403) return 'GitHub API 暫時拒絕(多半是未驗證的速率限制;可選擇性設定 token 提高限制)';
  if (status === 404) return '找不到倉庫或版本';
  return `GitHub API 回應 ${status}`;
}

export interface VersionReport {
  repo: string;
  tokenConfigured: boolean;
  deployed: DeployedVersion | null;
  latest: RemoteVersion | null;
  behind: { count: number; commits: CommitSummary[] };
  updateAvailable: boolean;
  /** 目前仍在執行的任務數(更新前警告);無法判斷為 null。 */
  activeRuns: number | null;
  /** 進行中的更新(有的話,介面直接顯示進度)。 */
  running: BuildProgress | null;
  /** 讀 GitHub 失敗時的訊息(不擋頁面顯示已部署版本)。 */
  error?: string;
}

/** 組「版本狀態」:這是管理頁開啟時唯一需要的一次呼叫。 */
export async function buildVersionReport(ports: SystemUpdatePorts, repo: string): Promise<VersionReport> {
  const [token, deployed, running, activeRuns] = await Promise.all([
    ports.readToken(),
    ports.readDeployed(),
    findRunningBuild(ports),
    ports.countActiveRuns ? ports.countActiveRuns().catch(() => null) : Promise.resolve(null),
  ]);
  const base: VersionReport = {
    repo,
    tokenConfigured: token !== null,
    deployed,
    latest: null,
    behind: { count: 0, commits: [] },
    updateAvailable: false,
    activeRuns,
    running,
  };
  // 倉庫已公開:沒有 token 也查得到 GitHub(未驗證)。token 只是用來提高速率限制。
  try {
    const latest = await fetchRemoteVersion(ports, token ?? '', repo);
    const behind = deployed?.sha ? await fetchBehind(ports, token ?? '', repo, deployed.sha, latest.sha || latest.ref) : { count: 0, commits: [] };
    return {
      ...base,
      latest,
      behind,
      // 沒有已部署版本紀錄(第一次使用)時,視為「可更新」讓管理員能先跑一次把版本登記起來。
      updateAvailable: !deployed?.sha || (latest.sha !== '' && latest.sha !== deployed.sha),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 找出進行中的更新(最近 5 次 build 內有 IN_PROGRESS 就回那一個)。 */
export async function findRunningBuild(ports: SystemUpdatePorts): Promise<BuildProgress | null> {
  try {
    const ids = await ports.listBuildIds(5);
    for (const id of ids) {
      const b = await ports.getBuild(id);
      if (b && b.status === 'IN_PROGRESS') return b;
    }
  } catch {
    /* 查不到就當沒有進行中 */
  }
  return null;
}

export interface StartUpdateInput {
  ref: string;
  by: string;
  runTests?: boolean;
  /** 有任務在跑時必須明確帶 true 才會繼續。 */
  force?: boolean;
}

/**
 * 觸發更新。會做四件檢查:token、ref 格式、ref 真的存在、沒有另一個更新在跑。
 * 有任務正在執行時需要 force(介面會先警告)。
 */
export async function startUpdate(
  ports: SystemUpdatePorts,
  repo: string,
  input: StartUpdateInput,
): Promise<{ buildId: string; ref: string; sha: string }> {
  // 倉庫已公開:更新不再需要 GitHub token。token 仍可選(僅提高 GitHub API 速率限制)。
  const token = await ports.readToken();
  if (!isValidRef(input.ref)) throw new UpdateError('版本字串格式不正確(只接受 tag / 分支 / commit sha)');

  // 早期檢查:讓使用者在按下按鈕時就看到「已經有更新在跑」,不用等。
  const running = await findRunningBuild(ports);
  if (running) throw new UpdateError(`已有更新正在執行(${running.buildId}),請等它結束`);

  if (!input.force && ports.countActiveRuns) {
    const active = await ports.countActiveRuns().catch(() => null);
    if (active && active > 0) throw new UpdateError(`目前有 ${active} 個測試任務在執行,確認要更新請再按一次`);
  }

  // 存在性檢查:避免把不存在的字串傳進 CodeBuild(那會在 build 中段才失敗)。
  const sha = await resolveSha(ports, token ?? '', repo, input.ref);
  if (!sha) throw new UpdateError(`GitHub 上找不到版本 ${input.ref}`);

  // ── 再檢查一次,就在啟動前 ──
  //
  // 上面那次檢查到這裡之間夾了一次 GitHub API 往返(數秒)。兩個人(或同一個人點兩下)
  // 都會通過第一次檢查,然後兩個 build 一起跑 —— 兩個 cdk deploy 搶同一個 changeset,
  // 第二個以 `Cannot delete ChangeSet in status CREATE_IN_PROGRESS` 失敗。
  // 實測這個專案最近 20 次 build 的 5 次失敗,每一次都是這樣來的(都在另一次成功的 7~8 秒內)。
  //
  // 把檢查壓到啟動前可以把窗口從「數秒」縮到「毫秒級」。這仍是 check-then-act,
  // 不是真正的互斥 —— 真正的互斥由 CodeBuild 專案的 concurrentBuildLimit: 1 擋
  // (見 infra/lib/updater-stack.ts)。兩層都要:這一層負責給出好的錯誤訊息,
  // 那一層負責在極端競態下真的擋住。
  const stillRunning = await findRunningBuild(ports);
  if (stillRunning) throw new UpdateError(`已有更新正在執行(${stillRunning.buildId}),請等它結束`);

  const buildId = await ports.startBuild({ ref: input.ref, by: input.by, runTests: input.runTests !== false });
  // 先記一筆 started,build 自己結束時會再補 success/failed。
  const history = await ports.readHistory().catch(() => []);
  await ports
    .writeHistory([
      { ref: input.ref, sha, result: 'started' as const, by: input.by, buildId, at: new Date().toISOString() },
      ...history,
    ].slice(0, 50))
    .catch(() => {});
  return { buildId, ref: input.ref, sha };
}
