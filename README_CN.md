# PlayAgent Checker

**AI 驱动的游戏 / App 自动化测试平台。** 你用大白话描述要测的流程,AI 代理就会自己看画面、帮你点击滑动、判断成败,并产出含截图、逐步轨迹与导览地图的多语报告。

> 语言:[English](README.md) · [繁體中文](README_ZH.md) · **简体中文** · [日本語](README_JP.md) · [한국어](README_KR.md)

---

## 这是什么

PlayAgent Checker 完全运行在 **AWS(区域 `us-east-2`)**:一套 serverless 控制面加上按需执行的 runner。你上传 App(或指定网址),代理自主探索,你就得到可重复、可审阅的测试结果。

- **两个真实执行后端,均已端到端验证:** **Web**(Playwright headless Chromium,运行在 ECS Fargate)与 **Device Farm**(AWS Device Farm 的 Android/iOS 真机,以 Appium 驱动)。
- **代理循环:** 截图 → VLM 判坐标 → Agent 决策 → 在设备上执行 → 再截图,直到达成目标或触发停止条件。
- **精准 GUI 定位(可选):** 判坐标的 VLM 座位可改用 SageMaker 上的 **UI-TARS-1.5-7B**,在繁复游戏美术上坐标准得多。
- **知识库、成本护栏,以及 5 语系界面**(zh-Hant、en、zh-Hans、ja、ko)。

架构细节:[docs/architecture.md](docs/architecture.md)。

## 适合谁用

- **QA 团队**:不想写、也不想维护脆弱 UI 脚本,却要测游戏/App。
- **多产品的游戏公司**(老虎机、RPG、MMORPG、休闲…):每次改版都要跨 build 做可重复的冒烟/回归测试。
- **任何人**:能用文字描述流程,但不想学自动化框架。

## 运作原理(端到端)

```
① 创建应用    上传 APK/IPA/ZIP,或指定网址。标上游戏类型。
② 撰写用例    用大白话描述流程 → AI 产出可执行 YAML。
③ (可选)知识库  挂游戏类型或情境知识,让 AI 懂这个领域。
④ 提交任务    选执行环境(Web / Device Farm)+ 定位模型,排入云端队列。
⑤ AI 执行    截图 → VLM 判坐标 → Agent 决策 → 执行操作 → 循环。
⑥ 报告 + 记忆  多语报告(叙述、截图、逐步轨迹、成本)+ 跨次累积的导览地图。
```

AI **不依赖脆弱的元件选择器** —— 它像真人测试员一样「看实际画面」,所以连没有可检视 UI 树的画布型游戏(Cocos2d-x、Unity)也能测。

## 功能总览(每个页面在做什么)

| 页面 | 用途 |
| --- | --- |
| **使用说明** | 内建的操作导览(登录后的首页),5 种语言。 |
| **应用管理** | 每款游戏/App 一个工作区。填名称 + 平台 + 类型;原生上传产物,Web 只需网址。集中管理该 App 的用例、任务、报告、记忆。 |
| **测试用例** | 一个用例 = 一段要 AI 执行的流程。用大白话草拟(AI → YAML)或手写 YAML。密钥用 `${ENV}` 占位,明文密码会被拦。 |
| **测试任务** | 把用例送去执行。选**执行环境**(Web 浏览器或 Device Farm 真机)、**定位模型**(默认 UI-TARS)、并复选**知识库**。可实时监看、随时取消。 |
| **测试报告** | 只读结果:AI 叙述、逐步轨迹、游戏截图、导览关系图,以及预算 vs 实际花费与 token 用量。 |
| **记忆地图** | 跨多次测试累积的 App 全景:走过的画面成为节点、操作转移成为连线 —— 后续测试更快定位。 |
| **知识管理** | 跨用户共用的知识库。两种(游戏类型 / 情境),各可放 **Markdown**(整份注入)与/或 **PDF 检索**(对上传文档做向量搜索)。 |
| **设备管理** | 浏览 AWS Device Farm 当前可用的真实机型。云端 runner 按任务自动创建、结束即回收,无需手动管理。 |

## AI:三个模型「座位」

模型按**职责(座位)**分工,而非绑定供应商。每个座位可各自独立选模型:

- **Agent(决策)** —— 主脑;看当前画面与目标,决定下一步做什么。
- **VLM(判坐标)** —— 视觉;把「要点的东西」转成画面上的实际像素。**默认用 SageMaker 上的 UI-TARS-1.5-7B**(专为 GUI grounding 微调,在游戏美术上比通用模型准得多,且回复繁体中文)。
- **Subagent(辅助)** —— 用较便宜的模型处理轻量子任务,省成本。

知识库检索另用 **Amazon Titan Text Embeddings v2** 搭配 **Amazon Bedrock Knowledge Bases + S3 Vectors**。你不需选 SDK/端点 —— 系统依 modelId 自动推导。

## 成本护栏

每个任务都有预算上限。执行前先为各座位模型**锁定单价快照**(Fail Closed:查不到价就拒绝执行,绝不以未知成本起跑)。累计花费达上限即停,报告显示实际花费与 token 用量。

## 名词说明

- **Seat(座位)** —— 模型的职责(Agent / VLM / SubAgent),非供应商。
- **VLM** —— 视觉语言模型;读截图并定位坐标。
- **UI-TARS** —— ByteDance 专为 GUI grounding 微调的视觉模型,以 vLLM 部署在 SageMaker;在 smart-resize 后的图上回报绝对像素坐标。
- **Agent 执行循环** —— 截图 → VLM 判坐标 → Agent 决策 → 执行 → 再截图。引擎恒在云端(Lambda 编排,执行容器在 Fargate)。
- **知识库** —— Markdown(整份注入)或 PDF 检索(按任务目标做向量搜索)。
- **Locality(运行地)** —— 被测设备在哪:`cloud`(云端供给)或 `attached`(你注册的本地设备,仍由云端大脑远程驱动)。
- **终局状态** —— 任务结束状态:`pass` / `fail` / `error` / `cancelled` / `budget_exceeded` / `dead`。
- **Fail-closed** —— 查不到单价时,宁可不跑也不以未知成本起跑。

---

# 🚀 在干净的 AWS 账号上安装(逐步)

本节假设你**完全没有 AWS 经验**,请自上而下照做。总时间约 **45–60 分钟**,大部分是等 AWS 跑完。

> 全部部署在 **`us-east-2`(俄亥俄)**。除非你清楚自己在改什么,否则各处都用这个区域。

## 步骤 0 — 在你的电脑安装工具

需要在本机装三样东西。把下面的检查命令贴上,能印出版本就 OK。

| 工具 | 用途 | 安装 |
| --- | --- | --- |
| **Node.js 22+** | 运行构建与部署脚本 | https://nodejs.org(下载 "LTS" 安装包) |
| **AWS CLI v2** | 与你的 AWS 账号通信 | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| **Git** | 获取此代码 | https://git-scm.com/downloads |

```bash
node --version    # 应印出 v22.x 或更高
aws --version     # 应印出 aws-cli/2.x
git --version
```

**不需要** Docker —— 大型容器镜像都在云端构建。

## 步骤 1 — 获取代码

```bash
git clone https://github.com/hoycdanny/playagent-checker.git
cd playagent-checker
```

## 步骤 2 — 把 AWS CLI 接上账号

向账号所有者索取 **Access Key ID** 与 **Secret Access Key**(AWS Console → IAM → 用户 → 安全凭证 → 创建访问密钥),然后:

```bash
aws configure
# AWS Access Key ID     : <粘贴>
# AWS Secret Access Key : <粘贴>
# Default region name   : us-east-2
# Default output format  : json
```

验证是否连上 —— 这会印出账号号码:

```bash
aws sts get-caller-identity
```

> 这组凭证需要有创建资源的权限(Lambda、S3、Cognito、API Gateway、IAM、ECS、SageMaker、Bedrock、CloudFront)。第一次设置时,用管理员账号(AWS 托管策略 `AdministratorAccess`)最省事,之后再收紧。

## 步骤 3 — 开启 AI 模型(Amazon Bedrock)

全新账号的 AI 模型默认是**关闭**的。你必须先开通一次,否则每次测试都会失败。

1. 打开 AWS Console → 搜索 **Bedrock** → 进入 → 确认右上角区域是 **US East (Ohio) us-east-2**。
2. 左侧菜单 → **Model access(模型访问)** → **Enable specific models / Manage model access**。
3. 至少开通以下这些,然后 **Save**(通常即时批准):
   - **Anthropic – Claude Sonnet 4.5**(草拟测试用例、强力备用 VLM)
   - **Amazon – Titan Text Embeddings V2**(知识库检索)
   - **Amazon – Nova Micro**(辅助子任务)
   - 若列表有 **Qwen – Qwen3-VL** 与 **MiniMax**,一并开通(默认视觉/决策模型)
4. 状态显示 **Access granted** 即完成。之后可再开更多;App 会列出当前可用的模型。

> 小技巧:评估阶段直接在此区域「全部开通」也可以,省得猜。

## 步骤 4 — 准备 CDK(每账号一次)

基础设施用 **AWS CDK** 定义,需在该区域做一次性的 "bootstrap"。

```bash
cd infra
npm install
npx cdk bootstrap aws://账号号码/us-east-2
```

把「账号号码」换成步骤 2 印出的数字(`aws sts get-caller-identity`)。这会创建一个 CDK 用来上传代码的小型暂存桶。

## 步骤 5 — 部署后端

在 `infra/` 文件夹内:

```bash
AWS_REGION=us-east-2 npx cdk deploy \
  PlayAgentDev-Foundation \
  PlayAgentDev-ControlPlane \
  PlayAgentDev-Scheduling \
  PlayAgentDev-Execution \
  --require-approval never
```

> **可选 —— 成本分摊标签。** 每个资源都会自动打上 `project`、`stage`、`component`。你可以在部署时用 `-c` 带入自己的标签(例如归账到某成本中心),这些标签会套到所有资源(含运行期动态起的 EC2/Fargate),并在启用后供「费用分析」页使用(见下方「启用费用分析页」)。
>
> ```bash
> AWS_REGION=us-east-2 npx cdk deploy \
>   PlayAgentDev-Foundation PlayAgentDev-ControlPlane \
>   PlayAgentDev-Scheduling PlayAgentDev-Execution \
>   --require-approval never \
>   -c costCenter=QA-1234 -c owner=alice -c team=game-qa
> ```
>
> 可用的键:`costCenter`、`owner`、`team`、`env`、`costAllocation`。每次部署各 stack 都带相同的 `-c` 旗标,标签才会一致。

约 10–15 分钟。完成后,运行下面这一段就会印出你需要的四个值(会自动处理命名):

```bash
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-Foundation \
  --query "Stacks[0].Outputs[?contains(OutputKey,'UserPool')].[OutputKey,OutputValue]" --output table
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-ControlPlane \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'||OutputKey=='WsUrl'].[OutputKey,OutputValue]" --output table
```

你要找的是这四个值:

- **User Pool ID** — 名称含 `UserPoolId` 的那个;形如 `us-east-2_XXXXXXXXX`
- **User Pool Client ID** — 名称含 `UserPoolClientId` 的那个;一长串字母数字
- **ApiUrl** — `https://xxxx.execute-api.us-east-2.amazonaws.com`
- **WsUrl** — `wss://xxxx.execute-api.us-east-2.amazonaws.com/prod`

## 步骤 6 — 部署 UI-TARS 定位模型(必备)

PlayAgent 用 SageMaker 上的 **UI-TARS-1.5-7B** 做精准的画面坐标定位 —— 它是默认、也是好结果的必要条件(通用模型在游戏美术上点击常偏差数百像素)。全程在云端构建,**不占**你电脑的磁盘或带宽。

```bash
cd ../agent/sagemaker && npm install
# 1) 云端构建:下载模型、构建服务镜像、推到你的账号(走 AWS CodeBuild)。
#    约 20–40 分,在 AWS 内运行,不会下载到你电脑。
AWS_REGION=us-east-2 node cloudBuild.mjs
# 2) 创建 endpoint(权重与镜像已就绪)。InService 后会印出 ENDPOINT_NAME。
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
```

记下它最后印出的 `ENDPOINT_NAME=ui-tars-...`。接着把它接进 engine,只重新部署 execution stack:

```bash
cd ../../infra
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=粘贴_ENDPOINT_NAME
```

> **💲 重要成本提醒:** UI-TARS 运行在 GPU 机器(`ml.g6e.xlarge`,约 US$1.86/小时),**开着就持续计费**。当天测试结束后请关掉:
> ```bash
> node agent/sagemaker/teardownUitars.mjs 粘贴_ENDPOINT_NAME
> ```
> 模型与镜像会保留,之后要再用只需几分钟(重跑上面第 2 步的 skip 参数,再重新部署 execution stack)。

## 步骤 7 — 用这些值构建网页控制台

网页 App 需要在构建时把这四个值烤进去。创建文件 `web/.env.production`(从 repo 根目录):

```bash
cd ../web
npm install
cat > .env.production <<'EOF'
VITE_COGNITO_REGION=us-east-2
VITE_COGNITO_USER_POOL_ID=粘贴_UserPoolId
VITE_COGNITO_CLIENT_ID=粘贴_UserPoolClientId
VITE_API_URL=粘贴_ApiUrl
VITE_WS_URL=粘贴_WsUrl
EOF
```

编辑这个文件,把每个 `粘贴_...` 换成步骤 5 对应的 Output。然后构建:

```bash
npm run build
```

## 步骤 8 — 部署网页控制台

```bash
cd ../infra
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Frontend --require-approval never
```

印出你的 App 网址(一个 `https://xxxx.cloudfront.net`)并打开它,应该会看到登录页:

```bash
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-Frontend \
  --query "Stacks[0].Outputs[?contains(OutputKey,'SiteUrl')].OutputValue" --output text
```

## 步骤 9 — 创建你的第一个(管理员)账号

系统刻意关闭自助注册,所以用户由你自己创建。挑一个 email 与密码(至少 8 字,含大小写与数字)。`tenantId` 用来隔离各客户的数据 —— 填任意短字符串即可,例如公司名。把第一个用户设为**管理员**,之后就能在 App 内的「成员管理」页管理其他人。

择一即可:

**方案 A — 一键脚本(推荐)。** 创建账号、设永久密码,加 `--admin` 则同时加入 `admins` 群组。会自动解析 User Pool。

```bash
cd agent/sagemaker && npm install
AWS_REGION=us-east-2 node createUser.mjs \
  --email you@example.com --tenant acme --password 'ChangeMe123!' --admin
```

**方案 B — 部署时创建管理员。** 部署 Foundation stack(或任何部署)时用 `-c` 带入,CDK 会自动创建并加入 `admins` 群组:

```bash
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Foundation --require-approval never \
  -c adminEmail=you@example.com -c adminPassword='ChangeMe123!' -c adminTenant=acme
```

有了一个管理员之后,其他人直接在 App 的「成员管理」页创建即可(见步骤 10)—— 不必再用命令。非管理员看不到该页。

<details>
<summary>方案 C — 纯 AWS CLI(不用脚本)</summary>

```bash
POOL_ID=粘贴_UserPoolId    # 来自步骤 5
aws cognito-idp admin-create-user --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true "Name=custom:tenantId,Value=acme" \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --password 'ChangeMe123!' --permanent
# 设为管理员(才能用「成员管理」页)
aws cognito-idp admin-add-user-to-group --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --group-name admins
```
</details>

## 步骤 10 — 登录

打开步骤 8 的 CloudFront 网址,用步骤 9 的 email/密码登录。**你登录后看到的第一页就是「使用说明」** —— 内建的完整功能导览,按你的语言呈现。从那里:

1. **应用管理** — 创建 App;原生上传 APK/IPA/ZIP,Web 只需网址。
2. **测试用例** — 用大白话描述流程,AI 转成可执行用例。
3. **测试任务** — 选 App + 用例 + 执行环境(**Web** 或 **Device Farm**)后提交;定位模型默认就是**步骤 6** 装好的 **UI-TARS 1.5 7B**。可实时监看。
4. **测试报告** — 看 AI 叙述、截图、逐步轨迹与成本。
5. **成员管理**(仅管理员)— 导览列最后一项。新增用户(email + 租户 + 初始密码)、停用/启用账号、可选择授予管理员。有了第一个管理员之后就不必再用命令。

> **若没看到「成员管理」:** 导览列只对管理员显示,而登录 token 的群组信息只反映「你登录当下」的状态。把某账号设为管理员(步骤 9)后,请**登出再重新登录**,新 token 才会带 `admins` 群组。

✅ **你的环境已经可以用了。**

UI-TARS 定位的原理说明见 [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md)。

## 启用费用分析页

**费用分析**页(在「知识管理」旁)并排显示两种数字:

- **AWS 真实成本** —— 实时取自 **AWS Cost Explorer**:你的实际账单,按服务、按 `component` 标签、按月份分解。涵盖全部(SageMaker GPU、Fargate、EC2、CloudFront 等)。
- **任务估算成本** —— 由任务的 token × 单价估算加总,按应用与模型分组。不含基础设施,所以会低于真实账单;两者口径不同,不应直接相减。

估算那侧立即可用。真实那侧需要**一次性的账号设置**(Cost Explorer 属账号层级,CDK 无法代为启用):

1. **启用 Cost Explorer。** 在 AWS 控制台进入 **Billing and Cost Management → Cost Explorer** 启用它。首次启用后约 **24 小时**开始有数据。
2. **启用成本分摊标签。** 在 **Billing and Cost Management → Cost allocation tags → User-defined cost allocation tags**,勾选 `project`、`stage`、`component`(以及你部署时带入的 `costCenter` / `owner` / `team` 等),点 **Activate**。
3. **隔天再看。** 标签仅对启用**之后**产生的成本生效 —— 过去成本不回溯,在此之前按 `component` 分组会全部落在「未标记」。隔天再回来看。

备注:

- Cost Explorer API 仅在 `us-east-1`;无论你部署在哪一区,程序都已固定查该区。
- 每次查询由 AWS 收取约 **US$0.01**,且数据通常延迟约 24 小时(非实时)。
- 只有账号拥有者 / 具账务权限的 IAM 用户能启用成本分摊标签。

## Device Farm(真实手机)说明

Web 后端不需额外设置即可用。真机测试使用 **AWS Device Farm**,其项目位于 **us-west-2**,由 runner 自动创建。部署凭证已含 Device Farm 权限,无需手动设置 —— 提交任务时选「Device Farm」即可。

---

## 成本、清除与疑难解答

**大致运行成本(评估用):** serverless 控制面在低用量下每月数美元;每次测试按 token 计费(每次几美分到一两美元,报告都会显示)。最大的成本是 **UI-TARS GPU endpoint**(`ml.g6e.xlarge`,约 US$1.86/小时)—— 开着就持续计费,所以**不测试时请关掉**(`node agent/sagemaker/teardownUitars.mjs <endpoint 名>`),要用时几分钟就能重建。

**整个拆除**(删除 stacks;数据桶与 Cognito 用户池按设计会保留,以免误删数据 —— 若真要删,到 Console 手动删除):

```bash
cd infra
AWS_REGION=us-east-2 npx cdk destroy --all
# 若你启用了 UI-TARS,先删它的 endpoint:
node ../agent/sagemaker/teardownUitars.mjs <endpoint 名>
```

**常见问题**

| 症状 | 解法 |
| --- | --- |
| 部署失败:*"not bootstrapped"* | 执行步骤 4(`cdk bootstrap`)且区域为 `us-east-2`。 |
| 测试报错提到某模型 / Bedrock *AccessDenied* | 开通模型访问(步骤 3),在 **us-east-2**。 |
| 登录页出得来但登不进去 | `web/.env.production` 值填错,或改完没有重新 build + 重新部署前端(步骤 6–7)。 |
| 无法注册 | 这是刻意设计 —— 用命令创建用户(步骤 8)。 |
| 区域错 / 看不到资源 | 全部在 **us-east-2**;检查 Console 右上角的区域选择器。 |

---

## 目录结构

```
agent/            执行 runner(运行在 Fargate 容器内)
  explorationRunner.mjs    Device Farm 真机 runner(Appium 循环)
  webExplorationRunner.mjs Web runner(Playwright headless Chromium)
  imageTools.mjs           给 VLM 用的 smart-resize 与落点标记
  uitarsClient.mjs         UI-TARS(SageMaker)定位客户端
  apkMerge.mjs             Device Farm 用的 XAPK / split-APK 合并
  sagemaker/               UI-TARS 部署:vLLM BYOC 容器 + CodeBuild 脚本
infra/            AWS CDK 应用(foundation、control-plane、scheduling、execution、frontend)
web/              React + Vite 网页控制台(5 语系 i18n、自绘 SVG)
docs/             架构、设计笔记、研究
```

## 给开发者

```bash
cd infra && npm test     # CDK 与单元测试
cd web   && npm run ci    # check:i18n + 类型检查 + 测试 + build
```

见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [docs/architecture.md](docs/architecture.md)。

## 许可

见 repo 设置。按现状提供,供内部评估使用。
