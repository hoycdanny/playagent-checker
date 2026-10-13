/**
 * 集中式日誌的真實 AWS 實作(CloudWatch Logs)。核心邏輯在 systemLogs.ts,這裡只負責:
 *  - 依命名前綴探索本平台相關的 log group(DescribeLogGroups,分頁);
 *  - 用 CloudWatch Logs Insights 啟動查詢(StartQuery)與取結果(GetQueryResults)。
 */
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import type { SystemLogsPorts } from './systemLogs.js';

export interface SystemLogsConfig {
  region: string;
  /** 本次部署的 stage 前綴(= stack 前綴,如 "PlayAgentDev"),用來組探索前綴。 */
  stagePrefix: string;
}

/**
 * 探索這些前綴底下的 log group:
 *  - /aws/lambda/<stage>-        → API / 引擎 / 分派器 / WebSocket 等所有平台 Lambda
 *  - /playagent/<stage>          → ECS runner(固定名)、系統更新 CodeBuild
 *  - /aws/codebuild/playagent-   → runner 映像建置、安裝器
 */
function prefixes(stage: string): string[] {
  return [`/aws/lambda/${stage}-`, `/playagent/${stage}`, '/aws/codebuild/playagent-'];
}

export function makeSystemLogsPorts(cfg: SystemLogsConfig): SystemLogsPorts {
  const client = new CloudWatchLogsClient({ region: cfg.region });

  return {
    async listGroups() {
      const out = new Map<string, { logGroupName: string }>();
      for (const prefix of prefixes(cfg.stagePrefix)) {
        let nextToken: string | undefined;
        // 每個前綴最多翻幾頁就停,避免異常情況下無限分頁。
        for (let page = 0; page < 20; page++) {
          const r = await client.send(new DescribeLogGroupsCommand({
            logGroupNamePrefix: prefix,
            limit: 50,
            ...(nextToken ? { nextToken } : {}),
          }));
          for (const g of r.logGroups ?? []) {
            if (g.logGroupName) out.set(g.logGroupName, { logGroupName: g.logGroupName });
          }
          nextToken = r.nextToken;
          if (!nextToken) break;
        }
      }
      return [...out.values()];
    },

    async startQuery({ logGroupNames, startSec, endSec, queryString }) {
      const r = await client.send(new StartQueryCommand({
        logGroupNames,
        startTime: startSec,
        endTime: endSec,
        queryString,
        limit: 10000,
      }));
      if (!r.queryId) throw new Error('StartQuery 未回傳 queryId');
      return r.queryId;
    },

    async getQuery(queryId: string) {
      const r = await client.send(new GetQueryResultsCommand({ queryId }));
      return {
        status: r.status ?? 'Unknown',
        results: (r.results ?? []).map((row) =>
          row.map((f) => ({ field: f.field ?? '', value: f.value ?? '' }))),
        ...(r.statistics?.recordsMatched !== undefined
          ? { recordsMatched: r.statistics.recordsMatched }
          : {}),
      };
    },
  };
}

/** 從環境變數組出設定;未設 LOG_STAGE_PREFIX 則回 null(/system/logs/* 會回 501)。 */
export function systemLogsConfigFromEnv(env: NodeJS.ProcessEnv, region: string): SystemLogsConfig | null {
  const stagePrefix = env.LOG_STAGE_PREFIX ?? '';
  if (!stagePrefix) return null;
  return { region, stagePrefix };
}
