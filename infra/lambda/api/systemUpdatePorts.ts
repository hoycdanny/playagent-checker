/**
 * systemUpdate 的真實 AWS 實作(SSM / Secrets Manager / S3 / CodeBuild / CloudWatch Logs / ECS / EC2)。
 * 核心邏輯在 systemUpdate.ts,這裡只負責把它接到 AWS,方便用 fake ports 做單元測試。
 */
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand, ListBuildsForProjectCommand,
} from '@aws-sdk/client-codebuild';
import { CloudWatchLogsClient, GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { ECSClient, ListClustersCommand, ListTasksCommand } from '@aws-sdk/client-ecs';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import type { SecretWriter } from './secretValueStore.js';
import type { BuildProgress, DeployedVersion, SystemUpdatePorts, UpdateHistoryEntry } from './systemUpdate.js';

export interface SystemUpdateConfig {
  region: string;
  bucket: string;
  /** 更新歷史的 S3 key。 */
  historyKey: string;
  /** 已部署版本的 SSM 參數名。 */
  stateParam: string;
  /** GitHub token 的 secret 名。 */
  secretName: string;
  /** CodeBuild 專案名。 */
  projectName: string;
}

/** GitHub REST API 版本(釘住,避免未來預設改版讓回傳格式變動)。 */
const GITHUB_API_VERSION = '2022-11-28';

export function makeSystemUpdatePorts(cfg: SystemUpdateConfig, secretWriter: SecretWriter, s3: S3Client): SystemUpdatePorts {
  const ssm = new SSMClient({ region: cfg.region });
  const codebuild = new CodeBuildClient({ region: cfg.region });
  const logsClient = new CloudWatchLogsClient({ region: cfg.region });
  const ecs = new ECSClient({ region: cfg.region });
  const ec2 = new EC2Client({ region: cfg.region });

  return {
    async readToken() {
      // getSecretJson 讀不到或非 JSON 都回 {};也接受純字串存法。
      const obj = await secretWriter.getSecretJson(cfg.secretName);
      const token = obj.token ?? obj.GITHUB_TOKEN;
      return typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
    },

    async writeToken(token: string) {
      await secretWriter.putSecretValue(cfg.secretName, JSON.stringify({ token }));
    },

    async readDeployed(): Promise<DeployedVersion | null> {
      try {
        const r = await ssm.send(new GetParameterCommand({ Name: cfg.stateParam }));
        const raw = r.Parameter?.Value ?? '';
        if (!raw) return null;
        const v = JSON.parse(raw) as DeployedVersion;
        return typeof v?.sha === 'string' ? v : null;
      } catch {
        return null;
      }
    },

    async readHistory(): Promise<UpdateHistoryEntry[]> {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: cfg.historyKey }));
        const text = (await r.Body?.transformToString()) ?? '[]';
        const items = JSON.parse(text);
        return Array.isArray(items) ? items : [];
      } catch {
        return [];
      }
    },

    async writeHistory(items: UpdateHistoryEntry[]) {
      await s3.send(new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: cfg.historyKey,
        Body: JSON.stringify(items),
        ContentType: 'application/json',
      }));
    },

    async github(path: string, token: string) {
      // 倉庫已公開:沒有 token 也能呼叫(未驗證有較低速率限制);有 token 才帶 Authorization。
      const res = await fetch(`https://api.github.com${path}`, {
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          accept: 'application/vnd.github+json',
          'x-github-api-version': GITHUB_API_VERSION,
          'user-agent': 'playagent-checker-updater',
        },
      });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    },

    async startBuild({ ref, by, runTests }) {
      const r = await codebuild.send(new StartBuildCommand({
        projectName: cfg.projectName,
        environmentVariablesOverride: [
          { name: 'PA_REF', value: ref, type: 'PLAINTEXT' },
          { name: 'PA_BY', value: by, type: 'PLAINTEXT' },
          { name: 'PA_RUN_TESTS', value: runTests ? '1' : '0', type: 'PLAINTEXT' },
        ],
      }));
      const id = r.build?.id;
      if (!id) throw new Error('StartBuild 未回傳 build id');
      return id;
    },

    async getBuild(buildId: string): Promise<BuildProgress | null> {
      let r;
      try {
        r = await codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }));
      } catch (err) {
        // CodeBuild 對格式不符的 id(非 project:uuid)會丟 InvalidInputException。
        // 這是「查不到」而不是系統故障,回 null 讓路由給 404。
        if (err instanceof Error && (err.name === 'InvalidInputException' || err.name === 'ResourceNotFoundException')) return null;
        throw err;
      }
      const b = r.builds?.[0];
      if (!b) return null;
      return {
        buildId: b.id ?? buildId,
        status: b.buildStatus ?? 'IN_PROGRESS',
        ...(b.currentPhase ? { currentPhase: b.currentPhase } : {}),
        ...(b.startTime ? { startedAt: b.startTime.toISOString() } : {}),
        ...(b.endTime ? { endedAt: b.endTime.toISOString() } : {}),
        phases: (b.phases ?? []).map((p) => ({
          name: p.phaseType ?? '?',
          ...(p.phaseStatus ? { status: p.phaseStatus } : {}),
          ...(typeof p.durationInSeconds === 'number' ? { seconds: p.durationInSeconds } : {}),
        })),
        ...(b.logs?.groupName ? { logGroup: b.logs.groupName } : {}),
        ...(b.logs?.streamName ? { logStream: b.logs.streamName } : {}),
      };
    },

    async listBuildIds(limit: number) {
      const r = await codebuild.send(new ListBuildsForProjectCommand({ projectName: cfg.projectName, sortOrder: 'DESCENDING' }));
      return (r.ids ?? []).slice(0, limit);
    },

    async readLog(logGroup: string, logStream: string, nextToken?: string) {
      const r = await logsClient.send(new GetLogEventsCommand({
        logGroupName: logGroup,
        logStreamName: logStream,
        startFromHead: true,
        limit: 500,
        ...(nextToken ? { nextToken } : {}),
      }));
      return {
        lines: (r.events ?? []).map((e) => e.message?.replace(/\n$/, '') ?? ''),
        ...(r.nextForwardToken ? { nextToken: r.nextForwardToken } : {}),
      };
    },

    /**
     * 更新前的警告用:數「現在有幾個測試在跑」。
     * 看 Fargate task(Device Farm / Web runner)與帶 playagent:jobId 標籤的 EC2(Redroid)。
     * GameLift 的 stream session 不算在內(SDK 版本在 Lambda runtime 不保證存在),
     * 所以這個數字是下限,不是精確值 —— 介面上寫成「至少 n 個」。
     */
    async countActiveRuns(): Promise<number | null> {
      try {
        let n = 0;
        const clusters = (await ecs.send(new ListClustersCommand({}))).clusterArns ?? [];
        for (const cluster of clusters) {
          const tasks = await ecs.send(new ListTasksCommand({ cluster, desiredStatus: 'RUNNING' }));
          n += (tasks.taskArns ?? []).length;
        }
        const inst = await ec2.send(new DescribeInstancesCommand({
          Filters: [
            { Name: 'instance-state-name', Values: ['pending', 'running'] },
            { Name: 'tag-key', Values: ['playagent:jobId'] },
          ],
        }));
        n += (inst.Reservations ?? []).flatMap((r) => r.Instances ?? []).length;
        return n;
      } catch {
        return null;
      }
    },
  };
}

/** 讓 updater 的 SSM 參數名/專案名等設定從環境變數組出來(CDK 注入)。 */
export function systemUpdateConfigFromEnv(env: NodeJS.ProcessEnv, region: string, bucket: string): SystemUpdateConfig | null {
  const projectName = env.UPDATE_PROJECT_NAME ?? '';
  const stateParam = env.DEPLOYED_VERSION_PARAM ?? '';
  const secretName = env.GITHUB_SECRET_NAME ?? '';
  if (!projectName || !stateParam || !secretName) return null;
  return {
    region,
    bucket,
    historyKey: env.UPDATE_HISTORY_KEY ?? '_system/update-history.json',
    stateParam,
    secretName,
    projectName,
  };
}
