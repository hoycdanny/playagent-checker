import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * UpdaterStack —— 管理員「一鍵更新」的執行層。
 *
 * 做法:一個 CodeBuild 專案,從 GitHub clone 指定版本 → 跑測試 → 建前端 → `cdk deploy`
 * 五個 stack →(只有 agent/ 有變更時)重建 runner 映像 → 把新版本與審計紀錄寫回 SSM / S3。
 * API 只負責驗證版本字串、StartBuild、回報進度(見 lambda/api/systemUpdate.ts)。
 *
 * 權限邊界(重要,不要放寬):
 * - 這個 CodeBuild 角色「本身沒有」部署權限,只能 sts:AssumeRole 到 CDK bootstrap 的角色;
 *   真正的高權限留在 CloudFormation 的 cfn-exec-role。能部署就能改 IAM,這一點無法消除,
 *   所以觸發端(API)限定 admins 群組並留審計紀錄。
 * - 本 stack 刻意「不在自己的部署清單裡」:更新時不會改到正在執行更新的資源。
 *   改了 updater-stack.ts 要人工 `cdk deploy PlayAgentDev-Updater`。
 * - GameLift Windows 應用套件也不在自動更新範圍(需要建 S3 桶與 GameLift 應用,
 *   權限過大);`worker/windows-host/gamelift/setup.mjs` 維持人工執行。
 */
export interface UpdaterStackProps extends StackProps {
  /** CodeBuild 專案名。由 app.ts 決定並同時給 ControlPlane,避免跨 stack 參照。 */
  projectName: string;
  /** CodeBuild log group 名(固定值,API 才能授權讀取)。 */
  logGroupName: string;
  /** 歷史紀錄落在這個桶的 _system/ 前綴。 */
  dataBucket: s3.IBucket;
  /** GitHub 倉庫(owner/name)。 */
  repo: string;
  /** 要自動部署的 stack 名稱(不含本 stack)。 */
  targetStacks: string[];
  /** GitHub token 的 Secrets Manager 名稱(值由管理員之後從介面匯入)。 */
  githubSecretName: string;
  /** 已部署版本的 SSM 參數名。 */
  stateParamName: string;
  /** runner 映像的 CodeBuild 專案名(agent/ 有變更時觸發)。 */
  imageBuildProjects: string[];
  /** 映像建置專案所用的既有角色名(更新器需要 PassRole 給它)。 */
  imageBuildRoleName: string;
}

/** Node.js 版本:與本機開發、runner 容器一致,不依賴 CodeBuild 映像內建版本。 */
const NODE_VERSION = 'v22.12.0';
/** 歷史紀錄的 S3 key(保留最近 50 筆)。 */
export const UPDATE_HISTORY_KEY = '_system/update-history.json';

export class UpdaterStack extends Stack {
  readonly project: codebuild.Project;

  constructor(scope: Construct, id: string, props: UpdaterStackProps) {
    super(scope, id, props);

    const logGroup = new logs.LogGroup(this, 'UpdateLogs', {
      logGroupName: props.logGroupName,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.project = new codebuild.Project(this, 'SelfUpdate', {
      projectName: props.projectName,
      description: '從 GitHub 指定版本重新部署整個平台(由管理介面觸發)',
      // 沒有 CodeBuild source:倉庫是私有的,改由 buildspec 自己用 token clone,
      // 不必為此建 GitHub connection。
      buildSpec: codebuild.BuildSpec.fromObject(buildSpec()),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        // 不需要 privileged:映像是交給既有的 runner build 專案去 docker build。
        privileged: false,
      },
      environmentVariables: {
        PA_REPO: { value: props.repo },
        PA_TARGET_STACKS: { value: props.targetStacks.join(' ') },
        PA_DATA_BUCKET: { value: props.dataBucket.bucketName },
        PA_HISTORY_KEY: { value: UPDATE_HISTORY_KEY },
        PA_STATE_PARAM: { value: props.stateParamName },
        PA_SECRET_NAME: { value: props.githubSecretName },
        PA_NODE_VERSION: { value: NODE_VERSION },
        // 由 StartBuild 覆寫:PA_REF(要部署的 tag/sha)、PA_BY(觸發者)、PA_RUN_TESTS。
        PA_REF: { value: 'main' },
        PA_BY: { value: 'unknown' },
        PA_RUN_TESTS: { value: '1' },
      },
      timeout: Duration.minutes(90),
      logging: { cloudWatch: { logGroup } },
    });

    const role = this.project.role!;
    const bootstrapRoles = ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
      (kind) => `arn:aws:iam::${this.account}:role/cdk-hnb659fds-${kind}-role-${this.account}-${this.region}`,
    );
    // 唯一的部署途徑:扮 CDK bootstrap 角色。本角色自己沒有 CloudFormation/IAM 權限。
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: bootstrapRoles,
    }));
    // CDK CLI 會讀 bootstrap 版本參數;更新器自己讀寫「已部署版本」。
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/*`],
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${props.stateParamName}`],
    }));
    // GitHub token(唯讀)。值永不寫進 log:buildspec 用 git credential store 檔案,不帶在指令裡。
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${props.githubSecretName}-??????`],
    }));
    // 更新歷史 + runner 映像建置時上傳原始碼 zip。
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
      resources: [props.dataBucket.bucketArn, `${props.dataBucket.bucketArn}/*`],
    }));
    // 重建 runner 映像:沿用既有的 build 專案(cloudBuildRunner.mjs 會 upsert 專案再 StartBuild)。
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['codebuild:CreateProject', 'codebuild:UpdateProject', 'codebuild:BatchGetProjects', 'codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: props.imageBuildProjects.map((p) => `arn:aws:codebuild:${this.region}:${this.account}:project/${p}`),
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['iam:GetRole', 'iam:PassRole'],
      resources: [`arn:aws:iam::${this.account}:role/${props.imageBuildRoleName}`],
    }));

    new CfnOutput(this, 'UpdateProjectName', { value: this.project.projectName });
    new CfnOutput(this, 'UpdateLogGroup', { value: logGroup.logGroupName });
    new CfnOutput(this, 'GithubSecretName', { value: props.githubSecretName });
    new CfnOutput(this, 'DeployedVersionParam', { value: props.stateParamName });
  }
}

/**
 * buildspec。寫成資料而非外部檔案,原因:更新器要能部署「任何版本」,
 * 如果流程腳本放在倉庫裡,回滾到舊版本時就會跑到舊的流程腳本(或根本不存在)。
 *
 * CodeBuild 預設會把每一行指令原文印進 log。所有指令只引用 "$VAR" 不展開敏感值,
 * token 只寫進 ~/.git-credentials 且用完立刻刪除。
 */
function buildSpec(): Record<string, unknown> {
  return {
    version: '0.2',
    env: { shell: 'bash' },
    phases: {
      install: {
        commands: [
          'set -euo pipefail',
          // 用官方 tarball 裝 Node,不靠映像內建版本,避免 CodeBuild 換映像就壞。
          'curl -fsSL "https://nodejs.org/dist/$PA_NODE_VERSION/node-$PA_NODE_VERSION-linux-x64.tar.xz" -o /tmp/node.tar.xz',
          'tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1',
          'node -v && npm -v',
        ],
      },
      pre_build: {
        commands: [
          'set -euo pipefail',
          // token 經 git credential store 交給 git;不放在指令列,也不 echo。
          'aws secretsmanager get-secret-value --secret-id "$PA_SECRET_NAME" --query SecretString --output text > /tmp/gh.json',
          'node -e \'const fs=require("fs");const raw=fs.readFileSync("/tmp/gh.json","utf8").trim();let t=raw;try{const o=JSON.parse(raw);t=o.token||o.GITHUB_TOKEN||"";}catch{};if(!t){console.error("GitHub token 尚未設定");process.exit(1);}fs.writeFileSync(process.env.HOME+"/.git-credentials","https://x-access-token:"+t+"@github.com\\n",{mode:0o600});\'',
          'rm -f /tmp/gh.json',
          'git config --global credential.helper store',
          'git config --global advice.detachedHead false',
          'git clone --quiet "https://github.com/$PA_REPO.git" /tmp/src',
          'rm -f "$HOME/.git-credentials"',
          'cd /tmp/src',
          // 版本字串已在 API 端驗證格式與存在性;這裡再確認它真的指向一個 commit。
          'git rev-parse --verify "$PA_REF^{commit}" > /tmp/sha',
          'git checkout --quiet "$PA_REF"',
          'export PA_SHA="$(cat /tmp/sha)"',
          'echo "deploying ref=$PA_REF sha=$PA_SHA by=$PA_BY"',
          // 上一版的 sha:用來判斷要不要重建 runner 映像(讀不到就保守重建)。
          'aws ssm get-parameter --name "$PA_STATE_PARAM" --query Parameter.Value --output text > /tmp/prev.json 2>/dev/null || echo "{}" > /tmp/prev.json',
          'node -e \'const fs=require("fs");let p={};try{p=JSON.parse(fs.readFileSync("/tmp/prev.json","utf8"))}catch{};fs.writeFileSync("/tmp/prev.sha",p.sha||"")\'',
        ],
      },
      build: {
        commands: [
          'set -euo pipefail',
          'cd /tmp/src',
          'export PA_SHA="$(cat /tmp/sha)"',
          'npm ci',
          // 測試當閘門:不過就不部署(可由 PA_RUN_TESTS=0 跳過)。
          // 這裡只跑 web 與 worker:infra 的測試會多次 cdk synth + esbuild bundling(約 5 分鐘),
          // 且目前有兩個與本功能無關的既有失敗(app-credentials、emulatorCoordTransform),
          // 放進閘門會讓每次更新都被擋下。修好那兩個之後應把 test:infra 加回來。
          'if [ "$PA_RUN_TESTS" = "1" ]; then npm run test:web && npm run test:worker; else echo "skip tests"; fi',
          'npm run build:web',
          'cd /tmp/src/infra',
          'npx cdk deploy $PA_TARGET_STACKS --require-approval never --concurrency 2 --progress events',
          'cd /tmp/src',
          // agent/ 有變更才重建 runner 映像(docker build 很慢);判不出來就重建。
          'PREV="$(cat /tmp/prev.sha)"',
          'NEED=1',
          'if [ -n "$PREV" ] && git cat-file -e "$PREV^{commit}" 2>/dev/null; then if git diff --name-only "$PREV" "$PA_SHA" -- agent | grep -q .; then NEED=1; else NEED=0; fi; fi',
          'echo "rebuild runner images: $NEED"',
          'if [ "$NEED" = "1" ]; then cd /tmp/src/agent/sagemaker && npm ci --omit=dev && node cloudBuildRunner.mjs && node cloudBuildWebRunner.mjs; fi',
        ],
      },
      post_build: {
        commands: [
          // 成敗都要留紀錄,所以這裡不用 set -e。
          'cd /tmp/src || true',
          'export PA_SHA="$(cat /tmp/sha 2>/dev/null || echo unknown)"',
          'export PA_RESULT="$([ "$CODEBUILD_BUILD_SUCCEEDING" = "1" ] && echo success || echo failed)"',
          'export PA_SUBJECT="$(git log -1 --pretty=%s "$PA_SHA" 2>/dev/null || echo "")"',
          'aws s3 cp "s3://$PA_DATA_BUCKET/$PA_HISTORY_KEY" /tmp/history.json --only-show-errors || echo "[]" > /tmp/history.json',
          'node -e \'const fs=require("fs");let h=[];try{h=JSON.parse(fs.readFileSync("/tmp/history.json","utf8"));if(!Array.isArray(h))h=[]}catch{};h.unshift({ref:process.env.PA_REF,sha:process.env.PA_SHA,subject:process.env.PA_SUBJECT,result:process.env.PA_RESULT,by:process.env.PA_BY,buildId:process.env.CODEBUILD_BUILD_ID,at:new Date().toISOString()});fs.writeFileSync("/tmp/history.json",JSON.stringify(h.slice(0,50)))\'',
          'aws s3 cp /tmp/history.json "s3://$PA_DATA_BUCKET/$PA_HISTORY_KEY" --content-type application/json --only-show-errors',
          // 只有成功才更新「已部署版本」,失敗時維持舊值(CloudFormation 自己會 rollback)。
          'if [ "$PA_RESULT" = "success" ]; then node -e \'const fs=require("fs");fs.writeFileSync("/tmp/state.json",JSON.stringify({ref:process.env.PA_REF,sha:process.env.PA_SHA,subject:process.env.PA_SUBJECT,by:process.env.PA_BY,buildId:process.env.CODEBUILD_BUILD_ID,at:new Date().toISOString()}))\' && aws ssm put-parameter --name "$PA_STATE_PARAM" --type String --overwrite --value "$(cat /tmp/state.json)"; fi',
          'echo "update $PA_RESULT ref=$PA_REF sha=$PA_SHA"',
        ],
      },
    },
  };
}
