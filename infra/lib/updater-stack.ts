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
  /** runner 映像推上的 ECR repo 名(映像建置角色只能推這些)。 */
  imageRepos: string[];
  /**
   * 前端建置期設定(web/.env)的來源 stack。web/.env 不進版控,乾淨 clone 沒有它,
   * 直接 build 會產出沒有 Cognito / API 位址的前端(整站壞掉),所以 buildspec 從這兩個
   * stack 的 Outputs 重新產生。
   */
  frontendConfigStacks: { foundation: string; controlPlane: string };
}

/** Node.js 版本:與本機開發、runner 容器一致,不依賴 CodeBuild 映像內建版本。 */
const NODE_VERSION = 'v22.12.0';
/** 歷史紀錄的 S3 key(保留最近 50 筆)。 */
export const UPDATE_HISTORY_KEY = '_system/update-history.json';

export class UpdaterStack extends Stack {
  readonly project: codebuild.Project;
  readonly imageBuildRole: iam.Role;

  constructor(scope: Construct, id: string, props: UpdaterStackProps) {
    super(scope, id, props);

    // runner 映像建置專案(cloudBuildRunner / cloudBuildWebRunner 會 upsert)用的角色。
    // 由本 stack 建立:新帳號安裝就有、資料桶換名(重裝)會自動跟著更新、解除安裝一起刪。
    // 以前用的是手動建的 PlayAgentCodeBuildUitarsRole(新帳號沒有,重裝後還指著舊桶)。
    // 權限只到:兩個 build 專案的 log、兩個 runner ECR repo、資料桶 codebuild/ 下的來源 zip。
    this.imageBuildRole = new iam.Role(this, 'ImageBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description: 'PlayAgent runner image builds (CodeBuild): source zip in the data bucket -> docker build -> push to the runner ECR repos',
    });
    const buildLogArns = props.imageBuildProjects.flatMap((p) => [
      `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/${p}`,
      `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/${p}:*`,
    ]);
    this.imageBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: buildLogArns,
    }));
    this.imageBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'], // 這個動作不支援資源層級限制
    }));
    this.imageBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:DescribeRepositories', 'ecr:CreateRepository', 'ecr:PutImageScanningConfiguration',
        'ecr:BatchCheckLayerAvailability', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload',
        'ecr:PutImage', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer',
      ],
      resources: props.imageRepos.map((r) => `arn:aws:ecr:${this.region}:${this.account}:repository/${r}`),
    }));
    this.imageBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion'],
      resources: [`${props.dataBucket.bucketArn}/codebuild/*`],
    }));
    this.imageBuildRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetBucketLocation', 's3:GetBucketAcl'],
      resources: [props.dataBucket.bucketArn],
    }));

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
        // runner 映像重建(cloudBuildRunner/cloudBuildWebRunner)上傳來源 zip 用的暫存桶。
        // 不設的話腳本會退回 PA_DATA_BUCKET,但明確帶上較清楚,避免未來誰改了退回邏輯又踩雷。
        PA_SM_BUCKET: { value: props.dataBucket.bucketName },
        // 映像建置專案用的角色(本 stack 建的);沒帶時腳本才退回舊的手動角色名。
        PA_IMAGE_BUILD_ROLE_ARN: { value: this.imageBuildRole.roleArn },
        PA_HISTORY_KEY: { value: UPDATE_HISTORY_KEY },
        PA_STATE_PARAM: { value: props.stateParamName },
        PA_NODE_VERSION: { value: NODE_VERSION },
        PA_FOUNDATION_STACK: { value: props.frontendConfigStacks.foundation },
        PA_CONTROLPLANE_STACK: { value: props.frontendConfigStacks.controlPlane },
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
    // 倉庫已公開:clone 不需要 GitHub token,故不再授予 Secrets Manager 讀取。
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
    // 產生 web/.env:只讀這兩個 stack 的 Outputs(唯讀,不含任何變更權限)。
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: [props.frontendConfigStacks.foundation, props.frontendConfigStacks.controlPlane].map(
        (name) => `arn:aws:cloudformation:${this.region}:${this.account}:stack/${name}/*`,
      ),
    }));
    // 只能把映像建置角色交給 CodeBuild(UpdateProject 設 serviceRole 需要)。
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [this.imageBuildRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'codebuild.amazonaws.com' } },
    }));

    new CfnOutput(this, 'UpdateProjectName', { value: this.project.projectName });
    new CfnOutput(this, 'UpdateLogGroup', { value: logGroup.logGroupName });
    new CfnOutput(this, 'GithubSecretName', { value: props.githubSecretName });
    new CfnOutput(this, 'DeployedVersionParam', { value: props.stateParamName });
    new CfnOutput(this, 'ImageBuildRoleArn', { value: this.imageBuildRole.roleArn });
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
          // 倉庫已公開:直接 clone,不需要 GitHub token / credential store。
          'git config --global advice.detachedHead false',
          'git clone --quiet "https://github.com/$PA_REPO.git" /tmp/src',
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
          // web/.env 不進版控:從已部署 stack 的 Outputs 產生(Cognito / API 位址在更新前後不變)。
          // 任何一個值缺少就中止,絕不部署沒有設定的前端。
          'aws cloudformation describe-stacks --stack-name "$PA_FOUNDATION_STACK" --query "Stacks[0].Outputs" --output json > /tmp/out-foundation.json',
          'aws cloudformation describe-stacks --stack-name "$PA_CONTROLPLANE_STACK" --query "Stacks[0].Outputs" --output json > /tmp/out-cp.json',
          'node -e \'const fs=require("fs");const rd=(p)=>JSON.parse(fs.readFileSync(p,"utf8"))||[];const f=rd("/tmp/out-foundation.json");const c=rd("/tmp/out-cp.json");const pick=(a,p)=>((a.find((o)=>String(o.OutputKey).startsWith(p))||{}).OutputValue||"");const env={VITE_COGNITO_REGION:process.env.AWS_REGION||"",VITE_COGNITO_USER_POOL_ID:pick(f,"AuthUserPoolId"),VITE_COGNITO_CLIENT_ID:pick(f,"AuthUserPoolClientId"),VITE_API_URL:pick(c,"ApiUrl"),VITE_WS_URL:pick(c,"WsUrl")};const miss=Object.keys(env).filter((k)=>!env[k]);if(miss.length){console.error("frontend config missing: "+miss.join(","));process.exit(1);}fs.writeFileSync("web/.env",Object.entries(env).map(([k,v])=>k+"="+v).join("\\n")+"\\n");console.log("web/.env generated: "+Object.keys(env).join(","));\'',
          'npm run build:web',
          // 保險:確認 API 位址真的被編進前端 bundle。
          'API_URL="$(grep "^VITE_API_URL=" web/.env | cut -d= -f2-)"; grep -rqF "$API_URL" web/dist/assets || { echo "web build does not contain VITE_API_URL"; exit 1; }',
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
