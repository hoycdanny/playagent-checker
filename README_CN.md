# PlayAgent Checker

**AI 驱动的游戏与应用自动化 QA。** 用自然语言描述测试流程，AI Agent 会观察屏幕、替你点击和滑动、判定通过/失败，并生成包含截图、逐步轨迹和导航地图的多语言报告。

> 语言:[English](README.md) · [繁體中文](README_ZH.md) · **简体中文** · [日本語](README_JP.md) · [한국어](README_KR.md)

---

## 这是什么

PlayAgent Checker 是 AI 驱动的游戏与应用自动化 QA，完全运行在你自己的 AWS 账户中。

- 用自然语言编写测试用例；AI Agent 会观察屏幕、像真实用户一样操作（点击、滑动、输入）来运行这些用例。
- 可用于基于 Canvas 渲染、没有可检查 UI 树的游戏（Unity、Cocos2d-x）。
- 在你的 AWS 账户中 Serverless、按用量计费：资源按任务启动、结束即停止，因此闲置成本几乎为零。
- 多语言报告，包含截图、逐步轨迹、导航地图以及每次运行的花费。
- 提供 Web、Android/iOS 真机、Android 容器和 Windows PC 游戏等运行环境。

## 快速开始

最快的方式只需要浏览器，不用在电脑上安装任何东西。

**开始之前：** 以管理员身份登录 AWS 控制台，先在目标区域启用 Bedrock 模型（见[开启 AI 模型](#第-3-步开启-ai-模型amazon-bedrock) — 不启用的话每次运行都会失败），然后点击控制台顶部栏的 `>_` 图标打开 **CloudShell**。

粘贴一行命令：

```bash
curl -fsSL https://raw.githubusercontent.com/hoycdanny/playagent-checker/main/scripts/cloudshell-install.sh | bash
```

- 它会先显示**语言菜单**（默认英文，无需任何标志；仍可用 `--lang en|zh-Hant|zh-Hans|ja|ko`），以**逐步进度**取代原始日志，若失败则输出错误日志。
- 默认区域为 `us-west-2`。要使用其他区域，加上 `--region <region>`；所选区域必须已启用 Bedrock 模型，而且默认模型使用 `us.` 跨区域推理配置文件，非美国区域可能需要改用其他模型 ID。Device Farm 真机始终在 `us-west-2` 运行。
- 管理员账户通过 **Cognito 的 Email 邀请**创建：临时密码会在结束时显示在屏幕上，同时也会发送到你的邮箱。首次登录时网页会要求你设置新密码。
- **再运行一次同一行命令，即可更新到最新版本。**

`scripts/cloudshell-install.sh` 会做这些事：

- 如果这个账户/区域从未做过 CDK bootstrap，就做一次。这是唯一需要管理员权限的步骤。
- 创建只信任 CodeBuild 的 IAM 角色 `playagent-installer`，附加最小权限策略 [`infra/iam/playagent-deployer-policy.json`](infra/iam/playagent-deployer-policy.json)。构建过程不使用 AdministratorAccess。
- 创建 CodeBuild 项目 `playagent-installer`，由它 clone 公开的 GitHub 仓库并运行同一份部署核心（`scripts/deploy-latest.mjs`）。不需要 EC2 实例。
- 实时显示进度，完成后输出网站 URL。

该策略只允许构建代入本账户的 CDK bootstrap 角色、读取 PlayAgent stack、推送 Runner 镜像、创建 Cognito 管理员，以及写入 `/playagent/*` SSM 参数。CloudFormation 的变更通过 CDK 的 `cdk-hnb659fds-cfn-exec-role` 执行，它默认有管理员权限，所以能部署的人仍可通过 CloudFormation 创建资源。

## 快速删除

要移除 PlayAgent，在 CloudShell 运行一行命令：

```bash
curl -fsSL https://raw.githubusercontent.com/hoycdanny/playagent-checker/main/scripts/cloudshell-uninstall.sh | bash
```

- 它会显示相同的**语言菜单**，扫描环境，并列出哪些会删除、哪些会保留。在你确认之前不会删除任何东西：你必须**输入 12 位账户 id** 才能继续。`--yes` 会跳过确认提示（不建议手动使用）；`--region` 默认为 `us-west-2`。
- 它会移除 PlayAgent 自己的资源：六个 `PlayAgentDev-*` 堆栈、保留的数据桶 / Cognito 用户池 / Runner ECR 仓库、安装器的 CodeBuild 项目与 IAM 角色，以及 PlayAgent 的 SSM 参数和日志组。
- 它会保留 CDK bootstrap（`CDKToolkit`）与共享的 `cdk-hnb659fds-*` 资产（其他应用可能共用），因此之后重装可跳过 bootstrap。

手动完整拆除（与故障排查）请见[清理与故障排查](#清理与故障排查)。

## 技术细节

### 运行环境

| 运行环境 | 由什么运行 | 安装后可用 | 限制 |
| --- | --- | --- | --- |
| **Web 浏览器** | ECS Fargate 上的无头 Chromium（Playwright） | ✅ | — |
| **Android 真机**（Device Farm） | AWS Device Farm + Appium，控制器运行在 Fargate 上 | ✅ | 每个会话 150 分钟（AWS 限制）；“长时”选项每 140 分钟重连一次，游戏会重启 |
| **iOS 真机**（Device Farm） | AWS Device Farm + Appium | ✅ | 需要可安装的 `.ipa`；每个会话 150 分钟 |
| **Android 容器**（Redroid） | 每个任务一台运行 Redroid 的 Graviton EC2（`m7g.xlarge`） | ✅ | 带反模拟器检测的游戏会自行关闭（请使用真机）；不支持视频/音频检查；不支持双指缩放；每次运行 1–72 小时 |
| **Windows PC 游戏** | Amazon GameLift Streams（NVIDIA GPU，`gen6n_medium_win2022`） | ⚙️ 需一次性设置（见[可选：Windows](#可选windows-pc-游戏gamelift-streams)） | 每次运行 ≤ 60 分钟；总像素 ≤ 1920×1080 |
| iOS 模拟器 / Linux | — | ❌ 未实现 | — |

各类游戏该选哪种运行环境：[docs/design/multi-platform-workers.md](docs/design/multi-platform-workers.md)。

### 默认提供的功能

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
| 系统管理页面 → **系统更新** | ✅ 开启 | 从 GitHub 一键更新。无需 Token（仓库为公开）；Token 仅为可选，只用于提高 GitHub API 速率限制（[见下方](#可选一键系统更新)）。 |
| 系统管理页面 → **集中式日志** | ✅ 开启 | 在一处搜索所有服务的 CloudWatch 日志以排查失败（[见下方](#集中式日志)）。 |
| 系统管理页面 → **UI-TARS** | ⛔ **关闭** | GPU 定位模型。管理员在页面上开启/关闭；仅在开启期间计费（[见下方](#可选ui-tars-定位模型)）。 |
| Windows 运行环境 | ⚙️ 可选 | 需在 Windows 机器上完成一次性 GameLift Streams 设置。 |

### 架构

```mermaid
flowchart TB
  user["用户 / 浏览器"]
  cf["CloudFront + S3<br/>网页控制台(React)"]
  cognito["Amazon Cognito"]

  subgraph cp["控制面"]
    apigw["API Gateway<br/>HTTP + WebSocket"]
    api["API Lambda"]
    sqs["SQS 派发队列"]
    disp["Dispatcher Lambda"]
    engine["Engine Lambda<br/>(编排器)"]
  end

  subgraph data["数据与 AI"]
    s3[("S3 数据桶<br/>(按租户分前缀)")]
    sm["Secrets Manager<br/>(测试凭据;可选的 GitHub token)"]
    bedrock["Amazon Bedrock<br/>(模型、知识库)"]
  end

  subgraph rt["执行环境(有任务才启动,结束即关闭)"]
    web["Fargate:Web runner<br/>(Playwright Chromium)"]
    df["Fargate:Device Farm runner"]
    dfx["AWS Device Farm<br/>实体手机(us-west-2)"]
    redroid["EC2 Graviton:Android 容器<br/>(Redroid)"]
    win["GameLift Streams:Windows<br/>(GPU,可选)"]
  end

  subgraph adm["系统管理(仅管理员)"]
    update["CodeBuild 自我更新<br/>(从 GitHub cdk deploy)"]
    uitars["SageMaker UI-TARS<br/>(可选,默认关闭)"]
  end

  user --> cf
  user -- "REST + WebSocket<br/>(Cognito JWT)" --> apigw
  cognito -. JWT .- apigw
  apigw --> api
  api -- "POST /tasks" --> sqs --> disp --> engine
  api --> s3
  api --> sm
  api --> bedrock
  engine -- "启动 runner" --> web
  engine --> df
  engine --> redroid
  engine --> win
  df --> dfx
  web & df & redroid & win -- "截图 → 模型 → 操作" --> bedrock
  web & df & redroid & win -- "进度、截图、报告" --> s3
  df -. "定位(开启时)" .-> uitars
  apigw -. "实时进度" .-> user
  api -- "开启 / 关闭" --> uitars
  api --> update
  update -- "重新部署 stack" --> cp
```

CDK 堆栈（全部位于 `us-west-2`）：

| 堆栈 | 内容 |
| --- | --- |
| **Foundation** | S3 数据桶、Cognito 用户池、租户 IAM 角色、Bedrock KB 服务角色。 |
| **ControlPlane** | HTTP API + JWT 授权方、API Lambda、WebSocket API。 |
| **Scheduling** | SQS 分发队列 + Dispatcher Lambda。 |
| **Execution** | Engine Lambda、ECS 集群 + Fargate 任务定义、ECR 仓库、VPC（无 NAT 网关）、按任务启动的 EC2 配置。 |
| **Frontend** | CloudFront + S3 静态站点。 |
| **Updater** | 从 GitHub 版本重新部署上述五个堆栈的 CodeBuild 项目;由安装器自动部署。 |

详情：[docs/architecture.md](docs/architecture.md)。

### 费用

在本项目自己的账户中实测（2026 年 10 月）。AWS 价格会变动，以下数据仅供估算。

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

### 功能（各页面用途）

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
| **系统管理**（管理员） | 从 GitHub 进行**系统更新**（一键、无需 Token;版本对比、进度、历史记录）、**UI-TARS** 开关，以及**集中式日志**（跨所有服务搜索 CloudWatch 日志）。 |

### AI：三个模型“席位”

模型按**角色（席位）**组织，而不是按厂商。每个席位按任务选择：

- **Agent（决策）**：根据屏幕和目标决定下一步操作。默认 **Amazon Nova Lite**。
- **VLM（屏幕分析 / 坐标）**：把“要点击的东西”转换成像素坐标。默认 **Moonshot Kimi K3**。UI-TARS-1.5-7B 仅在管理员开启后才会出现在这里。
- **Subagent（辅助）**：检查操作是否生效、追踪数值、确认是否完成。默认 **Amazon Nova Micro**。

你无需选择 SDK 或端点；系统会根据模型 ID 自动推导。

### 费用护栏

每个任务都可以设置步数上限和预算。运行前，引擎会为每个席位的模型**锁定价格快照**（fail-closed：价格未知时拒绝运行）。花费达到预算后执行即停止，报告中会显示实际花费和 Token。

### 系统管理

**系统管理**页面（仅管理员）提供三项工具。

**一键自更新。** Updater 堆栈由安装器自动部署，因此安装完成后即可使用。打开**系统管理 → 系统更新**，选择版本并确认；它会先运行测试，然后在 CodeBuild 中执行 `cdk deploy`。无需 GitHub Token：仓库为公开，更新会直接 clone。Token 为可选，只用于提高 GitHub API 速率限制；若在**系统管理**中设置，它会存储在 Secrets Manager（`playagent/github`）中，之后不会再显示。使用的是 Fork？请以 `-c githubRepo=owner/name` 部署。更新按钮会以高权限重新部署 IAM 和各类资源，因此只有管理员能看到，且每次运行都会被记录。设计说明：[docs/design/self-update.md](docs/design/self-update.md)。

**集中式日志。** 用于调试的跨服务日志查看器。它使用 CloudWatch Logs Insights，一次搜索所有服务的 CloudWatch 日志（控制平面 API、engine、dispatcher、WebSocket、两个 Fargate Runner、系统自更新与镜像构建 CodeBuild），可按服务筛选、设置时间范围（最近 15 分钟 / 1 小时 / 3 小时 / 24 小时）和关键字。结果按最新优先排序，并可下载。仅限管理员。设计说明：[docs/design/centralized-logs.md](docs/design/centralized-logs.md)。

**UI-TARS 开关。** 管理员可在此开启或关闭可选的 GPU 定位模型，仅在开启期间计费。设置与细节请见[手动安装](#手动安装)中的“可选：UI-TARS 定位模型”。

### 术语表

- **Seat（席位）**：模型角色（Agent / VLM / Subagent），而不是厂商。
- **VLM**：Vision-Language Model（视觉语言模型）；读取截图并定位坐标。
- **UI-TARS**：字节跳动针对 GUI 定位微调的视觉模型，通过 vLLM 部署在 SageMaker 上。可选，默认关闭。
- **Redroid**：在 ARM EC2 主机上以容器方式运行的 Android（即“Android 容器”运行环境）。
- **Locality（位置）**：设备所在位置：`cloud`（云端提供）或 `attached`（你的本地设备，仍由云端驱动）。
- **Terminal state（终止状态）**：`pass` / `fail` / `error` / `cancelled` / `budget_exceeded` / `dead`。
- **Fail-closed**：价格未知时宁可拒绝运行，也不在未知价格下产生花费。

---

## 使用手册

以下按照第一次运行会经过的顺序，逐页说明网页控制台。六项前提通用于整节：

- 截图为真实截取：网页控制台在本机运行、连接已部署的后端，以简体中文界面拍摄。界面语言可在顶部工具栏的语言菜单切换，共五种语言，每份 README 只放自己语言的截图。
- 受测游戏为 `https://play.slotomania.com/slots/`（App 名称 `Slotomania (web demo)`）；另一个 App `Example Slots Mobile`（`com.example.slotsgame`）为合成的占位数据。所有运行都使用隔离 `demo` 租户内的临时账号 `qa-demo@example.com`，拍摄结束后该租户数据与账号已删除。
- AI agent 的步骤说明与报告正文（包括 agent 记在记忆地图里的画面名称）无论界面语言如何，一律以繁体中文生成。第 27–48 张截图中的这些区域以斜纹遮罩覆盖，页面其余部分保持拍摄原样。让生成的文字跟随界面语言是已知的待办事项。
- 标注 *仅管理员* 的页面与控件，不具管理员角色的账号看不到。
- 路由均为 hash 路由，接在安装器输出的网站地址之后，例如 `https://<site-url>/#/apps`。
- 其余限制：日文与韩文的报告正文由后端以英文提供；AI agent 的步骤推理与记忆地图中的画面名称属于模型与游戏数据；游戏本身的画面文字使用游戏的语言。

重新生成截图时，在仓库根目录执行：

```bash
npm ci --prefix tools/screenshots
npx --prefix tools/screenshots playwright install chromium
node tools/screenshots/capture.mjs
```

拍摄不会部署或变更任何堆栈，只需要已部署在 `us-west-2` 的后端。

### 登录

路由：`#/`——验证成功前都显示此页，在此之前无法进入其他路由。

![字段尚未填写的登录页](docs/screenshots/zh-Hans/01-login.png)

登录卡片会向安装器创建的 Cognito 用户池验证账号。

- 凭据：安装时发出的邮箱与密码，或日后由管理员在**成员管理**创建的账号。
- 语言：卡片内的菜单可在登录前切换界面语言。
- 受邀账号必须在首次登录时设置永久密码。

### 使用说明

路由：`#/guide`

![应用内使用指南](docs/screenshots/zh-Hans/02-guide.png)

**使用说明**是登录后的首页，以 14 个章节说明整个平台。

- 内容涵盖运行环境、三个模型席位、费用护栏、报告格式与术语表。
- 任何无法识别的路由都会跳转到这里。

### 应用管理

路由：`#/apps`

![应用卡片墙](docs/screenshots/zh-Hans/04-apps.png)

**应用管理**为每个游戏或应用保留一个工作区，点击卡片即进入该工作区。

- 每张卡片显示名称、平台、类型，以及当前的安装包或测试地址。
- 删除应用会连带清除其用例、任务、报告与记忆地图，并在清除完成前持续回报进度。

#### 新增应用

![新增应用表单](docs/screenshots/zh-Hans/03-apps-create-form.png)

新增表单用于登记被测目标，这是其他所有页面的前提。

- 名称与类型：类型决定后续任务可选用哪些内建知识库。
- 平台：`web`、`android`、`ios` 或 `windows`，同时决定默认运行环境。
- 目标：网页标题填测试地址，商店版本填包标识（例如 `com.example.slotsgame`）；安装包稍后在**版本**分页上传。

### 应用工作区

路由：`#/apps/:appId`

工作区是单个应用的视图。其八个分页的状态保存在 `?tab=` 查询参数中，因此可直接链接到单个分页。

#### 总览

![工作区总览分页](docs/screenshots/zh-Hans/09-workspace-overview.png)

**总览**汇总该应用的概况：用例、任务与报告的数量，以及最近一次运行。

#### 测试用例

![工作区测试用例分页](docs/screenshots/zh-Hans/11-workspace-cases.png)

**测试用例**列出为此应用定义的流程，使用与下方“测试用例”相同的编辑器。

- 每一行显示用例名称、版本戳与作者。
- 用例在保存时建立版本，因此报告一定会标明实际运行的版本。

#### 测试任务

![工作区测试任务分页](docs/screenshots/zh-Hans/24-workspace-tasks.png)

**测试任务**列出此应用的运行记录，也是提交新运行的位置。

![填好的提交任务表单](docs/screenshots/zh-Hans/25-task-submit-form.png)

提交表单在运行开始前就确定所有必要条件：

- 用例与运行环境：运行环境默认按应用平台决定（网页标题为 `Web browser`）。
- 模型席位：Agent、VLM 与 Subagent，各自锁定价格快照；价格未知即拒绝运行。
- 上限：步数上限与美元预算；任一项达到即停止运行。
- 知识库：已在“知识”分页存为此 App 默认的知识库会预先选中，另可附加其他知识库。

#### 测试报告

**测试报告**分页是按此应用过滤后的报告列表，内容与下方“测试报告”相同，配图亦置于该处。

#### 记忆地图

![工作区记忆地图分页](docs/screenshots/zh-Hans/45-workspace-memory.png)

**记忆地图**显示此应用历次运行学到的画面，画面为节点并附缩略图，画面跳转为连线。

#### 测试凭证

![工作区测试凭证分页](docs/screenshots/zh-Hans/13-workspace-credentials.png)

**测试凭证**将应用的登录密钥存放在 AWS Secrets Manager，只返回其键名。

- 用例以 `${KEY}` 引用已保存的值；用例中出现明文密码会在保存时被拒绝。
- 值只在运行容器内替换，不会写入报告或截图。

#### 版本

![工作区版本分页](docs/screenshots/zh-Hans/10-workspace-builds.png)

**版本**保存已上传的安装包（APK/IPA/XAPK/ZIP/EXE），并标明下一次运行要安装哪一个。

#### 知识

![工作区知识分页](docs/screenshots/zh-Hans/12-workspace-knowledge.png)

**知识**把知识库绑定到应用，使每个任务都自动继承。截图中仅列出内建知识库。

### 测试用例

路由：`#/cases`

![跨所有应用的测试用例](docs/screenshots/zh-Hans/14-cases.png)

**测试用例**列出租户内所有应用的用例，打开的编辑器与工作区分页内嵌的是同一个。编辑器有三种撰写模式。

#### 自然语言

![自然语言撰写模式](docs/screenshots/zh-Hans/05-case-form-nl.png)

**自然语言**由一段白话描述草拟用例：草拟模型会把它转成 YAML 供审阅。

- 草拟模型在表单中选择，草稿一律落在**原始 YAML**，保存前可先检查。

#### 验收标准

![结构化验收标准编辑器](docs/screenshots/zh-Hans/06-case-form-acceptance.png)

验收标准编辑器定义什么算通过，一行一条标准，这些行会成为报告中的判定表。

- 每一行包含编号、描述，以及 AI 必须产出的证据。

#### 原始 YAML

![原始 YAML 撰写模式](docs/screenshots/zh-Hans/07-case-form-yaml.png)

**原始 YAML** 是用例的保存形式，也是不调用模型的确定性路径。

- 键：`url` 或应用目标、`task` 填目标、`acceptance` 填验收标准。
- 若凭据类的键其值不是 `${ENV}` 占位符或密钥引用，保存时会被拒绝。

#### 从 Excel 导入

![Excel 导入模式](docs/screenshots/zh-Hans/08-case-form-excel.png)

**从 Excel 导入**把既有的测试步骤表格转成用例，每一个行区块对应一个用例。

### 知识管理

路由：`#/knowledge`

![内建知识模板](docs/screenshots/zh-Hans/15-knowledge-templates.png)

**知识管理**管理任务可读取的内容：Markdown 全文注入，PDF 则按需检索。

#### 类型样板（内建）

第一个分页提供平台自带的内建类型与场景知识库，无需任何设置。

#### 我的知识库

第二个分页存放在本平台上传的知识库。此处仅以文字说明、不附截图，因为其内容跨租户共用，共用素材不适合出现在公开图片中。

### 设备管理

路由：`#/devices`

![设备管理页面](docs/screenshots/zh-Hans/16-devices.png)

**设备管理**回报当前可用的执行资源，以及接入平台的本地设备。

- **云端设备**：当前可用的 Device Farm 手机；每次运行租用一台，结束即释放。
- **容器（Fargate）**、**每任务主机（EC2）** 与 **Windows 串流（GameLift Streams）**：只读快照，约每 30 秒刷新。这三份列表属于账号范围而非单个租户，因此截图时隐藏了列表内容。
- **本地设备**：已注册的本机运行 agent，仍由云端操控。
- **被测登录密钥引用**：与工作区**测试凭证**分页相同的密钥存放区，按键名列出。

### 费用分析

路由：`#/cost`

![测试费用分页](docs/screenshots/zh-Hans/17-cost.png)

**费用分析**把测试花费与 AWS 实际账单分开呈现。

#### 測試費用(依應用)

第一个分页按每次运行的 token 数与 Device Farm 计费分钟数，推算各应用、各模型的花费，并按日汇总。

#### AWS 帳單(實際)

第二个分页从 Cost Explorer 读取实际账单。此处仅以文字说明、不附截图，原因是该视图属于账号范围，且每次加载都会产生一次 Cost Explorer 查询费用。费率与实测的每日金额请见[费用](#费用)。

### 成员管理

路由：`#/members`——*仅管理员*

![过滤为单个账号的成员列表](docs/screenshots/zh-Hans/18-members.png)

**成员管理**管理谁能登录，以及每个账号属于哪个租户。

- 搜索框与四个筛选条件（**全部** / **启用中** / **已停用** / **管理员**）可缩小表格范围；截图已过滤为单个账号。
- 行操作：重置密码、停用或启用、变更租户、授予或移除管理员、删除。

#### 新增成员

![新增成员表单](docs/screenshots/zh-Hans/19-members-add.png)

新增表单以指定租户与初始密码创建账号；同一租户内的账号共用其应用与测试数据。

- **初始密码**至少 8 个字符，需含大小写字母与数字。截图中该字段为空。

### 模型管理

路由：`#/model-admin`——*仅管理员*

![模型管理页面](docs/screenshots/zh-Hans/20-model-admin.png)

**模型管理**列出各席位可用的模型及其定价，运行时的价格快照即来自此处。

- 价格未知的模型无法选用，因为价格未知的运行会被拒绝。

### 系统管理

路由：`#/system`——*仅管理员*

#### 系统更新

![系统更新区块](docs/screenshots/zh-Hans/21-system-update.png)

**系统更新**比对当前部署的版本与 GitHub 上的最新版本，并通过 CodeBuild 重新部署。

- 页面列出当前部署的版本、GitHub 上的最新版本与更新历史；部署前会先运行测试。
- 确认此操作会以高权限重新部署 IAM 与基础设施，因此仅限管理员，且每次运行都会留下记录。

#### UI-TARS 定位模型

![保持关闭的 UI-TARS 开关](docs/screenshots/zh-Hans/22-system-uitars.png)

**UI-TARS 定位模型**开关用于启动或停止可选的 GPU 端点，开启期间持续计费。

- 开关默认关闭，本次截图亦保持关闭。开启期间实测费用为每天 US$62.53。

#### 集中日志

![集中日志查询条件](docs/screenshots/zh-Hans/23-system-logs.png)

**集中日志**以 CloudWatch Logs Insights 一次查询所有服务的日志。

- 控件：服务筛选、时间范围（15 分钟至 24 小时）与关键字。截图显示尚未执行查询的状态。

### 测试任务

路由：`#/tasks`

![含运行中任务的任务列表](docs/screenshots/zh-Hans/26-tasks-running.png)

**测试任务**列出租户内所有运行记录，最新优先，也是进入运行中任务的入口。

- 每一行显示任务 id、应用、用例、运行环境、状态与已耗时间。
- 终止状态为 `pass`、`fail`、`error`、`cancelled`、`budget_exceeded` 与 `dead`。

### 任务详情

路由：`#/tasks/:jobId`

详情页左侧固定为实时画面，右侧显示八个面板之一。其中三个面板只在运行进行中才有实时数据。

#### 即時日誌

![运行中的任务详情](docs/screenshots/zh-Hans/27-task-detail-live.png)

**即時日誌**在运行期间逐步跟随进度，与实时画面及步骤时间轴并列。

#### 完整日誌

![运行中的完整日志面板](docs/screenshots/zh-Hans/28-task-detail-live-logs.png)

**完整日誌**收集该次运行的 runner 与设备日志。

![运行结束后的完整日志面板](docs/screenshots/zh-Hans/31-task-detail-logs.png)

进入终止状态后，同一面板保存已完成运行的完整日志。

#### 執行軌跡

![执行轨迹面板](docs/screenshots/zh-Hans/30-task-detail-trace.png)

**執行軌跡**即逐步记录：一行一个动作，附截图、操作对象与结果。

#### 數據分析

![数据分析面板](docs/screenshots/zh-Hans/32-task-detail-analysis.png)

**數據分析**把运行期间观测到的数值画成图表，每个选中的指标一条序列。

#### Token 用量

![Token 用量面板](docs/screenshots/zh-Hans/33-task-detail-usage.png)

**Token 用量**按席位与步骤拆解花费，并列出该次运行的总成本。

#### 腳本與執行資訊

![脚本与执行信息面板](docs/screenshots/zh-Hans/34-task-detail-script.png)

**腳本與執行資訊**记录这次运行采用的用例版本、运行环境与上限设置。

#### AI 問答

![有一问一答的 AI 问答面板](docs/screenshots/zh-Hans/35-task-detail-ask.png)

**AI 問答**按该次运行自身的轨迹、日志与指标回答问题。

#### 與畫面互動

**與畫面互動**显示各代理的推理过程，并可在运行中下达指示。它只在纵向版面成为独立分页；截图采用的横向版面中，该内容紧邻实时画面。

### 实时画面

路由：`#/live/:jobId`

![弹出式实时画面](docs/screenshots/zh-Hans/29-live-popout.png)

弹出窗口只呈现实时画面本身，不含导航栏，适合第二屏幕或共享视图。

- 此路由由详情页打开，并在运行进入终止状态前持续可用。

### 测试报告

路由：`#/reports`

![报告列表](docs/screenshots/zh-Hans/36-reports.png)

**测试报告**列出租户内已完成的报告；每一次进入终止状态的运行都会产生一份报告。

### 报告

路由：`#/reports/:jobId`

报告是一份可滚动的文档，以下按阅读顺序说明各区块。

#### 報告封面

![报告封面](docs/screenshots/zh-Hans/37-report-cover.png)

封面载明整体测试状态、应用、用例版本与运行摘要。

#### 驗收結論與標準

![验收判定表](docs/screenshots/zh-Hans/38-report-acceptance.png)

此区块逐条判定用例的验收标准，并列出判定所依据的证据。

#### 判定明細

![判定明细](docs/screenshots/zh-Hans/39-report-verdicts.png)

明细表每一行是一次通过/失败判定：里程碑由程序按整体证据判定；逐步判定由 AI 在动作前宣告预期，并在下一个画面判定是否达成。

- 点开一行可展开动作前后截图、判定依据与修正建议。

#### AI 執行證據

![AI 执行证据](docs/screenshots/zh-Hans/40-report-evidence.png)

证据区块逐步重现运行过程，每一步附当时的截图与推理记录。

#### 發布準備度

![发布准备度](docs/screenshots/zh-Hans/41-report-release.png)

发布准备度按设定的门槛把各项判定换算成建议，包含覆盖不足而无法判定的情况。

#### 報告導讀——導讀

![报告助手：导读分页](docs/screenshots/zh-Hans/42-report-assistant-guide.png)

报告助手由报告边缘的启动器打开，默认停在**導讀**，说明判定的依据以及结论的适用范围到哪里为止。

#### 報告導讀——問答

![报告助手：问答分页](docs/screenshots/zh-Hans/43-report-assistant-ask.png)

**問答**按报告自身的数据回答关于这份报告的问题。截图显示已提出的问题与其回答（回答语言与界面不同处已遮罩）；同一组件已回答的对话也见上方的“AI 問答”。

#### 報告導讀——判定覆核

![报告助手：判定覆核分页](docs/screenshots/zh-Hans/44-report-assistant-review.png)

**判定覆核**用于更正有争议的判定：可附理由覆写某项发现，该覆写会随报告保存，并回写到应用的记忆地图。截图显示本次运行没有待覆核发现时的空状态。

### 记忆地图

路由：`#/memory`

记忆地图会跨运行累积：画面成为节点，画面跳转成为连线，之后的运行据此导航，不必重新探索。

#### 关系图

![记忆地图：关系图](docs/screenshots/zh-Hans/46-memory-graph.png)

**关系图**绘制菜单中所选应用的画面与跳转，并显示画面、跳转与控件的数量。

#### 样片本

![记忆地图：样片本](docs/screenshots/zh-Hans/47-memory-grid.png)

**样片本**以缩略图呈现同一批画面，按外观查找画面时更快。

#### 画面工作区

![打开单个画面的画面工作区](docs/screenshots/zh-Hans/48-memory-screen-studio.png)

点击画面会打开其工作区，内有三个分页：**腳本與操作**显示记录到的控件、**畫面說明**显示描述、**Appium 程式碼**显示生成的脚本。

- 清除某个应用的记忆后，下一次运行会从零重新学习。

---

## 手动安装

想从自己的电脑部署，或需要某项一次性的可选设置？请使用以下路径。[快速开始](#快速开始)中的 CloudShell 一行命令是最简单的方式，本节涵盖其余所有情况。

### Windows 和 macOS 推荐：一键安装／更新

先安装 **Node.js 22、AWS CLI v2、Git、Docker Desktop**，完成 AWS 登录并启用下文列出的 Bedrock 模型。然后 clone 仓库并运行：

```text
Windows：双击 Install-Latest.cmd
macOS：  双击 Install-Latest.command
Linux：  运行 scripts/deploy-latest.sh
```

这三个启动器共用同一份部署核心，默认区域为 **`us-west-2`（美国西部，俄勒冈）**（可用 `--region` 更改）。

任何系统都可以使用 `npm run deploy:latest -- --expected-account-id 123456789012` 校验 AWS 账户。旧的 Windows PowerShell 脚本仍可使用，但只是兼容包装；三个系统共用同一份 Node.js 部署核心。

也可以运行 `npm run deploy:latest`。安装器会**原样部署这个文件夹**，不会自行拉取新版；要部署最新的 `main`，请先 `git pull`。版本标签为 Git commit SHA（从没有 `.git` 的 ZIP 解压则为 `local-<UTC 时间>`）；有未提交的更改时会一并部署，并给出警告、使用 `<sha12>-dirty-<UTC 时间>` 标签。它会依 lockfile 安装、测试、部署所有堆栈与更新器（Updater）；Runner 镜像同时推送版本标签与 `latest`，ECS 任务定义锁定版本标签。最后会验证 CloudFormation、ECR digest、ECS 镜像和 CloudFront。不会重置、stash 或清除本机文件。

为避免部署到错误环境，建议使用 `npm run deploy:latest -- --expected-account-id 123456789012` 检查 AWS 账户。首次安装结束前，交互式安装只询问管理员的 **Email（登录 username）**和以隐藏方式输入的密码。tenant 默认为 `default`；只有高级场景才需要用 `--admin-tenant <tenant>` 覆盖。

非交互自动化时，绝对不要把密码放进命令行参数。请从秘密管理器把密码通过 stdin pipe 给安装器：

```bash
# bash / zsh（macOS 或 Linux）
aws secretsmanager get-secret-value --region us-west-2 --secret-id playagent/admin-password --query SecretString --output text | npm run deploy:latest -- --non-interactive --admin-email admin@example.com --admin-password-stdin
```

```powershell
# PowerShell
(aws secretsmanager get-secret-value --region us-west-2 --secret-id playagent/admin-password --query SecretString --output text) | npm run deploy:latest -- --non-interactive --admin-email admin@example.com --admin-password-stdin
```

```bat
rem 命令提示符（cmd.exe）
aws secretsmanager get-secret-value --region us-west-2 --secret-id playagent/admin-password --query SecretString --output text | npm run deploy:latest -- --non-interactive --admin-email admin@example.com --admin-password-stdin
```

以上示例不含任何明文密码。只有需要覆盖默认 tenant 时才加上 `--admin-tenant <tenant>`。

> 一键方式需要 Docker Desktop；下面的手动 CodeBuild 方式仍不需要 Docker。
>
> **在 `cdk destroy` 后重装：**数据桶、Cognito User Pool 和 Runner ECR 都有 `Retain` 保护。安装器会检测并复用保留的 ECR，避免同名 Repository 阻塞重装；但不会自动删除或接管旧数据桶/User Pool。若要真正完全清空，请先备份，再明确删除这些保留资源。

### 手动安装（分步说明）

本节假设你**没有任何 AWS 使用经验**。请从上到下依次操作。总耗时约 **60–90 分钟**，大部分时间在等待 AWS。

> 所有资源都部署到 **`us-west-2`（美国西部，俄勒冈）**。除非你清楚自己在改什么，否则所有地方都使用该区域。
>
> 命令以 **bash** 编写（macOS、Linux、Git Bash、WSL）。在 Windows PowerShell 中，请用 `$env:NAME="value"` 设置变量，而不是 `NAME=value command`。

#### 第 0 步：在电脑上安装工具

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

#### 第 1 步：获取代码

```bash
git clone https://github.com/hoycdanny/playagent-checker.git
cd playagent-checker
npm install
```

#### 第 2 步：将 AWS CLI 连接到账户

向账户所有者索取 **Access Key ID** 和 **Secret Access Key**（AWS 控制台 → IAM → Users → Security credentials → Create access key）。然后：

```bash
aws configure
# AWS Access Key ID     : <粘贴>
# AWS Secret Access Key : <粘贴>
# Default region name   : us-west-2
# Default output format : json

aws sts get-caller-identity   # 应输出你的账户编号
```

> 该凭据必须能够创建 Lambda、S3、Cognito、API Gateway、IAM、ECS、EC2、ECR、CodeBuild、SageMaker、Bedrock 和 CloudFront 资源。首次设置时，使用管理员用户（`AdministratorAccess`）最简单。

#### 第 3 步：开启 AI 模型（Amazon Bedrock）

新账户的 Bedrock 模型默认**关闭**。需要启用一次，否则每次运行都会失败。

1. AWS 控制台 → **Bedrock** → 区域（右上角）选择 **US West (Oregon) us-west-2**。
2. 左侧菜单 → **Model access** → **Enable specific models**。
3. 至少启用：
   - **Amazon – Nova Lite**（默认决策模型）
   - **Amazon – Nova Micro**（默认辅助模型）
   - **Moonshot AI – Kimi K3**（默认屏幕分析模型）
   - **Anthropic – Claude Sonnet 4.5**（起草测试用例、读取导入的电子表格）
   - **Amazon – Titan Text Embeddings V2**（知识库搜索）
4. 等待状态变为 **Access granted**。评估阶段启用该区域的所有模型也没问题；应用会为每个席位列出所有可用模型。

#### 第 4 步：准备 CDK（每个账户一次）

```bash
cd infra
npx cdk bootstrap aws://ACCOUNT_ID/us-west-2
```

将 `ACCOUNT_ID` 替换为第 2 步输出的账户编号。

#### 第 5 步：部署后端

在 `infra/` 目录下执行：

```bash
AWS_REGION=us-west-2 npx cdk deploy \
  PlayAgentDev-Foundation PlayAgentDev-ControlPlane \
  PlayAgentDev-Scheduling PlayAgentDev-Execution \
  --require-approval never
```

> **可选的成本分配标签。** 每个资源都带有 `project`、`stage`、`component` 标签。可用 `-c` 添加自定义标签（它们也会传递到运行时启动的 EC2/Fargate）：
> `-c costCenter=QA-1234 -c owner=alice -c team=game-qa`（键：`costCenter`、`owner`、`team`、`env`、`costAllocation`）。每次部署都要使用相同的参数。

此过程约需 10–15 分钟。然后输出后续步骤需要的值：

```bash
aws cloudformation describe-stacks --region us-west-2 --stack-name PlayAgentDev-Foundation \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
aws cloudformation describe-stacks --region us-west-2 --stack-name PlayAgentDev-ControlPlane \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'||OutputKey=='WsUrl'].[OutputKey,OutputValue]" --output table
```

记下：

- **Data bucket**：输出名称包含 `DataBucket`（Ref），形如 `playagentdev-foundation-databucket…`
- **User Pool ID**：包含 `UserPoolId`，形如 `us-west-2_XXXXXXXXX`
- **User Pool Client ID**：包含 `UserPoolClientId`
- **ApiUrl**：`https://xxxx.execute-api.us-west-2.amazonaws.com`
- **WsUrl**：`wss://xxxx.execute-api.us-west-2.amazonaws.com/prod`

#### 第 6 步：构建 Runner 镜像（必需）

Web 和 Device Farm Runner，以及让 Windows 测试能跑超过一小时的保活 task，都使用你 ECR 中的容器镜像运行。镜像通过 CodeBuild 在云端构建，因此不会有大文件下载到你的电脑。

```bash
cd ../agent/sagemaker && npm install
export PA_SM_BUCKET=PASTE_DataBucket     # 来自第 5 步，脚本会把构建源码上传到这里
export AWS_REGION=us-west-2

# a) 创建共享的 CodeBuild 角色，并暂存 UI-TARS 权重 + 推理镜像
#    （仅在之后开启 UI-TARS 时需要）。约 20–40 分钟，在 AWS 中运行。
#    不会启动 GPU；存储费用约 US$2/月。
node cloudBuild.mjs

# b) 构建并推送 Runner 镜像（每个需要几分钟）。
node cloudBuildRunner.mjs
node cloudBuildWebRunner.mjs
node cloudBuildKeepAlive.mjs
```

> `PA_SM_BUCKET` 为必填项，请设置为你自己的 Foundation 堆栈输出的 DataBucket；脚本不再包含任何特定账户的桶默认值。

#### 第 7 步：构建 Web 控制台

```bash
cd ../../web
cat > .env.production <<'EOF'
VITE_COGNITO_REGION=us-west-2
VITE_COGNITO_USER_POOL_ID=PASTE_UserPoolId
VITE_COGNITO_CLIENT_ID=PASTE_UserPoolClientId
VITE_API_URL=PASTE_ApiUrl
VITE_WS_URL=PASTE_WsUrl
EOF
npm run build
```

构建前，将每个 `PASTE_...` 替换为第 5 步得到的值。

#### 第 8 步：部署 Web 控制台

```bash
cd ../infra
AWS_REGION=us-west-2 npx cdk deploy PlayAgentDev-Frontend --require-approval never
aws cloudformation describe-stacks --region us-west-2 --stack-name PlayAgentDev-Frontend \
  --query "Stacks[0].Outputs[?contains(OutputKey,'SiteUrl')].OutputValue" --output text
```

打开输出的 `https://xxxx.cloudfront.net` 地址，应能看到登录页面。

#### 第 9 步：创建第一个（管理员）登录账号

自助注册是有意禁用的。最简单的方式是使用上面的一键安装器。手动设置时，运行下面的工具；程序会以隐藏输入方式询问密码，因此密码不会出现在命令或 shell history 中。除非确实需要隔离不同 tenant，否则使用默认的 `default`。

```bash
cd ../agent/sagemaker
AWS_REGION=us-west-2 node createUser.mjs --email admin@example.com --tenant default --admin
```

自动化时，请从秘密管理器把密码 pipe 到 stdin，不要放进 argv：

```bash
aws secretsmanager get-secret-value --region us-west-2 --secret-id playagent/admin-password --query SecretString --output text | AWS_REGION=us-west-2 node createUser.mjs --email admin@example.com --tenant default --admin --password-stdin
```

密码至少需要 8 位，并包含大写字母、小写字母和数字。

之后，其他用户都在**成员管理**页面创建。

#### 第 10 步：登录并运行第一个测试

打开 CloudFront URL 并登录，会进入**指南**页面。然后：

1. **应用管理** → 创建应用（上传 APK/IPA/XAPK，或为 Web 填写 URL）。
2. 在应用工作区 → **测试用例** → 描述一个流程，AI 会把它转换成用例。
3. **测试任务** → 选择用例和运行环境（**Web**、**Android/iOS 真机**或 **Android 容器**）→ 提交。模型默认为 Nova Lite / Kimi K3 / Nova Micro。
4. 实时观看运行过程，然后阅读**报告**。

> **看不到成员管理 / 系统管理菜单？** 这两项仅对管理员显示，而登录 Token 只有在登录时才会获取用户组变更。被设为管理员后，请退出并重新登录。

✅ **至此你已拥有一个可用的环境。** 以下内容均为可选。

---

### 可选：UI-TARS 定位模型

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
      \"Resource\":\"arn:aws:ecr:us-west-2:${ACCOUNT}:repository/playagent-vllm-byoc\"},
     {\"Effect\":\"Allow\",\"Action\":\"s3:ListBucket\",\"Resource\":\"arn:aws:s3:::${BUCKET}\"},
     {\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::${BUCKET}/sagemaker-models/ui-tars/*\"},
     {\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\",\"logs:DescribeLogStreams\",\"cloudwatch:PutMetricData\"],\"Resource\":\"*\"}]}"
   ```
   如需使用其他角色，部署 ControlPlane 时加上 `-c uitarsRoleArn=arn:aws:iam::…:role/…`。

然后在**系统管理 → UI-TARS → 开启**。大约需要 8–15 分钟才会变为**已开启**；启动期间就已开始计费。之后 UI-TARS 会出现在任务的 VLM 菜单中。用完后在同一页面将其**关闭**；关闭会删除 GPU 端点但保留模型设置，因此再次开启无需重新设置。关闭期间，模型菜单会隐藏 UI-TARS，请求使用它的任务会被拒绝。

更多信息：[docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md)。

### 可选：Windows PC 游戏（GameLift Streams）

**在 Windows 机器上**运行一次（它会为 GPU 主机打包 Windows 工具）：

```powershell
cd worker\windows-host\gamelift
npm install
$env:AWS_REGION="us-west-2"; node setup.mjs --capacity 2
```

它会创建 GameLift Streams 应用和一个**没有常驻容量**的串流组（没有测试运行时不计费），最多支持 2 个并发运行。之后提交任务时会出现 **Windows** 运行环境。首次启动需要 10–15 分钟；每次运行上限 60 分钟。修改 Windows 主机脚本后需重新运行 `setup.mjs`；系统自更新不涵盖这部分。

### 启用费用分析页面

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
AWS_REGION=us-west-2 npx cdk destroy --all
```

另外还会遗留：Runner ECR 仓库 `playagent-exploration-runner` / `playagent-web-runner` / `playagent-keepalive-runner`（CDK 默认保留）、ECR 仓库 `playagent-vllm-byoc`、CodeBuild 项目 `playagent-uitars-build` / `playagent-runner-build` / `playagent-web-runner-build` / `playagent-keepalive-runner-build`、角色 `PlayAgentCodeBuildUitarsRole`、SageMaker 模型/配置 `ui-tars-playagent-*`，以及（如已设置）GameLift Streams 应用和串流组。

| 现象 | 解决方法 |
| --- | --- |
| 部署失败：*"not bootstrapped"* | 针对 `us-west-2` 执行第 4 步。 |
| 运行报错 *AccessDenied* / 模型不可用 | 在 **us-west-2** 中启用模型访问（第 3 步）。 |
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
