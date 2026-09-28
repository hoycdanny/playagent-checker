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

## 步骤 6 — 用这些值构建网页控制台

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

## 步骤 7 — 部署网页控制台

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

## 步骤 8 — 创建你的登录账号(第一个用户)

系统刻意关闭自助注册,所以第一个用户用命令创建。挑一个 email 与密码(至少 8 字,含大小写与数字)。`tenantId` 用来隔离各客户的数据 —— 填任意短字符串即可,例如公司名。

```bash
POOL_ID=粘贴_UserPoolId    # 来自步骤 5

# 创建带租户 id 的用户
aws cognito-idp admin-create-user --region us-east-2 \
  --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true "Name=custom:tenantId,Value=acme" \
  --message-action SUPPRESS

# 设置永久密码(免去「修改密码」提示)
aws cognito-idp admin-set-user-password --region us-east-2 \
  --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --password 'ChangeMe123!' --permanent
```

## 步骤 9 — 登录

打开步骤 7 的 CloudFront 网址,用步骤 8 的 email/密码登录。**你登录后看到的第一页就是「使用说明」** —— 内建的完整功能导览,按你的语言呈现。从那里:

1. **应用管理** — 创建 App;原生上传 APK/IPA/ZIP,Web 只需网址。
2. **测试用例** — 用大白话描述流程,AI 转成可执行用例。
3. **测试任务** — 选 App + 用例 + 执行环境(**Web** 或 **Device Farm**)后提交,可实时监看。
4. **测试报告** — 看 AI 叙述、截图、逐步轨迹与成本。

✅ **你的环境已经可以用了。**

---

## 可选:用 UI-TARS(SageMaker)提升定位精准度

通用视觉模型在繁复游戏美术上,点击位置可能偏差数百像素。UI-TARS-1.5-7B(专为 GUI grounding 微调)准得多。这是**可选**且会额外收费(启用期间有一台 GPU 持续运行)。

```bash
cd agent/sagemaker && npm install
# 云端构建(不占本机磁盘/带宽):模型 + vLLM 镜像 → S3/ECR(走 CodeBuild)
AWS_REGION=us-east-2 node cloudBuild.mjs
# 创建 endpoint(权重与镜像已就绪)
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
# 把 endpoint 名接进 engine(用它印出的 ENDPOINT_NAME)
cd ../../infra && AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=<endpoint 名>
```

之后创建任务时,把定位模型选成 **UI-TARS 1.5 7B** 即可。

> **💲 成本:** UI-TARS endpoint 运行在 `ml.g6e.xlarge`(约 US$1.86/小时),开着就持续计费。**不用时请关闭:**
> ```bash
> node agent/sagemaker/teardownUitars.mjs <endpoint 名>
> ```
> 模型权重与镜像会留在 S3/ECR,之后重建很快(可跳过下载/构建)。

设计说明见 [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md)。

## Device Farm(真实手机)说明

Web 后端不需额外设置即可用。真机测试使用 **AWS Device Farm**,其项目位于 **us-west-2**,由 runner 自动创建。部署凭证已含 Device Farm 权限,无需手动设置 —— 提交任务时选「Device Farm」即可。

---

## 成本、清除与疑难解答

**大致运行成本(评估用):** serverless 控制面在低用量下每月数美元;每次测试按 token 计费(每次几美分到一两美元,报告都会显示)。唯一的大额成本是**可选的** UI-TARS GPU endpoint(开着约 US$1.86/小时)。

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
