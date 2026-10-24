import {
  GameLiftStreamsClient,
  StartStreamSessionCommand,
  TerminateStreamSessionCommand,
} from '@aws-sdk/client-gameliftstreams';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import { keepAliveConfigured, startKeepAlive } from './keepAliveHost.js';

/**
 * Windows 執行環境 = Amazon GameLift Streams(Windows Server 2022 runtime + NVIDIA GPU)。
 *
 * 每個測試開一個「沒有人連線」的 stream session(SignalRequest = NO_CLIENT_CONNECTION):
 * GameLift 在 GPU 主機上執行應用的 launcher.bat → host.ps1(worker/windows-host/gamelift/),
 * host.ps1 下載 runner 與遊戲、解開、跑 explorationRunner.mjs(PA_DRIVER=windows),
 * 截圖 / 輸入在同一個桌面完成,AI 直接從主機呼叫 Bedrock。runner 寫終態後 host.ps1 結束應用 → session 結束。
 *
 * 實測限制(2026-10 PoC):
 * - 解析度:寬高皆偶數,總像素 ≤ 2,073,600(1920×1080);直式 1080×1920 可以,1080×4096 不行。
 * - 沒有 client 連線的 session 會在 ConnectionTimeoutSeconds(最大 3600)後被終止 → 單次最長約 60 分鐘。
 *   要跑更久就得有一個 client 連著:超過一小時的任務會連帶啟動一個保活 Fargate task
 *   (keepAliveHost.ts),它接上 session 並掛著。保活沒配置或起不來時退回一小時。
 *
 * Application / Stream Group 由 worker/windows-host/gamelift/setup.mjs 建立,ID 寫在 SSM:
 *   ${WINDOWS_GLS_PARAM_PREFIX}/applicationId、${WINDOWS_GLS_PARAM_PREFIX}/streamGroupId
 */

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const PARAM_PREFIX = process.env.WINDOWS_GLS_PARAM_PREFIX ?? '/playagent/windows-gls';
const ROLE_ARN = process.env.WINDOWS_GLS_ROLE_ARN ?? '';

/** GameLift Streams 單一 session 的總像素上限。 */
export const MAX_PIXELS = 2_073_600;
/**
 * 沒有 client 連線時 session 的最長存活時間(秒)= ConnectionTimeoutSeconds 的上限。
 *
 * 這個 3600 是 AWS 強制的,不是我們保守取的值。實測送更大的值會被擋:
 *   Value '7200' at 'connectionTimeoutSeconds' failed to satisfy constraint:
 *   Member must have value less than or equal to 3600
 */
export const MAX_UNATTENDED_SECONDS = 3600;
/**
 * GameLift Streams 對 SessionLengthSeconds 的上限(24 小時)。
 *
 * 與上面那個是**兩件不同的事**,原本被設成同一個值,等於自己把 session 壽命壓到一小時:
 *   ConnectionTimeoutSeconds 只是「等 client 連線或重連」的窗口,從 ACTIVE 起算,
 *     時間內沒有 client 連上就終止。
 *   SessionLengthSeconds 是 session 的硬性總長,**不管有沒有 client 連著**。
 * 所以有保活 client 時,壽命由後者決定;沒有保活時,前者會先把它收掉。
 */
export const MAX_SESSION_SECONDS = 86_400;

export interface WindowsRunSpec {
  tenantId: string;
  jobId: string;
  appId: string;
  bucket: string;
  prefix: string;
  /** 遊戲資料夾 key(artifacts/<id>/,內含 game.exe 或 game.zip)。 */
  artifactKey: string;
  /** 遊戲執行檔(App identifier;相對路徑或檔名,空 = host.ps1 自動挑最大的 exe)。 */
  package?: string;
  vlmModel?: string;
  agentModel?: string;
  subagentModel?: string;
  maxSteps?: number;
  display?: { width: number; height: number };
  /** 期望執行分鐘數(會被壓到 GameLift Streams 的上限;見 sessionSeconds)。 */
  maxMinutes?: number;
}

/**
 * 算出要送給 GameLift Streams 的兩個時間參數。
 *
 * 刻意分開:
 *   session    = SessionLengthSeconds,session 的硬性總長(上限 24 小時)
 *   connection = ConnectionTimeoutSeconds,等 client 連線的窗口(上限 3600,AWS 強制)
 *
 * 沒有保活 client 時,實際壽命 = min(兩者) = 最多一小時,**與解耦前完全相同**;
 * 有保活時才吃得到使用者選的長時數。
 *
 * 回傳兩個不同的時間,不要混用:
 *   effective = 預期的實際壽命,用來告訴使用者「這次最長跑多久」
 *   deadline  = runner 初始的收尾時刻,**永遠保守**(= min(session, connection))
 *
 * 為什麼 deadline 不跟著 effective 變長:`RunTask` 成功不等於保活真的連上(映像拉不到、
 * WebRTC 出不去都可能),而 deadline 給太長的後果是最糟的那一種 —— session 被 GameLift
 * 收掉,runner 卻以為還有好幾小時,任務停在「執行中」而且沒有報告。所以 deadline 從保守值
 * 起算,由保活 task 一邊跑一邊用 S3 上的租約往後推(見 agent/glsKeepAlive.mjs 的
 * leaseDeadlineMs)。保活死掉 → 租約停止更新 → runner 自然退回保守行為。
 */
export function sessionSeconds(maxMinutes: number | undefined, keepAlive = false): {
  session: number;
  connection: number;
  effective: number;
  deadline: number;
} {
  // Number.isFinite 的檢查不能省:Math.max(600, NaN) 是 NaN,不是 600。
  // job.json 裡的 maxHours 一旦壞掉(舊任務、手改過的資料),就會送 NaN 給 API。
  const raw = Number(maxMinutes);
  const minutes = Number.isFinite(raw) ? raw : 60;
  const want = Math.max(600, Math.round(minutes * 60));
  const session = Math.min(MAX_SESSION_SECONDS, want);
  const connection = MAX_UNATTENDED_SECONDS;
  return {
    session,
    connection,
    effective: keepAlive ? session : Math.min(session, connection),
    deadline: Math.min(session, connection),
  };
}

/** 解析度校驗(與 API 端相同規則;engine 再擋一次,避免舊 job 帶入非法值)。 */
export function normalizeDisplay(d?: { width?: number; height?: number }): { width: number; height: number } {
  const w = Number(d?.width), h = Number(d?.height);
  if (!Number.isInteger(w) || !Number.isInteger(h)) return { width: 1920, height: 1080 };
  if (w % 2 || h % 2 || w < 320 || h < 320 || w > 4096 || h > 4096 || w * h > MAX_PIXELS) {
    throw new Error(`Windows 解析度 ${w}x${h} 不合法(寬高需為偶數、320~4096,且總像素 ≤ ${MAX_PIXELS})`);
  }
  return { width: w, height: h };
}

/** 測試設定經環境變數交給 host.ps1(任務描述可能很長,由 host.ps1 自己讀 job.json 的 caseTask)。 */
export function buildEnv(spec: WindowsRunSpec, dataRegion: string): Record<string, string> {
  const env: Record<string, string> = {
    PA_JOB: spec.jobId,
    PA_TENANT: spec.tenantId,
    PA_APP: spec.appId,
    PA_BUCKET: spec.bucket,
    PA_PREFIX: spec.prefix,
    PA_DATA_REGION: dataRegion,
    PA_ARTIFACT_KEY: spec.artifactKey,
  };
  if (spec.package) env.PA_PKG = spec.package;
  if (spec.vlmModel) env.PA_VLM = spec.vlmModel;
  if (spec.agentModel) env.PA_AGENT_MODEL = spec.agentModel;
  if (spec.subagentModel) env.PA_SUBAGENT_MODEL = spec.subagentModel;
  if (spec.maxSteps) env.PA_MAXSTEPS = String(spec.maxSteps);
  return env;
}

async function readIds(): Promise<{ applicationId: string; streamGroupId: string }> {
  const ssm = new SSMClient({ region: REGION });
  const names = [`${PARAM_PREFIX}/applicationId`, `${PARAM_PREFIX}/streamGroupId`];
  const r = await ssm.send(new GetParametersCommand({ Names: names }));
  const get = (n: string) => r.Parameters?.find((p) => p.Name === n)?.Value ?? '';
  const applicationId = get(names[0]!), streamGroupId = get(names[1]!);
  if (!applicationId || !streamGroupId) {
    throw new Error(`Windows 環境尚未建立(SSM ${PARAM_PREFIX}/* 不存在);請先執行 worker/windows-host/gamelift/setup.mjs`);
  }
  return { applicationId, streamGroupId };
}

/**
 * 要不要為這次任務啟動保活。
 *
 * 兩個條件都要:使用者真的要求超過一小時,而且保活環境已經配置好。
 * 第二個條件不能省 —— 映像還沒推上去的舊部署仍該能跑 Windows 任務(退回一小時),
 * 而不是因為少了一個 Fargate task definition 就整個任務失敗。
 */
export function wantsKeepAlive(maxMinutes: number | undefined, configured: boolean): boolean {
  const raw = Number(maxMinutes);
  if (!Number.isFinite(raw)) return false;
  return raw * 60 > MAX_UNATTENDED_SECONDS && configured;
}

/** 開 session(不等 ACTIVE;host.ps1 會自己寫 status)。回傳 session ARN 與實際上限分鐘數。 */
export async function startWindowsRun(spec: WindowsRunSpec, dataRegion: string): Promise<{ arn: string; minutes: number; display: { width: number; height: number }; keepAlive: boolean }> {
  if (!ROLE_ARN) throw new Error('Windows 主機角色未配置(WINDOWS_GLS_ROLE_ARN)');
  const { applicationId, streamGroupId } = await readIds();
  const display = normalizeDisplay(spec.display);
  const keepAlive = wantsKeepAlive(spec.maxMinutes, keepAliveConfigured());
  const t = sessionSeconds(spec.maxMinutes, keepAlive);
  // 租約的 key 也是「保活有沒有啟動」的開關:runner 只有在收到它時才會去讀租約,
  // 其他後端與沒有保活的 Windows 任務完全不受影響。
  const leaseKey = `${spec.prefix}/lease.json`;
  const gl = new GameLiftStreamsClient({ region: REGION });
  const res = await gl.send(
    new StartStreamSessionCommand({
      Identifier: streamGroupId,
      ApplicationIdentifier: applicationId,
      Protocol: 'WebRTC',
      SignalRequest: 'NO_CLIENT_CONNECTION',
      Description: spec.jobId,
      UserId: spec.tenantId.slice(0, 1024),
      SessionLengthSeconds: t.session,
      ConnectionTimeoutSeconds: t.connection,
      DisplayConfiguration: { Resolution: { Width: display.width, Height: display.height } },
      RoleArn: ROLE_ARN,
      // PA_DEADLINE_MS:runner 在 session 被 GameLift 終止前 5 分鐘自己收尾寫報告,
      // 不然 session 到時被直接收掉,任務會停在「執行中」且沒有報告。
      // 用 t.deadline(保守值)而不是 t.effective:有保活時由租約往後推,
      // 保活沒連上就維持保守值 —— 兩種情況都寫得出報告。
      AdditionalEnvironmentVariables: {
        ...buildEnv(spec, dataRegion),
        PA_DEADLINE_MS: String(Date.now() + (t.deadline - 300) * 1000),
        ...(keepAlive ? { PA_LEASE_KEY: leaseKey } : {}),
      },
    }),
  );
  if (!res.Arn) throw new Error('StartStreamSession 未回傳 session ARN');

  if (keepAlive) {
    try {
      await startKeepAlive({
        streamGroupId,
        sessionArn: res.Arn,
        bucket: spec.bucket,
        prefix: spec.prefix,
        sessionEndMs: Date.now() + t.session * 1000,
      });
    } catch (err) {
      // session 已經開了,但沒有人會連它。放著不管的結果是:GameLift 一小時後收掉它,
      // 而任務停在「執行中」且沒有報告。所以收掉 session 再把錯誤往上丟,
      // 讓 engine 寫一筆明確的 error —— 使用者看得懂「保活起不來」,看不懂一個卡住的任務。
      await gl.send(new TerminateStreamSessionCommand({
        Identifier: streamGroupId, StreamSessionIdentifier: res.Arn,
      })).catch(() => { /* 收不掉也只能讓它自己超時 */ });
      throw new Error(`長時測試的保活 task 啟動失敗,已收掉 session:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { arn: res.Arn, minutes: Math.round(t.effective / 60), display, keepAlive };
}
