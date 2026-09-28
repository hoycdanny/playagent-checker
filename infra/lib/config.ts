import type { Environment } from 'aws-cdk-lib';

/**
 * 部署環境設定。單帳號 dev 為主,但保留 stage 概念以便日後擴充。
 * 帳號與區域一律由 CDK 標準環境變數注入(CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION),
 * 不硬編碼於程式中(CDK 最佳實踐:環境設定注入)。
 */
export interface AppConfig {
  /** 部署階段代號,如 "dev"。 */
  readonly stage: string;
  /** stack 名稱前綴,用於區分同帳號下不同 stage 的資源。 */
  readonly stackPrefix: string;
  /** CDK 部署目標環境(帳號 + 區域)。 */
  readonly env: Environment;
  /** 由部署者帶入的成本分攤標籤(cost allocation tags),套用到所有資源。 */
  readonly costTags: Record<string, string>;
}

/**
 * 允許部署者透過 context 帶入的成本分攤標籤鍵。
 * 用法:`cdk deploy -c costCenter=QA-1234 -c owner=alice -c team=game-qa -c env=prod`
 * 這些標籤會套到所有 stack 的資源上,啟用為 Cost Allocation Tag 後即可在 Cost Explorer 依此分組。
 * 注意:`project` / `stage` / `component` 為系統保留標籤(自動帶),不由此覆寫。
 */
export const COST_TAG_KEYS = ['costCenter', 'owner', 'team', 'env', 'costAllocation'] as const;

/**
 * 從 context 解析部署者帶入的成本標籤(只收 COST_TAG_KEYS 內、且有非空值者)。
 */
function resolveCostTags(app: {
  node: { tryGetContext(key: string): unknown };
}): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const key of COST_TAG_KEYS) {
    const val = app.node.tryGetContext(key);
    if (typeof val === 'string' && val.trim().length > 0) {
      tags[key] = val.trim();
    }
  }
  return tags;
}

/**
 * 由 CDK context 與標準環境變數解析出部署設定。
 * 用法:`cdk deploy -c stage=dev`(未指定則預設 dev)。
 */
export function resolveConfig(app: {
  node: { tryGetContext(key: string): unknown };
}): AppConfig {
  const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';

  const envMap =
    (app.node.tryGetContext('playagent:env') as
      | Record<string, { stackPrefix?: string }>
      | undefined) ?? {};
  const stageCfg = envMap[stage];
  const stackPrefix = stageCfg?.stackPrefix ?? `PlayAgent-${stage}`;

  return {
    stage,
    stackPrefix,
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    costTags: resolveCostTags(app),
  };
}
