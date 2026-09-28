import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
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
  /** 成本分攤標籤(project/stage/component + 部署者帶入),序列化後傳給引擎供執行期資源貼標。 */
  costTags?: Record<string, string>;
}

/** 每任務主機的生命週期標籤鍵/值。常駐主機不帶此標籤,故不被回收路徑觸及(Req 4.5)。 */
export const HOST_LIFECYCLE_TAG = 'hostLifecycle';
export const HOST_LIFECYCLE_PER_JOB = 'per-job';

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
        // 成本分攤標籤(JSON):執行期動態起的 EC2 / Fargate 用它貼標(見 lambda/engine/costTags.ts)。
        COST_TAGS: JSON.stringify({
          project: 'playagent-checker',
          ...(props.costTags ?? {}),
        }),
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        // emulator-userdata.sh 是執行期以 readFileSync 讀取的資產,需隨 bundle 複製到輸出目錄。
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${path.join(inputDir, 'infra', 'lambda', 'engine', 'emulator-userdata.sh')} ${outputDir}/emulator-userdata.sh`,
          ],
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

    // emulator 承載所需環境(主機自驅動:引擎只 RunInstances,其餘由 userdata 完成)。
    this.engineFn.addEnvironment('DEVICE_VPC_ID', this.vpc.vpcId);
    this.engineFn.addEnvironment('DEVICE_SUBNET_ID', publicSubnetId);
    this.engineFn.addEnvironment('EMULATOR_HOST_SG_ID', this.emulatorHost.securityGroup.securityGroupId);
    this.engineFn.addEnvironment('EMULATOR_HOST_PROFILE_ARN', emuProfile.attrArn);
    this.engineFn.addEnvironment('EMULATOR_HOST_ROLE_ARN', this.emulatorHost.hostRole.roleArn);
    this.engineFn.addEnvironment('WINDOWS_HOST_ROLE_ARN', this.windowsHost.hostRole.roleArn);
    this.engineFn.addEnvironment('EMULATOR_AMI_ARM64', amiArm64);
    this.engineFn.addEnvironment('EMULATOR_AMI_X86', amiX86);

    // ───────────────────────────────────────────────────────────────────────
    // Device Farm 真機探索:ECS Fargate 承載 Appium 探索迴圈(無伺服器容器,非 EC2)。
    // engine 開 Device Farm(us-west-2)session 後,RunTask 起一個 Fargate task,
    // task 內的 explorationRunner 連 Appium 跑 screenshot→VLM→act 並即時寫 S3。
    // ───────────────────────────────────────────────────────────────────────

    // 容器 image 走 ECR(image 由 CI/運維用 Docker build 後推上,CDK 不需 Docker 即可部署)。
    const runnerRepo = new ecr.Repository(this, 'ExplorationRunnerRepo', {
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

    const taskDef = new ecs.FargateTaskDefinition(this, 'ExplorationTaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole,
    });
    const DF_CONTAINER_NAME = 'exploration-runner';
    taskDef.addContainer(DF_CONTAINER_NAME, {
      // image tag `latest` 由 CI/運維用 agent/Dockerfile.exploration build 後推到此 ECR repo。
      image: ecs.ContainerImage.fromEcrRepository(runnerRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'exploration',
        logRetention: logs.RetentionDays.TWO_WEEKS,
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
    const webRunnerRepo = new ecr.Repository(this, 'WebRunnerRepo', {
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

    // Chromium 較吃記憶體;給 2GB / 1vCPU(與 Device Farm runner 同級,足夠 headless 單頁探索)。
    const webTaskDef = new ecs.FargateTaskDefinition(this, 'WebRunnerTaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole: webTaskRole,
    });
    const WEB_CONTAINER_NAME = 'web-runner';
    webTaskDef.addContainer(WEB_CONTAINER_NAME, {
      // image tag `latest` 由 CI/運維用 agent/Dockerfile.web build 後推到此 ECR repo。
      image: ecs.ContainerImage.fromEcrRepository(webRunnerRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'web-runner',
        logRetention: logs.RetentionDays.TWO_WEEKS,
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
  }
}
