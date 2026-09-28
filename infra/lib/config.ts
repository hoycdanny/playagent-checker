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
  };
}
