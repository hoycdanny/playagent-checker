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

const app = new App();
const cfg = resolveConfig(app);
const { env, stackPrefix } = cfg;

// 有狀態基礎(Cognito / 資料桶 / 租戶角色)。
const foundation = new FoundationStack(app, `${stackPrefix}-Foundation`, {
  env,
  ...(cfg.initialAdmin ? { initialAdmin: cfg.initialAdmin } : {}),
});

// 執行引擎(Web 後端 Lambda)—— 需資料桶與租戶角色。
const execution = new ExecutionStack(app, `${stackPrefix}-Execution`, {
  env,
  dataBucket: foundation.dataBucket,
  tenantRole: foundation.tenantDataRole.role,
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
});

// 前端(S3 + CloudFront)—— 階段 0 已可佈署。
const frontend = new FrontendStack(app, `${stackPrefix}-Frontend`, { env });

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
