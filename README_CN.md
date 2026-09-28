# PlayAgent Checker

**AI 驱动的游戏 / App 自动化测试平台。** 你用大白话描述要测的流程,AI 代理就会自己看画面、帮你点击滑动、判断成败,并产出含截图、逐步轨迹与导览地图的多语报告。

> 语言:[English](README.md) · [繁體中文](README_ZH.md) · **简体中文** · [日本語](README_JP.md) · [한국어](README_KR.md)

---

## 这是什么

PlayAgent Checker 运行在 **AWS(us-east-2)**,是一套 serverless 控制面加上按需执行的 runner。你上传 App(或指定网址),代理自主探索,你就得到可重复、可审阅的测试结果。

- **两个真实执行后端,均已端到端验证:**
  - **Web** — 用 Playwright 启动 headless Chromium,运行在 ECS Fargate。
  - **Device Farm** — AWS Device Farm 的 Android/iOS 真机,由 Fargate runner 以 Appium 驱动。
- **代理循环:** 截图 → VLM 判坐标 → Agent 决策 → 在设备上执行 → 再截图,循环到达成目标或触发停止条件。
- **精准 GUI 定位:** 判坐标的 VLM「座位」可改用部署在 SageMaker 的 **UI-TARS-1.5-7B**(专为 GUI grounding 微调),在美术繁复、无原生元件的游戏画面上,比通用视觉模型准得多。
- **知识库:** 可挂游戏类型或情境知识(内嵌 Markdown,或以 Amazon Bedrock Knowledge Bases + S3 Vectors 支持的 PDF/文档检索)。
- **成本护栏:** 每个任务执行前先锁定各座位单价快照(查不到价即拒绝执行),达预算即停。
- **多语界面与报告:** 5 种语系(zh-Hant、en、zh-Hans、ja、ko)。

## 架构速览

```
浏览器(Web Console)
  → CloudFront + S3(静态站)
  → API Gateway(+ Cognito JWT、IAM/STS 租户隔离)
  → Lambda API handler → SQS → Dispatcher Lambda → Engine Lambda(编排)
        ├─ AI 大脑(Amazon Bedrock):Agent / VLM / SubAgent + 知识库
        │     └─ VLM 判坐标可改路由到 Amazon SageMaker 上的 UI-TARS
        └─ 设备后端(ECS Fargate):
              ├─ Web    → Playwright headless Chromium
              └─ Device Farm → 真机 + Appium
  → S3(截图、轨迹、报告、记忆地图)
  → EventBridge → WebSocket → 实时回推浏览器
```

Engine(Lambda)只做编排;重活(大型 APK 上传、设备 session、截图→操作循环)在无时限的 Fargate 容器内执行。完整说明见 [docs/architecture.md](docs/architecture.md)。

## 目录结构

```
agent/            执行 runner(运行在 Fargate 容器内)
  explorationRunner.mjs   Device Farm 真机 runner(Appium 循环)
  webExplorationRunner.mjs Web runner(Playwright headless Chromium)
  appiumClient.mjs / playwrightClient.mjs  设备驱动
  imageTools.mjs          给 VLM 用的 smart-resize 与落点标记
  uitarsClient.mjs        UI-TARS(SageMaker)定位客户端
  apkMerge.mjs            Device Farm 用的 XAPK / split-APK 合并
  sagemaker/              UI-TARS 部署:vLLM BYOC 容器 + CodeBuild 脚本
infra/            AWS CDK 应用(控制面、执行、调度、基础、前端)
  lib/            CDK stacks
  lambda/         API、engine、dispatcher、WS handler
  test/           CDK 与单元测试
web/              React + Vite 网页控制台(5 语系 i18n、自绘 SVG)
docs/             架构、设计笔记、研究
```

## 前置条件

- Node.js 22+
- 已配置 **us-east-2** 凭证的 AWS 账号(Device Farm 项目在 us-west-2,由 runner 管理)
- Docker(仅本机 build 镜像时需要;云端 build 走 AWS CodeBuild)
- AWS CDK v2(`npx cdk`)

## 快速开始

```bash
# 1. 安装
cd infra && npm install
cd ../web && npm install

# 2. 测试
cd ../infra && npm test          # CDK 与单元测试
cd ../web && npm run ci          # check:i18n + tsc + vitest + build

# 3. 部署(us-east-2)
cd ../infra
AWS_REGION=us-east-2 npx cdk deploy --all --require-approval never
```

部署后,网页控制台与 API 网址会列在 stack outputs。

## 使用流程

1. **应用管理** — 创建 App(名称、平台、游戏类型);原生上传 APK/IPA/ZIP,Web 只需网址。
2. **测试用例** — 用大白话草拟流程(AI 转成可执行 YAML)或手写 YAML。密钥用 `${ENV}` 占位,明文密码会被拦。
3. **知识管理**(可选)— 挂类型或情境知识(Markdown 整份注入,或 PDF 检索)。
4. **测试任务** — 选 App + 用例 + 执行环境(Web 或 Device Farm)+ 定位模型后提交。可实时监看、随时取消。
5. **测试报告** — 看 AI 叙述、逐步轨迹、截图与导览图,以及预算与实际花费。

网页控制台的 **使用说明** 页有完整的操作指引。

## UI-TARS 定位(可选,更准)

通用视觉模型在繁复游戏美术上很难给出精准像素坐标;专为 GUI grounding 微调的 UI-TARS-1.5-7B 准得多。要启用它,部署 SageMaker endpoint(全程在云端 build,不占本机磁盘/带宽):

```bash
cd agent/sagemaker && npm install
# 云端 build:HF 下载 → S3 → vLLM 镜像 → ECR(走 CodeBuild)
AWS_REGION=us-east-2 node cloudBuild.mjs
# 创建 endpoint(权重与镜像已就绪)
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
# 把 endpoint 名接进 engine
cd ../../infra && AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=<endpoint 名>
```

> **成本提醒:** UI-TARS endpoint 运行在 `ml.g6e.xlarge`(约 US$1.86/hr),开着就持续计费。不用时请删除:
> ```bash
> node agent/sagemaker/teardownUitars.mjs <endpoint 名>
> ```

设计说明见 [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md)。

## 文档

- [docs/architecture.md](docs/architecture.md) — 系统架构、数据流、租户
- [docs/design/](docs/design/) — 主要子系统设计笔记
- [docs/research/](docs/research/) — 调查与发现
- [CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 许可

见 repo 设置。本项目按现状提供,供内部评估使用。
