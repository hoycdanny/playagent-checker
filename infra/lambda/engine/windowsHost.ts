import {
  GameLiftStreamsClient,
  StartStreamSessionCommand,
} from '@aws-sdk/client-gameliftstreams';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

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
 *
 * Application / Stream Group 由 worker/windows-host/gamelift/setup.mjs 建立,ID 寫在 SSM:
 *   ${WINDOWS_GLS_PARAM_PREFIX}/applicationId、${WINDOWS_GLS_PARAM_PREFIX}/streamGroupId
 */

const REGION = process.env.AWS_REGION ?? 'us-west-2';
const PARAM_PREFIX = process.env.WINDOWS_GLS_PARAM_PREFIX ?? '/playagent/windows-gls';
const ROLE_ARN = process.env.WINDOWS_GLS_ROLE_ARN ?? '';

/** GameLift Streams 單一 session 的總像素上限。 */
export const MAX_PIXELS = 2_073_600;
/** 沒有 client 連線時 session 的最長存活時間(秒;= ConnectionTimeoutSeconds 上限)。 */
export const MAX_UNATTENDED_SECONDS = 3600;

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
  /** 期望執行分鐘數(會被壓到 MAX_UNATTENDED_SECONDS)。 */
  maxMinutes?: number;
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

/** 開 session(不等 ACTIVE;host.ps1 會自己寫 status)。回傳 session ARN 與實際上限分鐘數。 */
export async function startWindowsRun(spec: WindowsRunSpec, dataRegion: string): Promise<{ arn: string; minutes: number; display: { width: number; height: number } }> {
  if (!ROLE_ARN) throw new Error('Windows 主機角色未配置(WINDOWS_GLS_ROLE_ARN)');
  const { applicationId, streamGroupId } = await readIds();
  const display = normalizeDisplay(spec.display);
  const seconds = Math.min(MAX_UNATTENDED_SECONDS, Math.max(600, Math.round((spec.maxMinutes ?? 60) * 60)));
  const gl = new GameLiftStreamsClient({ region: REGION });
  const res = await gl.send(
    new StartStreamSessionCommand({
      Identifier: streamGroupId,
      ApplicationIdentifier: applicationId,
      Protocol: 'WebRTC',
      SignalRequest: 'NO_CLIENT_CONNECTION',
      Description: spec.jobId,
      UserId: spec.tenantId.slice(0, 1024),
      SessionLengthSeconds: seconds,
      ConnectionTimeoutSeconds: MAX_UNATTENDED_SECONDS,
      DisplayConfiguration: { Resolution: { Width: display.width, Height: display.height } },
      RoleArn: ROLE_ARN,
      // PA_DEADLINE_MS:runner 在 session 被 GameLift 終止前 5 分鐘自己收尾寫報告,
      // 不然 session 到時被直接收掉,任務會停在「執行中」且沒有報告。
      AdditionalEnvironmentVariables: { ...buildEnv(spec, dataRegion), PA_DEADLINE_MS: String(Date.now() + (seconds - 300) * 1000) },
    }),
  );
  if (!res.Arn) throw new Error('StartStreamSession 未回傳 session ARN');
  return { arn: res.Arn, minutes: Math.round(seconds / 60), display };
}
