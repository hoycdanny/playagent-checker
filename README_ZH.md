# PlayAgent Checker

**AI 驅動的遊戲 / App 自動化測試平台。** 你用白話描述要測的流程,AI 代理就會自己看畫面、幫你點擊滑動、判斷成敗,並產出含截圖、逐步軌跡與導覽地圖的多語報告。

> 語言:[English](README.md) · **繁體中文** · [简体中文](README_CN.md) · [日本語](README_JP.md) · [한국어](README_KR.md)

---

## 這是什麼

PlayAgent Checker 跑在 **AWS(us-east-2)**,是一套 serverless 控制面加上隨需執行的 runner。你上傳 App(或指定網址),代理自主探索,你就得到可重複、可審閱的測試結果。

- **兩個真實執行後端,皆已端到端驗證:**
  - **Web** — 用 Playwright 開 headless Chromium,跑在 ECS Fargate。
  - **Device Farm** — AWS Device Farm 的 Android/iOS 真機,由 Fargate runner 以 Appium 驅動。
- **代理迴圈:** 截圖 → VLM 判座標 → Agent 決策 → 在裝置上執行 → 再截圖,循環到達成目標或觸發停止條件。
- **精準 GUI 定位:** 判座標的 VLM「座位」可改用部署在 SageMaker 的 **UI-TARS-1.5-7B**(專為 GUI grounding 微調),在美術繁複、無原生元件的遊戲畫面上,比通用視覺模型準得多。
- **知識庫:** 可掛遊戲類型或情境知識(內嵌 Markdown,或以 Amazon Bedrock Knowledge Bases + S3 Vectors 支援的 PDF/文件檢索)。
- **成本護欄:** 每個任務執行前先鎖定各座位單價快照(查不到價即拒絕執行),達預算即停。
- **多語介面與報告:** 5 種語系(zh-Hant、en、zh-Hans、ja、ko)。

## 架構速覽

```
瀏覽器(Web Console)
  → CloudFront + S3(靜態站)
  → API Gateway(+ Cognito JWT、IAM/STS 租戶隔離)
  → Lambda API handler → SQS → Dispatcher Lambda → Engine Lambda(編排)
        ├─ AI 大腦(Amazon Bedrock):Agent / VLM / SubAgent + 知識庫
        │     └─ VLM 判座標可改路由到 Amazon SageMaker 上的 UI-TARS
        └─ 裝置後端(ECS Fargate):
              ├─ Web    → Playwright headless Chromium
              └─ Device Farm → 真機 + Appium
  → S3(截圖、軌跡、報告、記憶地圖)
  → EventBridge → WebSocket → 即時回推瀏覽器
```

Engine(Lambda)只做編排;重活(大型 APK 上傳、裝置 session、截圖→操作迴圈)在無時限的 Fargate 容器內執行。完整說明見 [docs/architecture.md](docs/architecture.md)。

## 目錄結構

```
agent/            執行 runner(跑在 Fargate 容器內)
  explorationRunner.mjs   Device Farm 真機 runner(Appium 迴圈)
  webExplorationRunner.mjs Web runner(Playwright headless Chromium)
  appiumClient.mjs / playwrightClient.mjs  裝置驅動
  imageTools.mjs          給 VLM 用的 smart-resize 與落點標記
  uitarsClient.mjs        UI-TARS(SageMaker)定位客戶端
  apkMerge.mjs            Device Farm 用的 XAPK / split-APK 合併
  sagemaker/              UI-TARS 部署:vLLM BYOC 容器 + CodeBuild 腳本
infra/            AWS CDK 應用(控制面、執行、排程、基礎、前端)
  lib/            CDK stacks
  lambda/         API、engine、dispatcher、WS handler
  test/           CDK 與單元測試
web/              React + Vite 網頁主控台(5 語系 i18n、自繪 SVG)
docs/             架構、設計筆記、研究
```

## 先決條件

- Node.js 22+
- 已設定 **us-east-2** 憑證的 AWS 帳號(Device Farm 專案在 us-west-2,由 runner 管理)
- Docker(僅本機 build 映像時需要;雲端 build 走 AWS CodeBuild)
- AWS CDK v2(`npx cdk`)

## 快速開始

```bash
# 1. 安裝
cd infra && npm install
cd ../web && npm install

# 2. 測試
cd ../infra && npm test          # CDK 與單元測試
cd ../web && npm run ci          # check:i18n + tsc + vitest + build

# 3. 部署(us-east-2)
cd ../infra
AWS_REGION=us-east-2 npx cdk deploy --all --require-approval never
```

部署後,網頁主控台與 API 網址會列在 stack outputs。

## 使用流程

1. **應用管理** — 建立 App(名稱、平台、遊戲類型);原生上傳 APK/IPA/ZIP,Web 只需網址。
2. **測試案例** — 用白話草擬流程(AI 轉成可執行 YAML)或手寫 YAML。密鑰用 `${ENV}` 佔位,明文密碼會被擋。
3. **知識管理**(可選)— 掛類型或情境知識(Markdown 整份注入,或 PDF 檢索)。
4. **測試任務** — 選 App + 案例 + 執行環境(Web 或 Device Farm)+ 定位模型後提交。可即時監看、隨時取消。
5. **測試報告** — 看 AI 敘述、逐步軌跡、截圖與導覽圖,以及預算與實際花費。

網頁主控台的 **使用說明** 頁有完整的操作指引。

## UI-TARS 定位(可選,更準)

通用視覺模型在繁複遊戲美術上很難給出精準像素座標;專為 GUI grounding 微調的 UI-TARS-1.5-7B 準得多。要啟用它,部署 SageMaker endpoint(全程在雲端 build,不佔本機磁碟/頻寬):

```bash
cd agent/sagemaker && npm install
# 雲端 build:HF 下載 → S3 → vLLM 映像 → ECR(走 CodeBuild)
AWS_REGION=us-east-2 node cloudBuild.mjs
# 建立 endpoint(權重與映像已就緒)
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
# 把 endpoint 名接進 engine
cd ../../infra && AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=<endpoint 名>
```

> **成本提醒:** UI-TARS endpoint 跑在 `ml.g6e.xlarge`(約 US$1.86/hr),開著就持續計費。不用時請刪除:
> ```bash
> node agent/sagemaker/teardownUitars.mjs <endpoint 名>
> ```

設計說明見 [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md)。

## 文件

- [docs/architecture.md](docs/architecture.md) — 系統架構、資料流、租戶
- [docs/design/](docs/design/) — 主要子系統設計筆記
- [docs/research/](docs/research/) — 調查與發現
- [CONTRIBUTING.md](CONTRIBUTING.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 授權

見 repo 設定。本專案按現況提供,供內部評估使用。
