# PlayAgent Checker

**AI 驱动的游戏与应用自动化 QA。** 用自然语言描述测试流程，AI Agent 会观察屏幕、替你点击和滑动、判定通过/失败，并生成包含截图、逐步轨迹和导航地图的多语言报告。

> 语言:[English](README.md) · [繁體中文](README_ZH.md) · **简体中文** · [日本語](README_JP.md) · [한국어](README_KR.md)

---

## 功能概述

PlayAgent Checker 完全运行在 **AWS（区域 `us-east-2`）** 上：一个 Serverless 控制平面，加上按任务启动、任务结束即关闭的执行 Runner。你上传一个应用（或指定一个 Web URL），Agent 会自行探索，你得到可重复、可审阅的测试运行。

- **Agent 循环：** 截图 → VLM 定位目标 → Agent 决策 → 在设备上操作 → 再次截图，直到达成目标或触发停止条件。
- **看屏幕，而不是 UI 树**，因此可用于没有可检查元素、基于 Canvas 渲染的游戏（Cocos2d-x、Unity）。
- **知识库、费用护栏、5 种语言界面**（zh-Hant、en、zh-Hans、ja、ko），以及从 GitHub 一键自更新。

## 运行环境

| 运行环境 | 由什么运行 | 安装后可用 | 限制 |
| --- | --- | --- | --- |
| **Web 浏览器** | ECS Fargate 上的无头 Chromium（Playwright） | ✅ | — |
| **Android 真机**（Device Farm） | AWS Device Farm + Appium，控制器运行在 Fargate 上 | ✅ | 每个会话 150 分钟（AWS 限制）；“长时”选项每 140 分钟重连一次，游戏会重启 |
| **iOS 真机**（Device Farm） | AWS Device Farm + Appium | ✅ | 需要可安装的 `.ipa`；每个会话 150 分钟 |
| **Android 容器**（Redroid） | 每个任务一台运行 Redroid 的 Graviton EC2（`m7g.xlarge`） | ✅ | 带反模拟器检测的游戏会自行关闭（请使用真机）；不支持视频/音频检查；不支持双指缩放；每次运行 1–72 小时 |
| **Windows PC 游戏** | Amazon GameLift Streams（NVIDIA GPU，`gen6n_medium_win2022`） | ⚙️ 需一次性设置（见[可选：Windows](#可选windows-pc-游戏gamelift-streams)） | 每次运行 ≤ 60 分钟；总像素 ≤ 1920×1080 |
| iOS 模拟器 / Linux | — | ❌ 未实现 | — |

各类游戏该选哪种运行环境：[docs/design/multi-platform-workers.md](docs/design/multi-platform-workers.md)。

## 默认提供的功能

按下文完成安装后，以下是默认开启、默认关闭以及需要额外一步的功能。

| 功能 | 默认 | 说明 |
| --- | --- | --- |
| Web 控制台、登录（Cognito）、5 种语言 | ✅ 开启 | 已禁用自助注册；由管理员创建用户。 |
| 应用 / 测试用例 / 任务 / 报告 / 记忆地图 | ✅ 开启 | AI 根据自然语言起草测试用例（Claude Sonnet 4.5）。 |
| 运行环境：Web、Device Farm Android/iOS、Android 容器 | ✅ 开启 | 每次运行自行启动资源，结束时停止。 |
| 默认模型 | ✅ 开启 | 决策 **Amazon Nova Lite**，屏幕分析 **Moonshot Kimi K3**，辅助 **Amazon Nova Micro**。每个席位都可以按任务更换。 |
| 知识库（Markdown + PDF 检索） | ✅ 开启 | PDF 检索使用 Bedrock Knowledge Bases + S3 Vectors + Titan Embeddings V2。 |
| 测试凭据（Secrets Manager） | ✅ 开启 | 按应用管理；掩码值永远不会传给模型。 |
| 费用护栏（预算 + fail-closed 定价） | ✅ 开启 | — |
| 费用分析页面 — 任务估算 | ✅ 开启 | 每个任务的 Token × 单价。 |
| 费用分析页面 — 真实 AWS 账单 | ⚙️ 需要账户设置 | 启用 Cost Explorer 并激活标签（[见下方](#启用费用分析页面)）。 |
| 成员管理页面（管理员） | ✅ 开启 | 添加用户、重置密码、迁移租户、授予管理员权限。 |
| 系统管理页面 → **系统更新** | ⚙️ 可选 | 部署 Updater 堆栈并保存 GitHub Token（[见下方](#可选一键系统更新)）。 |
| 系统管理页面 → **UI-TARS** | ⛔ **关闭** | GPU 定位模型。管理员在页面上开启/关闭；仅在开启期间计费（[见下方](#可选ui-tars-定位模型)）。 |
| Windows 运行环境 | ⚙️ 可选 | 需在 Windows 机器上完成一次性 GameLift Streams 设置。 |

## 架构

```
Browser ──► CloudFront + S3 (React console)
   │
   │  REST + WebSocket, Cognito JWT
   ▼
API Gateway ──► API Lambda ──────────► S3 data bucket (per-tenant prefixes, tenant-scoped IAM role)
   │              │  POST /tasks          Secrets Manager (test credentials, GitHub token)
   │              ▼                       Bedrock (case drafting, knowledge bases)
   │            SQS dispatch queue
   │              ▼
   │            Dispatcher Lambda ──► Engine Lambda (orchestrator, returns immediately)
   │                                     │
   │          ┌──────────────────────────┼───────────────────────────┬──────────────────────────┐
   │          ▼                          ▼                           ▼                          ▼
   │   Fargate: Web runner     Fargate: Device Farm runner   EC2 (Graviton): Redroid   GameLift Streams: Windows
   │   (Playwright Chromium)   → AWS Device Farm (us-west-2)  Android container         (GPU, optional)
   │          └──────────── each runner: screenshot → Bedrock models → act → write progress to S3 ──┘
   │                                                  │ (optional) SageMaker UI-TARS endpoint
   ▼
WebSocket push (live progress) ◄──────────────────────┘

System admin: API ──► CodeBuild "self-update" (cdk deploy from GitHub) · SageMaker (UI-TARS on/off)
```

CDK 堆栈（全部位于 `us-east-2`）：

| 堆栈 | 内容 |
| --- | --- |
| **Foundation** | S3 数据桶、Cognito 用户池、租户 IAM 角色、Bedrock KB 服务角色。 |
| **ControlPlane** | HTTP API + JWT 授权方、API Lambda、WebSocket API。 |
| **Scheduling** | SQS 分发队列 + Dispatcher Lambda。 |
| **Execution** | Engine Lambda、ECS 集群 + Fargate 任务定义、ECR 仓库、VPC（无 NAT 网关）、按任务启动的 EC2 配置。 |
| **Frontend** | CloudFront + S3 静态站点。 |
| **Updater**（可选） | 从 GitHub 版本重新部署上述五个堆栈的 CodeBuild 项目。 |

详情：[docs/architecture.md](docs/architecture.md)。

## 费用

在本项目自己的账户中实测（`us-east-2`，2026 年 10 月）。AWS 价格会变动，以下数据仅供估算。

**无任务运行时（闲置）：** 约 **US$2–5 / 月**。没有 NAT 网关、没有常驻服务器、也没有预留的串流容量。剩余费用包括：

- S3 存储（截图、报告、上传的应用；如果暂存了 UI-TARS 权重，另有约 31 GB，约 US$0.7/月）
- ECR 镜像（Runner 镜像，如已构建还包括约 10 GB 的 UI-TARS 推理镜像）
- Secrets Manager（每个密钥每月 US$0.40）、CloudWatch Logs、CloudFront
- Lambda、API Gateway、SQS 和 Cognito 按请求计费，低用量下只有几美分

**每次测试运行（仅在运行期间）：**

| 项目 | 价格 | 示例 |
| --- | --- | --- |
| AI 模型（Bedrock Token） | 按 Token 计费，提交时锁定单价；在每份报告中显示 | 一个 26 步、转 10 次的老虎机测试，使用默认模型约消耗 141k 输入 / 14k 输出 Token，**不到 US$0.80** |
| Device Farm 真机 | **每设备分钟 US$0.17** | 30 分钟 ≈ US$5.10 |
| Android 容器（EC2 `m7g.xlarge`） | **US$0.1632 / 小时** + 磁盘 | 1 小时 ≈ US$0.17 |
| Fargate Runner（1 vCPU / 2 GB） | 约 US$0.05 / 小时 | Web 运行和 Device Farm 控制器 |
| Windows（GameLift Streams） | 会话运行期间按秒计费 | 见 [GameLift Streams 定价](https://aws.amazon.com/gamelift/streams/pricing/) |
| 系统自更新 | CodeBuild 分钟数 | 每次更新约 5–15 分钟，几美分 |
| Cost Explorer 查询（费用分析页面） | 每次查询约 US$0.01 | — |

**唯一的大额可选费用：UI-TARS。** `ml.g6e.xlarge` GPU，实测 **US$62.53 / 天（约 US$2.6 / 小时）**，只要处于开启状态就持续计费，即使没有任务。它**默认关闭**；除非需要，请保持关闭。

实际使用中，我们账户的大部分支出来自 Bedrock Token 和 Device Farm 分钟数。不做测试时，这两项都不产生费用。

## 功能（各页面用途）

| 页面 | 用途 |
| --- | --- |
| **指南** | 应用内操作指引（登录后的首页），提供 5 种语言。 |
| **应用管理** | 每个游戏/应用一个工作区：名称、平台、类型、安装包（APK/IPA/XAPK/ZIP/EXE）或 URL。内含：测试用例、任务、报告、记忆地图、测试凭据。 |
| **测试用例**（位于应用工作区） | 给 AI 的一个流程。可用自然语言起草（AI → YAML）、手写 YAML，或从电子表格导入。明文密码会被拒绝，请使用测试凭据。 |
| **测试任务**（位于应用工作区） | 运行一个用例。选择**运行环境**、三个**模型**、步数/预算上限以及**知识库**。可查看实时画面、设备日志（真机和 Android 容器）以及 Agent 的推理过程；可在运行中给 AI 下达指令；随时可取消。 |
| **测试报告** | AI 叙述、步骤轨迹、截图、录像回放（真机）、导航图、花费和 Token。 |
| **记忆地图** | 所有运行中访问过的画面成为节点，画面切换成为边；之后的运行导航更快。 |
| **设备管理** | 当前可用的 Device Farm 手机，以及正在运行的容器、EC2 主机和 GameLift 容量。 |
| **知识库** | 共享知识库（游戏类型 / 场景）：Markdown 全文注入和/或 PDF 检索。 |
| **费用分析** | 按应用和模型统计的任务估算，以及按服务 / 组件统计的真实 AWS 账单（启用后）。 |
| **成员管理**（管理员） | 添加用户、重置密码、禁用/启用、迁移租户、授予或撤销管理员权限。 |
| **系统管理**（管理员） | 从 GitHub 进行**系统更新**（版本对比、一键更新、进度、历史记录），以及 **UI-TARS** 开关。 |

## AI：三个模型“席位”

模型按**角色（席位）**组织，而不是按厂商。每个席位按任务选择：

- **Agent（决策）**：根据屏幕和目标决定下一步操作。默认 **Amazon Nova Lite**。
- **VLM（屏幕分析 / 坐标）**：把“要点击的东西”转换成像素坐标。默认 **Moonshot Kimi K3**。UI-TARS-1.5-7B 仅在管理员开启后才会出现在这里。
- **Subagent（辅助）**：检查操作是否生效、追踪数值、确认是否完成。默认 **Amazon Nova Micro**。

你无需选择 SDK 或端点；系统会根据模型 ID 自动推导。

## 费用护栏

每个任务都可以设置步数上限和预算。运行前，引擎会为每个席位的模型**锁定价格快照**（fail-closed：价格未知时拒绝运行）。花费达到预算后执行即停止，报告中会显示实际花费和 Token。

## 术语表

- **Seat（席位）**：模型角色（Agent / VLM / Subagent），而不是厂商。
- **VLM**：Vision-Language Model（视觉语言模型）；读取截图并定位坐标。
- **UI-TARS**：字节跳动针对 GUI 定位微调的视觉模型，通过 vLLM 部署在 SageMaker 上。可选，默认关闭。
- **Redroid**：在 ARM EC2 主机上以容器方式运行的 Android（即“Android 容器”运行环境）。
- **Locality（位置）**：设备所在位置：`cloud`（云端提供）或 `attached`（你的本地设备，仍由云端驱动）。
- **Terminal state（终止状态）**：`pass` / `fail` / `error` / `cancelled` / `budget_exceeded` / `dead`。
- **Fail-closed**：价格未知时宁可拒绝运行，也不在未知价格下产生花费。

---

# 🚀 在全新 AWS 账户上安装（分步说明）

本节假设你**没有任何 AWS 使用经验**。请从上到下依次操作。总耗时约 **60–90 分钟**，大部分时间在等待 AWS。

> 所有资源都部署到 **`us-east-2`（俄亥俄）**。除非你清楚自己在改什么，否则所有地方都使用该区域。
>
> 命令以 **bash** 编写（macOS、Linux、Git Bash、WSL）。在 Windows PowerShell 中，请用 `$env:NAME="value"` 设置变量，而不是 `NAME=value command`。

## 第 0 步：在电脑上安装工具

| 工具 | 用途 | 安装 |
| --- | --- | --- |
| **Node.js 22+** | 运行构建和部署脚本 | https://nodejs.org（“LTS”安装包） |
| **AWS CLI v2** | 与你的 AWS 账户通信 | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| **Git** | 获取本代码 | https://git-scm.com/downloads |

```bash
node --version    # v22.x 或更高
aws --version     # aws-cli/2.x
git --version
```

你**不需要** Docker；容器镜像在云端构建（AWS CodeBuild）。

## 第 1 步：获取代码

```bash
git clone https://github.com/hoycdanny/playagent-checker.git
cd playagent-checker
npm install
```

## 第 2 步：将 AWS CLI 连接到账户

向账户所有者索取 **Access Key ID** 和 **Secret Access Key**（AWS 控制台 → IAM → Users → Security credentials → Create access key）。然后：

```bash
aws configure
# AWS Access Key ID     : <粘贴>
# AWS Secret Access Key : <粘贴>
# Default region name   : us-east-2
# Default output format : json

aws sts get-caller-identity   # 应输出你的账户编号
```

> 该凭据必须能够创建 Lambda、S3、Cognito、API Gateway、IAM、ECS、EC2、ECR、CodeBuild、SageMaker、Bedrock 和 CloudFront 资源。首次设置时，使用管理员用户（`AdministratorAccess`）最简单。

## 第 3 步：开启 AI 模型（Amazon Bedrock）

新账户的 Bedrock 模型默认**关闭**。需要启用一次，否则每次运行都会失败。

1. AWS 控制台 → **Bedrock** → 区域（右上角）选择 **US East (Ohio) us-east-2**。
2. 左侧菜单 → **Model access** → **Enable specific models**。
3. 至少启用：
   - **Amazon – Nova Lite**（默认决策模型）
   - **Amazon – Nova Micro**（默认辅助模型）
   - **Moonshot AI – Kimi K3**（默认屏幕分析模型）
   - **Anthropic – Claude Sonnet 4.5**（起草测试用例、读取导入的电子表格）
   - **Amazon – Titan Text Embeddings V2**（知识库搜索）
4. 等待状态变为 **Access granted**。评估阶段启用该区域的所有模型也没问题；应用会为每个席位列出所有可用模型。

## 第 4 步：准备 CDK（每个账户一次）

```bash
cd infra
npx cdk bootstrap aws://ACCOUNT_ID/us-east-2
```

将 `ACCOUNT_ID` 替换为第 2 步输出的账户编号。

## 第 5 步：部署后端

在 `infra/` 目录下执行：

```bash
AWS_REGION=us-east-2 npx cdk deploy \
  PlayAgentDev-Foundation PlayAgentDev-ControlPlane \
  PlayAgentDev-Scheduling PlayAgentDev-Execution \
  --require-approval never
```

> **可选的成本分配标签。** 每个资源都带有 `project`、`stage`、`component` 标签。可用 `-c` 添加自定义标签（它们也会传递到运行时启动的 EC2/Fargate）：
> `-c costCenter=QA-1234 -c owner=alice -c team=game-qa`（键：`costCenter`、`owner`、`team`、`env`、`costAllocation`）。每次部署都要使用相同的参数。

此过程约需 10–15 分钟。然后输出后续步骤需要的值：

```bash
aws cloudformation describe-stacks --region us-east-2 --stack-name PlayAgentDev-Foundation \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
aws cloudformation describe-stacks --region us-east-2 --stack-name PlayAgentDev-ControlPlane \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'||OutputKey=='WsUrl'].[OutputKey,OutputValue]" --output table
```

记下：

- **Data bucket**：输出名称包含 `DataBucket`（Ref），形如 `playagentdev-foundation-databucket…`
- **User Pool ID**：包含 `UserPoolId`，形如 `us-east-2_XXXXXXXXX`
- **User Pool Client ID**：包含 `UserPoolClientId`
- **ApiUrl**：`https://xxxx.execute-api.us-east-2.amazonaws.com`
- **WsUrl**：`wss://xxxx.execute-api.us-east-2.amazonaws.com/prod`

## 第 6 步：构建 Runner 镜像（必需）

Web 和 Device Farm Runner 使用你 ECR 中的容器镜像运行。镜像通过 CodeBuild 在云端构建，因此不会有大文件下载到你的电脑。

```bash
cd ../agent/sagemaker && npm install
export PA_SM_BUCKET=PASTE_DataBucket     # 来自第 5 步，脚本会把构建源码上传到这里
export AWS_REGION=us-east-2

# a) 创建共享的 CodeBuild 角色，并暂存 UI-TARS 权重 + 推理镜像
#    （仅在之后开启 UI-TARS 时需要）。约 20–40 分钟，在 AWS 中运行。
#    不会启动 GPU；存储费用约 US$2/月。
node cloudBuild.mjs

# b) 构建并推送两个 Runner 镜像（每个需要几分钟）。
node cloudBuildRunner.mjs
node cloudBuildWebRunner.mjs
```

> 脚本内置的桶名属于原开发者的账户，因此务必将 `PA_SM_BUCKET` 设置为**你自己的**数据桶。

## 第 7 步：构建 Web 控制台

```bash
cd ../../web
cat > .env.production <<'EOF'
VITE_COGNITO_REGION=us-east-2
VITE_COGNITO_USER_POOL_ID=PASTE_UserPoolId
VITE_COGNITO_CLIENT_ID=PASTE_UserPoolClientId
VITE_API_URL=PASTE_ApiUrl
VITE_WS_URL=PASTE_WsUrl
EOF
npm run build
```

构建前，将每个 `PASTE_...` 替换为第 5 步得到的值。

## 第 8 步：部署 Web 控制台

```bash
cd ../infra
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Frontend --require-approval never
aws cloudformation describe-stacks --region us-east-2 --stack-name PlayAgentDev-Frontend \
  --query "Stacks[0].Outputs[?contains(OutputKey,'SiteUrl')].OutputValue" --output text
```

打开输出的 `https://xxxx.cloudfront.net` 地址，应能看到登录页面。

## 第 9 步：创建第一个（管理员）登录账号

自助注册是有意禁用的。选择一个邮箱和密码（至少 8 位，包含大写字母、小写字母和数字）。`tenant` 用于隔离各客户的数据；取一个简短的名称即可，例如公司名。

**方式 A：使用脚本（推荐）：**

```bash
cd ../agent/sagemaker
AWS_REGION=us-east-2 node createUser.mjs \
  --email you@example.com --tenant acme --password 'ChangeMe123!' --admin
```

**方式 B：部署时创建：** 在部署 Foundation 时加上 `-c adminEmail=you@example.com -c adminPassword='ChangeMe123!' -c adminTenant=acme`。

<details>
<summary>方式 C：直接使用 AWS CLI</summary>

```bash
POOL_ID=PASTE_UserPoolId
aws cognito-idp admin-create-user --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true "Name=custom:tenantId,Value=acme" \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --password 'ChangeMe123!' --permanent
aws cognito-idp admin-add-user-to-group --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --group-name admins
```
</details>

之后，其他用户都在**成员管理**页面创建。

## 第 10 步：登录并运行第一个测试

打开 CloudFront URL 并登录，会进入**指南**页面。然后：

1. **应用管理** → 创建应用（上传 APK/IPA/XAPK，或为 Web 填写 URL）。
2. 在应用工作区 → **测试用例** → 描述一个流程，AI 会把它转换成用例。
3. **测试任务** → 选择用例和运行环境（**Web**、**Android/iOS 真机**或 **Android 容器**）→ 提交。模型默认为 Nova Lite / Kimi K3 / Nova Micro。
4. 实时观看运行过程，然后阅读**报告**。

> **看不到成员管理 / 系统管理菜单？** 这两项仅对管理员显示，而登录 Token 只有在登录时才会获取用户组变更。被设为管理员后，请退出并重新登录。

✅ **至此你已拥有一个可用的环境。** 以下内容均为可选。

---

## 可选：一键系统更新

允许管理员在**系统管理 → 系统更新**中把整个平台更新到某个 GitHub 版本（先运行测试，然后在 CodeBuild 中执行 `cdk deploy`）。

1. 部署一次 Updater 堆栈（它永远不会更新自身）：
   ```bash
   cd infra
   AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Updater --require-approval never --exclusively
   ```
   使用的是 Fork？在这次以及之后每次部署时都加上 `-c githubRepo=owner/name`。
2. 为本仓库创建一个 GitHub **fine-grained** Token，权限为 **Contents: Read-only** 和 **Metadata: Read-only**。
3. 打开**系统管理**，粘贴 Token 并保存。它存储在 Secrets Manager（`playagent/github`）中，之后不会再显示。

更新按钮会以高权限重新部署 IAM 和各类资源，因此只有管理员能看到，且每次运行都会被记录。设计说明：[docs/design/self-update.md](docs/design/self-update.md)。

## 可选：UI-TARS 定位模型

UI-TARS-1.5-7B 是一个 GUI 定位模型，在小按钮上可能更精确。它**默认关闭**，因为其 GPU **开启期间约 US$62.5 / 天**。目前只有 Device Farm 真机运行环境会使用它；其他运行环境会回退到 Bedrock 视觉模型。

开关生效前，账户需要具备：

1. **第 6a 步**（`cloudBuild.mjs`）暂存的权重和推理镜像。
2. 一个名为 **`ArtSmokerSageMakerRole`** 的 SageMaker 执行角色（堆栈默认期望的名称；它允许 SageMaker 拉取镜像并读取权重）：
   ```bash
   ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
   BUCKET=PASTE_DataBucket
   aws iam create-role --role-name ArtSmokerSageMakerRole --assume-role-policy-document \
     '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"sagemaker.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
   aws iam put-role-policy --role-name ArtSmokerSageMakerRole --policy-name uitars --policy-document "{
     \"Version\":\"2012-10-17\",\"Statement\":[
     {\"Effect\":\"Allow\",\"Action\":\"ecr:GetAuthorizationToken\",\"Resource\":\"*\"},
     {\"Effect\":\"Allow\",\"Action\":[\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\",\"ecr:BatchCheckLayerAvailability\"],
      \"Resource\":\"arn:aws:ecr:us-east-2:${ACCOUNT}:repository/playagent-vllm-byoc\"},
     {\"Effect\":\"Allow\",\"Action\":\"s3:ListBucket\",\"Resource\":\"arn:aws:s3:::${BUCKET}\"},
     {\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::${BUCKET}/sagemaker-models/ui-tars/*\"},
     {\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\",\"logs:DescribeLogStreams\",\"cloudwatch:PutMetricData\"],\"Resource\":\"*\"}]}"
   ```
   如需使用其他角色，部署 ControlPlane 时加上 `-c uitarsRoleArn=arn:aws:iam::…:role/…`。

然后在**系统管理 → UI-TARS → 开启**。大约需要 8–15 分钟才会变为**已开启**；启动期间就已开始计费。之后 UI-TARS 会出现在任务的 VLM 菜单中。用完后在同一页面将其**关闭**；关闭会删除 GPU 端点但保留模型设置，因此再次开启无需重新设置。关闭期间，模型菜单会隐藏 UI-TARS，请求使用它的任务会被拒绝。

更多信息：[docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md)。

## 可选：Windows PC 游戏（GameLift Streams）

**在 Windows 机器上**运行一次（它会为 GPU 主机打包 Windows 工具）：

```powershell
cd worker\windows-host\gamelift
npm install
$env:AWS_REGION="us-east-2"; node setup.mjs --capacity 2
```

它会创建 GameLift Streams 应用和一个**没有常驻容量**的串流组（没有测试运行时不计费），最多支持 2 个并发运行。之后提交任务时会出现 **Windows** 运行环境。首次启动需要 10–15 分钟；每次运行上限 60 分钟。修改 Windows 主机脚本后需重新运行 `setup.mjs`；系统自更新不涵盖这部分。

## 启用费用分析页面

**费用分析**页面会把真实 AWS 账单（来自 Cost Explorer）与任务估算（Token × 单价）并排显示。估算功能立即可用。如需查看真实账单，每个账户需设置一次：

1. **Billing and Cost Management → Cost Explorer** → 启用。数据约 24 小时后出现。
2. **Billing and Cost Management → Cost allocation tags** → 激活 `project`、`stage`、`component`（以及所有自定义标签）。
3. 等待一天。标签仅在激活后才会作用于费用；之前的费用不会回填。

Cost Explorer 仅位于 `us-east-1`（应用会在该区域查询），每次查询约 US$0.01，数据延迟约 24 小时。激活标签需要账单访问权限。

注意：Bedrock Token 和 Device Farm 分钟数不带资源标签，因此按 `component` 查看真实账单时会单独列出。Device Farm 分钟数还会按会话名称匹配到每次运行。

## Device Farm（真机）说明

无需额外设置。Device Farm 位于 **us-west-2**；Runner 会自动创建其项目。选择真机运行环境时，下拉菜单会列出当前可用的手机（型号、操作系统、分辨率、内存、CPU）；“自动”会选择第一台可用设备。如果画面停止变化超过硬性上限（安装卡住、应用冻结、reCAPTCHA 拦截），运行会以 `error` 结束，而不是在循环中持续计费。

## 测试凭据（注册/登录流程）

在**应用 → 测试凭据**中按应用保存账号和密码，每个字段一行键值对（例如 `帳號`、`密碼`、`伺服器名稱`）。每一行可设为**掩码**（默认；AI 只能看到 `${key}`，Runner 在输入时填入实际值）或**可见**（用于 AI 需要从列表中选择的非敏感值）。正常编写用例即可，无需引用凭据。

值仅存储在 **AWS Secrets Manager**（`playagent/tenant/<tenant>/app/<appId>/credentials`）中。掩码值永远不会在 UI 中显示、由 API 返回、发送给模型，也不会写入 S3、任务定义、报告或轨迹。详情：[docs/design/test-credentials.md](docs/design/test-credentials.md)。

---

## 清理与故障排查

**先停掉最大的费用：** 在系统管理页面将 UI-TARS **关闭**，并确认没有仍在进行的长时 Android 容器或 Device Farm 运行（设备管理页面）。

**拆除全部资源**（数据桶和 Cognito 用户池按设计会保留；如确实要删除，请手动删除）：

```bash
cd infra
AWS_REGION=us-east-2 npx cdk destroy --all
```

另外还会遗留：Runner ECR 仓库 `playagent-exploration-runner` / `playagent-web-runner`（CDK 默认保留）、ECR 仓库 `playagent-vllm-byoc`、CodeBuild 项目 `playagent-uitars-build` / `playagent-runner-build` / `playagent-web-runner-build`、角色 `PlayAgentCodeBuildUitarsRole`、SageMaker 模型/配置 `ui-tars-playagent-*`，以及（如已设置）GameLift Streams 应用和串流组。

| 现象 | 解决方法 |
| --- | --- |
| 部署失败：*"not bootstrapped"* | 针对 `us-east-2` 执行第 4 步。 |
| 运行报错 *AccessDenied* / 模型不可用 | 在 **us-east-2** 中启用模型访问（第 3 步）。 |
| Web / Device Farm 运行无法启动（找不到镜像） | 构建 Runner 镜像（第 6 步）。 |
| 登录页能加载但登录失败，或页面空白 | `web/.env.production` 中的值有误，或修改后没有重新构建并重新部署 Web（第 7–8 步）。 |
| 游戏在 Android 容器上一启动就自行关闭 | 游戏带有反模拟器检测；请使用 Android 真机。 |
| UI-TARS 显示**失败** | 先关闭它（停止计费），查看卡片上的原因，检查第 6a 步和 SageMaker 角色，然后重新开启。 |
| 系统更新提示 Token 权限不足 | Token 需要对本仓库具有 **Contents: Read-only** 权限。 |
| 无法注册 | 设计如此；由管理员创建用户（第 9 步 / 成员管理页面）。 |

---

## 仓库结构

```
agent/            Execution runners
  explorationRunner.mjs    Device Farm / Android container / Windows runner (one loop, different drivers)
  webExplorationRunner.mjs Web runner (Playwright headless Chromium)
  uitarsClient.mjs         UI-TARS (SageMaker) grounding client
  sagemaker/               Cloud build scripts (runner images, UI-TARS), createUser.mjs
infra/            AWS CDK app (Foundation, ControlPlane, Scheduling, Execution, Frontend, Updater)
web/              React + Vite web console (5-locale i18n)
worker/           Platform workers, incl. windows-host/gamelift (Windows GameLift Streams setup)
docs/             Architecture, design notes, research
```

## 开发者指南

```bash
npm run test:web       # Web 单元测试
npm run test:worker    # Worker 单元测试
cd infra && npm test   # CDK + Lambda 单元测试
npm run build:web      # i18n 检查 + 类型检查 + 构建
```

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [docs/architecture.md](docs/architecture.md)。

## 许可证

见仓库设置。按原样提供，仅供内部评估使用。
