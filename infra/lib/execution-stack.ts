import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Source } from 'aws-cdk-lib/aws-s3-deployment';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { PerJobHost } from './constructs/per-job-host.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** 官方 Ubuntu 24.04 AMI 的 SSM public parameter(部署時解析成具體 AMI ID)。 */
const UBUNTU_ARM64_SSM =
  '/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id';
const UBUNTU_X86_SSM =
  '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id';

export interface ExecutionStackProps extends StackProps {
  dataBucket: s3.IBucket;
  tenantRole: iam.IRole;
  /** cdk destroy 後 ECR 被 Retain:重裝時匯入既有固定名稱 repo,避免 already exists。 */
  useExistingRunnerRepos?: boolean;
  /** runner 映像不可變 tag(一鍵部署傳 Git SHA);手動開發部署預設 latest。 */
  runnerImageTag?: string;
  /** 成本分攤標籤(project/stage/component + 部署者帶入),序列化後傳給引擎供執行期資源貼標。 */
  costTags?: Record<string, string>;
}

/** 每任務主機的生命週期標籤鍵/值。常駐主機不帶此標籤,故不被回收路徑觸及(Req 4.5)。 */
export const HOST_LIFECYCLE_TAG = 'hostLifecycle';
export const HOST_LIFECYCLE_PER_JOB = 'per-job';

/** Device Farm / 容器 runner 的 Fargate 資源(含 XAPK 合併所需的 JVM 記憶體與暫存空間)。 */
export const EXPLORATION_RUNNER_CPU = 2048;
export const EXPLORATION_RUNNER_MEMORY_MIB = 8192;
export const EXPLORATION_RUNNER_STORAGE_GIB = 40;

/**
 * ExecutionStack —— 執行引擎(階段 5:Web 後端以 Lambda 承載)。
 * 引擎 Lambda 由分派器直接 Invoke(非 SQS ESM),扮演租戶角色讀寫該租戶前綴,
 * 執行後寫終態 status。長時 / 裝置後端(AgentCore / Redroid / Windows)於後續階段接入。
 */
export class ExecutionStack extends Stack {
  readonly engineFn: NodejsFunction;
  readonly vpc: ec2.Vpc;
  readonly emulatorHost: PerJobHost;
  readonly windowsHost: PerJobHost;

  constructor(scope: Construct, id: string, props: ExecutionStackProps) {
    super(scope, id, props);

    // 集中式日誌:給兩個 Fargate runner 固定的 log group 名稱(/playagent/<stage>/runner-*),
    // 讓系統管理頁的日誌檢視能用命名前綴探索到它們(Lambda 群組靠 /aws/lambda/<stage>- 探索)。
    const logStage = this.stackName.replace(/-Execution$/, '');

    // 裝置主機所在 VPC。natGateways:0 —— 純 VPC + subnet 不計費(避免 NAT/EIP 成本);
    // 每任務主機置於帶 S3 Gateway Endpoint 的 isolated 子網,經內網存取 S3。
    this.vpc = new ec2.Vpc(this, 'DeviceVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    // 主機經 Gateway Endpoint 存取 S3(不需 NAT)。
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // 每任務裝置主機骨架(IAM 角色 + SG)。實際 RunInstances 由引擎動態發起。
    this.emulatorHost = new PerJobHost(this, 'EmulatorHost', {
      vpc: this.vpc,
      kind: 'emulator',
    });
    this.windowsHost = new PerJobHost(this, 'WindowsHost', {
      vpc: this.vpc,
      kind: 'windows',
    });

    // emulator 主機自驅動所需權限:讀自身 tag、扮租戶角色(帶 tenantId session tag)讀寫
    // 該租戶前綴、直接讀 _engine/ 下的 runner、以及自我終結(限帶 per-job 標籤的實例)。
    const emuRole = this.emulatorHost.hostRole;
    emuRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeTags'],
        resources: ['*'],
      }),
    );
    // 主機是單一 job 專屬且短生命週期:直接用實例 profile 存取資料桶(讀 _engine runner、
    // 讀該 job 的 job.json/APK、寫該 job 的 status/steps/screenshots)與 Bedrock(VLM 判座標)。
    emuRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
        resources: [props.dataBucket.bucketArn, `${props.dataBucket.bucketArn}/*`],
      }),
    );
    emuRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:*:${Stack.of(this).account}:inference-profile/*`,
        ],
      }),
    );
    // 主機跑完自我終結(限帶 per-job 標籤者)。
    emuRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:TerminateInstances'],
        resources: ['*'],
        conditions: {
          StringEquals: { [`aws:ResourceTag/${HOST_LIFECYCLE_TAG}`]: HOST_LIFECYCLE_PER_JOB },
        },
      }),
    );
    // 新 runner(與 Device Farm 同一套)會讀測試憑證、可選用 UI-TARS。
    emuRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:*:${Stack.of(this).account}:secret:playagent/tenant/*`],
      }),
    );
    const emuProfile = new iam.CfnInstanceProfile(this, 'EmulatorHostProfile', {
      roles: [emuRole.roleName],
    });

    // 部署主機自驅動 runner 到 s3://<bucket>/_engine/emulatorRunner.mjs(主機 userdata 拉取)。
    new s3deploy.BucketDeployment(this, 'EngineRunnerDeploy', {
      destinationBucket: props.dataBucket,
      destinationKeyPrefix: '_engine',
      sources: [
        Source.asset(path.join(currentDir, '..', 'lambda', 'engine'), {
          exclude: ['**', '!emulatorRunner.mjs'],
        }),
      ],
      prune: false,
    });

    // AI runner(agent/*.mjs,與 Device Farm 容器同一份)→ s3://<bucket>/_engine/runner/;Redroid 主機開機時下載執行。
    new s3deploy.BucketDeployment(this, 'AgentRunnerDeploy', {
      destinationBucket: props.dataBucket,
      destinationKeyPrefix: '_engine/runner',
      sources: [
        Source.asset(path.join(currentDir, '..', '..', 'agent'), {
          // 只帶頂層 runner 模組(+ Windows 驅動 WinHelper.cs / winHost.ps1);子資料夾一律排除。
          exclude: ['**', '!*.mjs', '!exploration-runner.package.json', '!WinHelper.cs', '!winHost.ps1', '_*.mjs', '*/**'],
        }),
      ],
      prune: true,
    });

    // Redroid 主機的主體腳本 → s3://<bucket>/_engine/emulator/run.sh。
    //
    // 為什麼不放在 userdata 裡:EC2 userdata 有 16 KB 硬上限,而那支腳本曾經長到只剩
    // 583 bytes 可用。超過的症狀很糟 —— RunInstances 直接被拒,或腳本被截斷後在主機上
    // 語法錯誤,兩種都不會明確說「太長了」。拆出來之後 userdata 只剩引導(約 4.5 KB),
    // 而主體要加東西(例如 per-app 快照的還原與打包)不再受限。
    new s3deploy.BucketDeployment(this, 'EmulatorScriptDeploy', {
      destinationBucket: props.dataBucket,
      destinationKeyPrefix: '_engine/emulator',
      sources: [Source.asset(path.join(currentDir, '..', 'lambda', 'engine', 'emulator'))],
      prune: true,
    });

    // 解析官方 Ubuntu AMI(部署時 SSM 解析成 AMI ID)。
    const amiArm64 = ssm.StringParameter.valueForTypedStringParameterV2(
      this,
      UBUNTU_ARM64_SSM,
      ssm.ParameterValueType.AWS_EC2_IMAGE_ID,
    );
    const amiX86 = ssm.StringParameter.valueForTypedStringParameterV2(
      this,
      UBUNTU_X86_SSM,
      ssm.ParameterValueType.AWS_EC2_IMAGE_ID,
    );
    // emulator 主機用 public 子網 + 公網 IP 出網拉 apt/docker/redroid(免 NAT 費用)。
    const publicSubnetId = this.vpc.publicSubnets[0]!.subnetId;

    this.engineFn = new NodejsFunction(this, 'EngineFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(currentDir, '..', 'lambda', 'engine', 'index.ts'),
      handler: 'handler',
      // Web 慢節奏逐步流程;單次上限 15 分鐘足夠(超時的長工作走 AgentCore)。
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        TENANT_ROLE_ARN: props.tenantRole.roleArn,
        // UI-TARS(SageMaker)VLM grounding endpoint。值由 CDK context 提供(cdk.json 或 --context uitarsEndpoint=...),
        // 空字串代表未接 UI-TARS(VLM 會 fallback 到所選 Bedrock 模型)。寫進 code 才不會每次 deploy 被清空。
        UITARS_ENDPOINT: (this.node.tryGetContext('uitarsEndpoint') as string | undefined) ?? '',
        // 成本分攤標籤(JSON):執行期動態起的 EC2 / Fargate 用它貼標(見 lambda/engine/costTags.ts)。
        COST_TAGS: JSON.stringify({
          project: 'playagent-checker',
          ...(props.costTags ?? {}),
        }),
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        // 打包進來的 AWS SDK(gameliftstreams / ssm)內部有 CJS 的 require('node:https');
        // ESM 輸出沒有 require,需要補一個 createRequire 的 shim,否則執行時會丟
        // 「Dynamic require of "node:https" is not supported」。
        banner: "import{createRequire as __paCreateRequire}from'module';const require=__paCreateRequire(import.meta.url);",
        // 預設會把 @aws-sdk/* 全部當成 Lambda runtime 內建;GameLift Streams 的 RoleArn(2026-07)/ SSM 用打包的版本,
        // 不依賴 runtime 內建 SDK 的版本。其餘 client 仍用 runtime 內建。
        externalModules: [
          '@aws-sdk/client-bedrock-runtime', '@aws-sdk/client-bedrock-agent', '@aws-sdk/client-bedrock-agent-runtime',
          '@aws-sdk/client-device-farm', '@aws-sdk/client-ec2', '@aws-sdk/client-ecs', '@aws-sdk/client-s3',
          '@aws-sdk/client-s3vectors', '@aws-sdk/client-secrets-manager', '@aws-sdk/client-sts', '@aws-sdk/client-lambda',
          '@aws-sdk/client-sqs', '@aws-sdk/client-apigatewaymanagementapi', '@aws-sdk/client-cognito-identity-provider',
          '@aws-sdk/client-cost-explorer', '@aws-sdk/s3-request-presigner',
        ],
        // emulator-userdata.sh 是執行期以 readFileSync 讀取的資產,需隨 bundle 複製到輸出目錄。
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => {
            // 跨平台複製:bundling 命令交給本機 shell 執行,Windows 的 cmd.exe 無 `cp`,改用 `copy`。
            const src = path.join(inputDir, 'infra', 'lambda', 'engine', 'emulator-userdata.sh');
            const dest = path.join(outputDir, 'emulator-userdata.sh');
            return process.platform === 'win32'
              ? [`copy /Y "${src}" "${dest}"`]
              : [`cp "${src}" "${dest}"`];
          },
        },
      },
    });

    // 引擎扮演租戶角色(session tag tenantId)讀寫該租戶前綴。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [props.tenantRole.roleArn],
      }),
    );

    // 共用知識庫(shared/*)唯讀:引擎執行時讀取選定知識庫的 Markdown 注入上下文。
    // 跨租戶共用資源,故用引擎自身角色直接讀 shared/ 前綴(唯讀),不經租戶隔離角色。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [`${props.dataBucket.bucketArn}/shared/*`],
      }),
    );
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [props.dataBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['shared/*'] } },
      }),
    );

    // Bedrock KB 檢索(Stage B):引擎執行時對選定 KB 發 Retrieve 撈相關片段。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:Retrieve'],
        resources: [`arn:aws:bedrock:*:${Stack.of(this).account}:knowledge-base/*`],
      }),
    );

    // App 憑證:engine 組 context 時讀 secret 以「列出 key 名」注入(值不進 context/log)。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:*:${Stack.of(this).account}:secret:playagent/tenant/*`],
      }),
    );

    // 報告的 AI 敘述預生成需呼叫 Bedrock。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:*:${Stack.of(this).account}:inference-profile/*`,
        ],
      }),
    );

    // 每任務裝置主機的動態起停(Req 4.3/4.6)。
    // RunInstances 會觸及多種資源(instance/volume 會被打 tag;network-interface/subnet/
    // security-group/image/key-pair 等基礎資源不會)。帶 RequestTag 條件的授權只能套在
    // 「會被打 tag 的資源」上,基礎資源必須無條件允許 —— 否則 RunInstances 因基礎資源
    // (如 network-interface/*)無授權而整體 AccessDenied。
    const region = Stack.of(this).region;
    const account = Stack.of(this).account;
    // 1) instance:要求帶 per-job 標籤(RequestTag 條件;emulatorHost 的 TagSpecifications
    //    對 instance 打此標籤)。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:RunInstances'],
        resources: [`arn:aws:ec2:${region}:${account}:instance/*`],
        conditions: {
          StringEquals: { [`aws:RequestTag/${HOST_LIFECYCLE_TAG}`]: HOST_LIFECYCLE_PER_JOB },
        },
      }),
    );
    // 2) RunInstances 觸及的其餘資源:無條件允許。volume 隨 instance 終結、且 RunInstances 不會
    //    把 instance 的 tag 套到 volume(除非 TagSpec 對 volume 另指定),故不加 request tag 條件;
    //    network-interface/subnet/security-group/image/key-pair 本就不帶 request tag。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:RunInstances'],
        resources: [
          `arn:aws:ec2:${region}:${account}:volume/*`,
          `arn:aws:ec2:${region}::image/*`,
          `arn:aws:ec2:${region}:${account}:network-interface/*`,
          `arn:aws:ec2:${region}:${account}:subnet/*`,
          `arn:aws:ec2:${region}:${account}:security-group/*`,
          `arn:aws:ec2:${region}:${account}:key-pair/*`,
        ],
      }),
    );
    // 3) 起機當下打 tag(RunInstances 內嵌 TagSpecifications 需 CreateTags on RunInstances)。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:CreateTags'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'ec2:CreateAction': 'RunInstances' },
        },
      }),
    );
    // 4) DescribeInstances/DescribeTags 唯讀,不支援資源級條件,無條件放行。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances', 'ec2:DescribeTags'],
        resources: ['*'],
      }),
    );
    // 只能終結/停止帶 per-job 生命週期標籤的實例(保護常駐主機,Req 4.5)。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:TerminateInstances', 'ec2:StopInstances'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            [`aws:ResourceTag/${HOST_LIFECYCLE_TAG}`]: HOST_LIFECYCLE_PER_JOB,
          },
        },
      }),
    );
    // 引擎 RunInstances 時把 emulator host instance profile 傳給 EC2,需 iam:PassRole。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.emulatorHost.hostRole.roleArn],
      }),
    );

    // ───────────────────────────────────────────────────────────────────────
    // Windows:Amazon GameLift Streams(GPU 主機)。Application / Stream Group 由
    // worker/windows-host/gamelift/setup.mjs 建立並把 ID 寫進 SSM(${glsParamPrefix}/*);
    // 這裡只建 session 角色(名稱必須以 GameLiftStreams- 開頭)與引擎權限。
    const glsParamPrefix = `/playagent/${this.stackName}/windows-gls`;
    const glsRole = new iam.Role(this, 'WindowsGlsSessionRole', {
      roleName: `GameLiftStreams-${this.stackName}`.slice(0, 64),
      description: 'PlayAgent Windows host (GameLift Streams session): runner reads/writes job data and calls Bedrock',
      assumedBy: new iam.ServicePrincipal('gameliftstreams.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:gameliftstreams:*:${this.account}:streamsession/*` },
        },
      }),
    });
    glsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
      resources: [props.dataBucket.bucketArn, `${props.dataBucket.bucketArn}/*`],
    }));
    glsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: ['arn:aws:bedrock:*::foundation-model/*', `arn:aws:bedrock:*:${this.account}:inference-profile/*`],
    }));
    glsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [`arn:aws:secretsmanager:*:${this.account}:secret:playagent/tenant/*`],
    }));
    this.engineFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['gameliftstreams:StartStreamSession', 'gameliftstreams:GetStreamSession', 'gameliftstreams:TerminateStreamSession'],
      resources: [`arn:aws:gameliftstreams:${this.region}:${this.account}:*`],
    }));
    this.engineFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [glsRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'gameliftstreams.amazonaws.com' } },
    }));
    this.engineFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters', 'ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${glsParamPrefix}/*`],
    }));
    this.engineFn.addEnvironment('WINDOWS_GLS_ROLE_ARN', glsRole.roleArn);
    this.engineFn.addEnvironment('WINDOWS_GLS_PARAM_PREFIX', glsParamPrefix);
    new CfnOutput(this, 'WindowsGlsParamPrefix', { value: glsParamPrefix });
    new CfnOutput(this, 'WindowsGlsRoleArn', { value: glsRole.roleArn });

    // emulator 承載所需環境(主機自驅動:引擎只 RunInstances,其餘由 userdata 完成)。
    this.engineFn.addEnvironment('DEVICE_VPC_ID', this.vpc.vpcId);
    this.engineFn.addEnvironment('DEVICE_SUBNET_ID', publicSubnetId);
    // 跨 AZ 回落用的完整子網清單。單一子網 = 單一 AZ,而某個 AZ 容量不足時同代機型
    // 往往一起不足(實測 us-west-2a 回 InsufficientInstanceCapacity 而同一刻 2b 有容量,
    // 當時三個候選機型全在同一個子網所以整串失敗)。emulatorHost 會逐個子網試。
    this.engineFn.addEnvironment('DEVICE_SUBNET_IDS', this.vpc.publicSubnets.map((s) => s.subnetId).join(','));
    this.engineFn.addEnvironment('EMULATOR_HOST_SG_ID', this.emulatorHost.securityGroup.securityGroupId);
    this.engineFn.addEnvironment('EMULATOR_HOST_PROFILE_ARN', emuProfile.attrArn);
    this.engineFn.addEnvironment('EMULATOR_HOST_ROLE_ARN', this.emulatorHost.hostRole.roleArn);
    this.engineFn.addEnvironment('WINDOWS_HOST_ROLE_ARN', this.windowsHost.hostRole.roleArn);
    this.engineFn.addEnvironment('EMULATOR_AMI_ARM64', amiArm64);
    this.engineFn.addEnvironment('EMULATOR_AMI_X86', amiX86);
    // 預裝好的 emulator AMI(scripts/build-emulator-ami.mjs 建好後寫進 SSM)。
    // engine 讀不到就用上面的公用 Ubuntu AMI —— 這是加分項不是依賴,所以 AMI 壞掉時
    // 只要刪掉參數就回到原本行為,不必重新部署。參數前綴與 deployed-version 同一層。
    const emuAmiParamPrefix = `/playagent/${this.stackName.replace(/-Execution$/, '')}`;
    this.engineFn.addEnvironment('EMULATOR_AMI_PARAM_PREFIX', emuAmiParamPrefix);
    this.engineFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${emuAmiParamPrefix}/emulator-ami-*`],
    }));

    // ───────────────────────────────────────────────────────────────────────
    // Device Farm 真機探索:ECS Fargate 承載 Appium 探索迴圈(無伺服器容器,非 EC2)。
    // engine 開 Device Farm(us-west-2)session 後,RunTask 起一個 Fargate task,
    // task 內的 explorationRunner 連 Appium 跑 screenshot→VLM→act 並即時寫 S3。
    // ───────────────────────────────────────────────────────────────────────

    // 容器 image 走 ECR(image 由 CI/運維用 Docker build 後推上,CDK 不需 Docker 即可部署)。
    const runnerRepo = props.useExistingRunnerRepos
      ? ecr.Repository.fromRepositoryName(this, 'ExplorationRunnerRepoImported', 'playagent-exploration-runner')
      : new ecr.Repository(this, 'ExplorationRunnerRepo', {
          repositoryName: 'playagent-exploration-runner',
          imageScanOnPush: true,
          lifecycleRules: [{ maxImageCount: 10 }],
        });

    const cluster = new ecs.Cluster(this, 'DeviceFarmCluster', { vpc: this.vpc });

    // Task role:runner 執行時需存取 S3(讀 APK/context、寫截圖/step/report/structure)、
    // Bedrock(VLM)、Device Farm(刷新 endpoint)。
    const taskRole = new iam.Role(this, 'ExplorationTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
        resources: [props.dataBucket.bucketArn, `${props.dataBucket.bucketArn}/*`],
      }),
    );
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:*:${account}:inference-profile/*`,
        ],
      }),
    );
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // runner 自行完成 Device Farm 全流程:專案 / 上傳 APK / 列真機 / 開&停 Remote Access
        // session / 刷新 remoteDriverEndpoint(預簽名約 15 分過期)。重活搬離 engine Lambda。
        actions: [
          'devicefarm:CreateProject',
          'devicefarm:ListProjects',
          'devicefarm:TagResource',
          'devicefarm:CreateUpload',
          'devicefarm:GetUpload',
          'devicefarm:ListUploads',
          'devicefarm:ListDevices',
          'devicefarm:CreateRemoteAccessSession',
          'devicefarm:GetRemoteAccessSession',
          'devicefarm:StopRemoteAccessSession',
        ],
        resources: ['*'],
      }),
    );
    // UI-TARS 定位:使用者選 vlmModel='uitars' 時,runner 呼叫 SageMaker endpoint 做 GUI grounding。
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sagemaker:InvokeEndpoint'],
        resources: [`arn:aws:sagemaker:*:${account}:endpoint/ui-tars-*`],
      }),
    );
    // 測試憑證注入:runner 在容器內把 PA_TASK 的 ${NAME}/secretRef: 換成真實值(明文不落 S3、
    // 不進 ECS env override)。只讀本平台命名前綴下的機密,租戶隔離在 runner 端以名稱前綴強制。
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:*:${account}:secret:playagent/tenant/*`],
      }),
    );

    // 2 vCPU / 8 GB / 40 GiB 暫存:XAPK(數百 MB)要在容器內合併成 universal APK。
    // APKEditor(JVM)合併時會把 APK 結構整個載入記憶體;舊的 1 vCPU / 2 GB 下 JVM 預設 heap 只有 ~512 MB,
    // 合併 ~434 MB 的 APK 會 OutOfMemoryError(容器 exit 1)。磁碟同時放原檔 + unsigned + aligned + signed 四份。
    // 成本:Fargate 2 vCPU/8 GB 約 US$0.12/小時,遠低於同時計費的 Device Farm 真機(US$10.2/小時)。
    const taskDef = new ecs.FargateTaskDefinition(this, 'ExplorationTaskDef', {
      cpu: EXPLORATION_RUNNER_CPU,
      memoryLimitMiB: EXPLORATION_RUNNER_MEMORY_MIB,
      ephemeralStorageGiB: EXPLORATION_RUNNER_STORAGE_GIB,
      taskRole,
    });
    const DF_CONTAINER_NAME = 'exploration-runner';
    taskDef.addContainer(DF_CONTAINER_NAME, {
      // 一鍵部署用 Git SHA tag 鎖定 source=image;手動開發部署才回退 latest。
      image: ecs.ContainerImage.fromEcrRepository(runnerRepo, props.runnerImageTag ?? 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'exploration',
        logGroup: new logs.LogGroup(this, 'ExplorationRunnerLogs', {
          logGroupName: `/playagent/${logStage}/runner-exploration`,
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      }),
    });

    // Fargate task 出網 SG(需連 Device Farm us-west-2 / Bedrock / S3)。
    const fargateSg = new ec2.SecurityGroup(this, 'ExplorationFargateSg', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: 'Device Farm exploration Fargate task egress',
    });

    // engine 需 ecs:RunTask 起 task,並 PassRole 給 task role 與 execution role。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [taskDef.taskDefinitionArn],
      }),
    );
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [taskRole.roleArn, taskDef.executionRole!.roleArn],
      }),
    );
    // RunTask 帶成本標籤(costTags)需要對「起出來的 task」有 ecs:TagResource;
    // scope 到本叢集的 task 資源。缺這個會讓帶 tags 的 RunTask 直接 AccessDenied(任務起不來)。
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:TagResource'],
        resources: [`arn:aws:ecs:${region}:${account}:task/${cluster.clusterName}/*`],
      }),
    );
    // 注意:engine 不再直接呼叫 Device Farm(讀 APK/上傳/開 session 全搬進 Fargate runner,
    // 因 engine 512MB/5 分撐不住數百 MB APK)。engine 僅需 ecs:RunTask + iam:PassRole(上方已授)。

    // Device Farm 執行環境注入 engine(deviceFarmHost 讀取)。用 public 子網 + 公網 IP 出網。
    const publicSubnetIds = this.vpc.publicSubnets.map((s) => s.subnetId).join(',');
    this.engineFn.addEnvironment('DF_ECS_CLUSTER', cluster.clusterArn);
    this.engineFn.addEnvironment('DF_ECS_TASK_DEF', taskDef.taskDefinitionArn);
    this.engineFn.addEnvironment('DF_ECS_SUBNETS', publicSubnetIds);
    this.engineFn.addEnvironment('DF_ECS_SG', fargateSg.securityGroupId);
    this.engineFn.addEnvironment('DF_ECS_CONTAINER', DF_CONTAINER_NAME);
    // UI-TARS endpoint 名(在 CDK 外由 agent/sagemaker/deployUitars.mjs 部署後取得)。
    // 透過 cdk context `uitarsEndpoint` 或環境變數 UITARS_ENDPOINT 注入;留空則 runner 走 Bedrock 通用 VLM。
    // 部署帶入例:cdk deploy PlayAgentDev-Execution -c uitarsEndpoint=ui-tars-20260928-xxxxxx
    const uitarsEndpoint = (this.node.tryGetContext('uitarsEndpoint') as string | undefined)
      ?? process.env.UITARS_ENDPOINT ?? '';
    this.engineFn.addEnvironment('UITARS_ENDPOINT', uitarsEndpoint);

    // ───────────────────────────────────────────────────────────────────────
    // Web 真實瀏覽器測試:另一個 Fargate task(headless Chromium via Playwright)。
    // 與 Device Farm 同 cluster,但各自 ECR image / task def / task role。
    // engine 只 RunTask 起 task,task 內 webExplorationRunner 跑 screenshot→VLM→click 迴圈並寫 S3。
    // ───────────────────────────────────────────────────────────────────────
    const webRunnerRepo = props.useExistingRunnerRepos
      ? ecr.Repository.fromRepositoryName(this, 'WebRunnerRepoImported', 'playagent-web-runner')
      : new ecr.Repository(this, 'WebRunnerRepo', {
          repositoryName: 'playagent-web-runner',
          imageScanOnPush: true,
          lifecycleRules: [{ maxImageCount: 10 }],
        });

    // Web task role:只需 S3(讀 context、寫截圖/step/report/structure)+ Bedrock(VLM)。無 Device Farm。
    const webTaskRole = new iam.Role(this, 'WebTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    webTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
        resources: [props.dataBucket.bucketArn, `${props.dataBucket.bucketArn}/*`],
      }),
    );
    webTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:*:${account}:inference-profile/*`,
        ],
      }),
    );
    // 測試憑證注入(同 Device Farm runner):web runner 也可能需要在任務目標填入測試帳密。
    webTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:*:${account}:secret:playagent/tenant/*`],
      }),
    );

    // Chromium 較吃記憶體;給 2GB / 1vCPU(與 Device Farm runner 同級,足夠 headless 單頁探索)。
    const webTaskDef = new ecs.FargateTaskDefinition(this, 'WebRunnerTaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole: webTaskRole,
    });
    const WEB_CONTAINER_NAME = 'web-runner';
    webTaskDef.addContainer(WEB_CONTAINER_NAME, {
      // 與 Device Farm runner 使用同一個不可變 Git SHA tag。
      image: ecs.ContainerImage.fromEcrRepository(webRunnerRepo, props.runnerImageTag ?? 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'web-runner',
        logGroup: new logs.LogGroup(this, 'WebRunnerLogs', {
          logGroupName: `/playagent/${logStage}/runner-web`,
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      }),
    });

    const webFargateSg = new ec2.SecurityGroup(this, 'WebRunnerFargateSg', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: 'Web exploration Fargate task egress (target site + Bedrock/S3)',
    });

    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [webTaskDef.taskDefinitionArn],
      }),
    );
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [webTaskRole.roleArn, webTaskDef.executionRole!.roleArn],
      }),
    );

    // Web 執行環境注入 engine(webHost 讀取)。
    this.engineFn.addEnvironment('WEB_ECS_CLUSTER', cluster.clusterArn);
    this.engineFn.addEnvironment('WEB_ECS_TASK_DEF', webTaskDef.taskDefinitionArn);
    this.engineFn.addEnvironment('WEB_ECS_SUBNETS', publicSubnetIds);
    this.engineFn.addEnvironment('WEB_ECS_SG', webFargateSg.securityGroupId);
    this.engineFn.addEnvironment('WEB_ECS_CONTAINER', WEB_CONTAINER_NAME);

    // ───────────────────────────────────────────────────────────────────────
    // Windows 長時測試的保活 task:讓 GameLift Streams session 活得過一小時。
    //
    // engine 以 SignalRequest='NO_CLIENT_CONNECTION' 開 session,沒有人連進來,而
    // ConnectionTimeoutSeconds(等 client 連線的窗口)上限是 AWS 強制的 3600 秒。
    // SessionLengthSeconds 可以到 24 小時 —— 差別只在「有沒有 client 連著」。
    // 這個 task 就是那個 client:一個真實 Chromium 跑 AWS 的 Web SDK 接上 session 並掛著,
    // 同時把 deadline 租約寫進該任務的前綴。詳見 docs/design/windows-long-run.md。
    // ───────────────────────────────────────────────────────────────────────
    const keepAliveRepo = props.useExistingRunnerRepos
      ? ecr.Repository.fromRepositoryName(this, 'KeepAliveRunnerRepoImported', 'playagent-keepalive-runner')
      : new ecr.Repository(this, 'KeepAliveRunnerRepo', {
          repositoryName: 'playagent-keepalive-runner',
          imageScanOnPush: true,
          lifecycleRules: [{ maxImageCount: 10 }],
        });

    // 保活只做兩件事:接上 stream session、更新 deadline 租約。不呼叫 Bedrock、不讀遊戲
    // 產物、不碰租戶憑證,所以權限刻意比兩個探索 runner 小得多。
    const keepAliveTaskRole = new iam.Role(this, 'KeepAliveTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    keepAliveTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['gameliftstreams:GetStreamSession', 'gameliftstreams:CreateStreamSessionConnection'],
        resources: [`arn:aws:gameliftstreams:${this.region}:${account}:*`],
      }),
    );
    keepAliveTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // 只寫租約,不需要讀、不需要列。
        actions: ['s3:PutObject'],
        resources: [`${props.dataBucket.bucketArn}/tenants/*`],
      }),
    );

    // Chromium 要解一條隱藏的 720p WebRTC 視訊流(SDK 硬性要求 video 元素),與 web runner 同級。
    const keepAliveTaskDef = new ecs.FargateTaskDefinition(this, 'KeepAliveTaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole: keepAliveTaskRole,
    });
    const KEEPALIVE_CONTAINER_NAME = 'keepalive-runner';
    keepAliveTaskDef.addContainer(KEEPALIVE_CONTAINER_NAME, {
      // 與兩個探索 runner 使用同一個不可變 Git SHA tag。
      image: ecs.ContainerImage.fromEcrRepository(keepAliveRepo, props.runnerImageTag ?? 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'keepalive',
        logGroup: new logs.LogGroup(this, 'KeepAliveLogs', {
          logGroupName: `/playagent/${logStage}/runner-keepalive`,
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      }),
    });

    // 只需要出網。WebRTC 的媒體不必開入站規則:client 是發起方(我們送 offer),
    // 而 SG 是 stateful 的,所以 client 主動建立的 UDP 流的回應會自動被放行。
    // 本機驗證時瀏覽器也在家用 NAT 後面(同樣不接受主動入站)且連得上,這條路徑成立。
    const keepAliveSg = new ec2.SecurityGroup(this, 'KeepAliveFargateSg', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: 'Windows keep-alive Fargate task egress (WebRTC to GameLift Streams + S3 lease)',
    });

    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [keepAliveTaskDef.taskDefinitionArn],
      }),
    );
    this.engineFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [keepAliveTaskRole.roleArn, keepAliveTaskDef.executionRole!.roleArn],
      }),
    );

    // 保活執行環境注入 engine(windowsHost 讀取)。
    this.engineFn.addEnvironment('KEEPALIVE_ECS_CLUSTER', cluster.clusterArn);
    this.engineFn.addEnvironment('KEEPALIVE_ECS_TASK_DEF', keepAliveTaskDef.taskDefinitionArn);
    this.engineFn.addEnvironment('KEEPALIVE_ECS_SUBNETS', publicSubnetIds);
    this.engineFn.addEnvironment('KEEPALIVE_ECS_SG', keepAliveSg.securityGroupId);
    this.engineFn.addEnvironment('KEEPALIVE_ECS_CONTAINER', KEEPALIVE_CONTAINER_NAME);
  }
}
