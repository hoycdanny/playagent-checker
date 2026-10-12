#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { resolveConfig } from '../lib/config.js';
import {
  FoundationStack,
  KB_VECTOR_BUCKET_PREFIX,
  KB_EMBEDDING_MODEL_ID,
} from '../lib/foundation-stack.js';
import { ControlPlaneStack } from '../lib/control-plane-stack.js';
import { SchedulingStack } from '../lib/scheduling-stack.js';
import { ExecutionStack } from '../lib/execution-stack.js';
import { FrontendStack } from '../lib/frontend-stack.js';
import { UpdaterStack, UPDATE_HISTORY_KEY } from '../lib/updater-stack.js';

const app = new App();
const cfg = resolveConfig(app);
const { env, stackPrefix } = cfg;

// 一鍵更新用到的固定名稱:同時給 Updater(建資源)與 ControlPlane(授權 + 呼叫),
// 用字面字串而非跨 stack 參照,這樣任一方都能單獨部署,不會因為缺 export 而卡住。
const UPDATE_PROJECT_NAME = `${stackPrefix}-self-update`;
const UPDATE_LOG_GROUP = `/playagent/${stackPrefix}/update`;
const GITHUB_SECRET_NAME = 'playagent/github';
const DEPLOYED_VERSION_PARAM = `/playagent/${stackPrefix}/deployed-version`;
// UI-TARS 固定 endpoint 名:系統管理頁的開關、引擎(傳給 runner)都用這個名字,開關不需重新部署。
// 與 Execution stack 讀的 cdk context `uitarsEndpoint` 是同一個值。
const UITARS_ENDPOINT_NAME = (app.node.tryGetContext('uitarsEndpoint') as string | undefined) ?? 'ui-tars-playagent';
const GITHUB_REPO = (app.node.tryGetContext('githubRepo') as string | undefined) ?? 'hoycdanny/playagent-checker';
// 一鍵部署傳入 Git SHA tag,讓 ECS task definition 不依賴可變的 latest。
const RUNNER_IMAGE_TAG = (app.node.tryGetContext('runnerImageTag') as string | undefined) ?? 'latest';
// cdk destroy 會 Retain ECR;重裝時安裝器傳 true,Execution 改採 import 而非建立同名 repo。
const USE_EXISTING_RUNNER_REPOS = String(app.node.tryGetContext('existingRunnerRepos') ?? '').toLowerCase() === 'true';

// 有狀態基礎(Cognito / 資料桶 / 租戶角色)。
const foundation = new FoundationStack(app, `${stackPrefix}-Foundation`, { env });

// 執行引擎(Web 後端 Lambda)—— 需資料桶與租戶角色。
const execution = new ExecutionStack(app, `${stackPrefix}-Execution`, {
  env,
  dataBucket: foundation.dataBucket,
  tenantRole: foundation.tenantDataRole.role,
  runnerImageTag: RUNNER_IMAGE_TAG,
  useExistingRunnerRepos: USE_EXISTING_RUNNER_REPOS,
  // 成本標籤(含 stage + 部署者帶入)傳給引擎,供執行期 EC2/Fargate 動態貼標。
  costTags: { stage: cfg.stage, component: 'execution', ...cfg.costTags },
});
// 引擎需 bedrock:Retrieve 檢索共用知識庫(Stage B)。
foundation.kbFoundation; // 確保 KB 基礎已建(同 stack,無循環依賴)

// 排程(SQS 分派 + 分派器)—— 分派器直接 Invoke 引擎。
const scheduling = new SchedulingStack(app, `${stackPrefix}-Scheduling`, {
  env,
  engineFn: execution.engineFn,
});

// 控制面(API / 租戶隔離)—— 以直接物件參照取用其他 stack 產出(不用 context 串接)。
const controlPlane = new ControlPlaneStack(app, `${stackPrefix}-ControlPlane`, {
  env,
  userPool: foundation.userPool,
  userPoolClient: foundation.userPoolClient,
  dataBucket: foundation.dataBucket,
  tenantRole: foundation.tenantDataRole.role,
  dispatchQueue: scheduling.dispatchQueue,
  // Bedrock KB(Stage B):runtime 建 KB 需把服務角色傳給 Bedrock(iam:PassRole)。
  kbServiceRoleArn: foundation.kbFoundation.serviceRole.roleArn,
  kbVectorBucketPrefix: KB_VECTOR_BUCKET_PREFIX,
  kbEmbeddingModelId: KB_EMBEDDING_MODEL_ID,
  // UI-TARS 開關(系統管理頁,預設關閉):API 依固定名稱建/刪 SageMaker endpoint。
  uitars: {
    endpointName: UITARS_ENDPOINT_NAME,
    instanceType: (app.node.tryGetContext('uitarsInstance') as string | undefined) ?? 'ml.g6e.xlarge',
    image: `${env.account}.dkr.ecr.${env.region}.amazonaws.com/playagent-vllm-byoc:latest`,
    modelDataS3: `s3://${foundation.dataBucket.bucketName}/sagemaker-models/ui-tars/`,
    executionRoleArn:
      (app.node.tryGetContext('uitarsRoleArn') as string | undefined)
      ?? `arn:aws:iam::${env.account}:role/ArtSmokerSageMakerRole`,
    tags: { project: 'playagent-checker', stage: cfg.stage, component: 'uitars', ...cfg.costTags },
  },
  // 一鍵更新:API 負責驗證與觸發,實際部署在 Updater stack。
  updater: {
    projectName: UPDATE_PROJECT_NAME,
    logGroupName: UPDATE_LOG_GROUP,
    githubSecretName: GITHUB_SECRET_NAME,
    deployedVersionParam: DEPLOYED_VERSION_PARAM,
    historyKey: UPDATE_HISTORY_KEY,
    repo: GITHUB_REPO,
  },
});

// 前端(S3 + CloudFront)—— 階段 0 已可佈署。
const frontend = new FrontendStack(app, `${stackPrefix}-Frontend`, { env });

// 一鍵更新(管理介面觸發):CodeBuild 從 GitHub 指定版本重新部署下面這五個 stack。
// 本 stack 刻意不在自己的部署清單裡 —— 更新時不改到正在跑更新的資源;
// 改了 updater-stack.ts 要人工 `cdk deploy <prefix>-Updater`。
const updater = new UpdaterStack(app, `${stackPrefix}-Updater`, {
  env,
  projectName: UPDATE_PROJECT_NAME,
  logGroupName: UPDATE_LOG_GROUP,
  dataBucket: foundation.dataBucket,
  repo: GITHUB_REPO,
  targetStacks: [
    `${stackPrefix}-Foundation`,
    `${stackPrefix}-Execution`,
    `${stackPrefix}-Scheduling`,
    `${stackPrefix}-ControlPlane`,
    `${stackPrefix}-Frontend`,
  ],
  githubSecretName: GITHUB_SECRET_NAME,
  stateParamName: DEPLOYED_VERSION_PARAM,
  // 必須與 agent/sagemaker/cloudBuildRunner.mjs、cloudBuildWebRunner.mjs 的 PROJECT 常數一致。
  imageBuildProjects: ['playagent-runner-build', 'playagent-web-runner-build'],
  imageBuildRoleName: 'PlayAgentCodeBuildUitarsRole',
  frontendConfigStacks: {
    foundation: `${stackPrefix}-Foundation`,
    controlPlane: `${stackPrefix}-ControlPlane`,
  },
});

// 統一標記,便於成本歸屬與治理(CDK 最佳實踐)。
// - project / stage / component 為系統保留標籤(自動帶,供費用分析頁依 component 分組)。
// - 部署者可經 context 帶入 costCenter / owner / team / env / costAllocation(見 config.ts COST_TAG_KEYS),
//   套到所有資源;於 AWS Billing 主控台「啟用」為 Cost Allocation Tag 後即可在 Cost Explorer 分組。
const stackComponents: { stack: import('aws-cdk-lib').Stack; component: string }[] = [
  { stack: foundation, component: 'foundation' },
  { stack: controlPlane, component: 'control-plane' },
  { stack: scheduling, component: 'scheduling' },
  { stack: execution, component: 'execution' },
  { stack: frontend, component: 'frontend' },
  { stack: updater, component: 'updater' },
];
for (const { stack, component } of stackComponents) {
  Tags.of(stack).add('project', 'playagent-checker');
  Tags.of(stack).add('stage', cfg.stage);
  Tags.of(stack).add('component', component);
  // 部署者帶入的成本標籤(可能為空)。
  for (const [key, value] of Object.entries(cfg.costTags)) {
    Tags.of(stack).add(key, value);
  }
}
