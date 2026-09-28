# PlayAgent Checker

**AI 驅動的遊戲 / App 自動化測試平台。** 你用白話描述要測的流程,AI 代理就會自己看畫面、幫你點擊滑動、判斷成敗,並產出含截圖、逐步軌跡與導覽地圖的多語報告。

> 語言:[English](README.md) · **繁體中文** · [简体中文](README_CN.md) · [日本語](README_JP.md) · [한국어](README_KR.md)

---

## 這是什麼

PlayAgent Checker 完全跑在 **AWS(區域 `us-east-2`)**:一套 serverless 控制面加上隨需執行的 runner。你上傳 App(或指定網址),代理自主探索,你就得到可重複、可審閱的測試結果。

- **兩個真實執行後端,皆已端到端驗證:** **Web**(Playwright headless Chromium,跑在 ECS Fargate)與 **Device Farm**(AWS Device Farm 的 Android/iOS 真機,以 Appium 驅動)。
- **代理迴圈:** 截圖 → VLM 判座標 → Agent 決策 → 在裝置上執行 → 再截圖,直到達成目標或觸發停止條件。
- **精準 GUI 定位(可選):** 判座標的 VLM 座位可改用 SageMaker 上的 **UI-TARS-1.5-7B**,在繁複遊戲美術上座標準得多。
- **知識庫、成本護欄,以及 5 語系介面**(zh-Hant、en、zh-Hans、ja、ko)。

架構細節:[docs/architecture.md](docs/architecture.md)。

---

# 🚀 在乾淨的 AWS 帳號上安裝(逐步)

本節假設你**完全沒有 AWS 經驗**,請由上而下照做。總時間約 **45–60 分鐘**,大部分是等 AWS 跑完。

> 全部部署在 **`us-east-2`(俄亥俄)**。除非你清楚自己在改什麼,否則各處都用這個區域。

## 步驟 0 — 在你的電腦安裝工具

需要在本機裝三樣東西。把下面的檢查指令貼上,有印出版本就代表 OK。

| 工具 | 用途 | 安裝 |
| --- | --- | --- |
| **Node.js 22+** | 執行建置與部署腳本 | https://nodejs.org(下載 "LTS" 安裝檔) |
| **AWS CLI v2** | 與你的 AWS 帳號溝通 | https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html |
| **Git** | 取得此程式碼 | https://git-scm.com/downloads |

```bash
node --version    # 應印出 v22.x 或更高
aws --version     # 應印出 aws-cli/2.x
git --version
```

**不需要** Docker —— 大型容器映像都在雲端 build。

## 步驟 1 — 取得程式碼

```bash
git clone https://github.com/hoycdanny/playagent-checker.git
cd playagent-checker
```

## 步驟 2 — 把 AWS CLI 接上帳號

向帳號擁有者索取 **Access Key ID** 與 **Secret Access Key**(AWS Console → IAM → 使用者 → 安全憑證 → 建立存取金鑰),然後:

```bash
aws configure
# AWS Access Key ID     : <貼上>
# AWS Secret Access Key : <貼上>
# Default region name   : us-east-2
# Default output format  : json
```

驗證是否連上 —— 這會印出帳號號碼:

```bash
aws sts get-caller-identity
```

> 這組憑證需要有建立資源的權限(Lambda、S3、Cognito、API Gateway、IAM、ECS、SageMaker、Bedrock、CloudFront)。第一次設定時,用管理者帳號(AWS 受管政策 `AdministratorAccess`)最省事,之後再收緊。

## 步驟 3 — 開啟 AI 模型(Amazon Bedrock)

全新帳號的 AI 模型預設是**關閉**的。你必須先開通一次,否則每次測試都會失敗。

1. 開啟 AWS Console → 搜尋 **Bedrock** → 進入 → 確認右上角區域是 **US East (Ohio) us-east-2**。
2. 左側選單 → **Model access(模型存取)** → **Enable specific models / Manage model access**。
3. 至少開通以下這些,然後 **Save**(通常即時核准):
   - **Anthropic – Claude Sonnet 4.5**(草擬測試案例、強力備援 VLM)
   - **Amazon – Titan Text Embeddings V2**(知識庫檢索)
   - **Amazon – Nova Micro**(輔助子任務)
   - 若清單有 **Qwen – Qwen3-VL** 與 **MiniMax**,一併開通(預設視覺/決策模型)
4. 狀態顯示 **Access granted** 就完成。之後可再開更多;App 會列出目前可用的模型。

> 小訣竅:評估階段直接在此區域「全部開通」也可以,省得猜。

## 步驟 4 — 準備 CDK(每帳號一次)

基礎架構用 **AWS CDK** 定義,需在該區域做一次性的 "bootstrap"。

```bash
cd infra
npm install
npx cdk bootstrap aws://帳號號碼/us-east-2
```

把「帳號號碼」換成步驟 2 印出的數字(`aws sts get-caller-identity`)。這會建立一個 CDK 用來上傳程式的小型暫存桶。

## 步驟 5 — 部署後端

在 `infra/` 資料夾內:

```bash
AWS_REGION=us-east-2 npx cdk deploy \
  PlayAgentDev-Foundation \
  PlayAgentDev-ControlPlane \
  PlayAgentDev-Scheduling \
  PlayAgentDev-Execution \
  --require-approval never
```

約 10–15 分鐘。完成後,執行下面這一段就會印出你需要的四個值(會自動處理命名):

```bash
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-Foundation \
  --query "Stacks[0].Outputs[?contains(OutputKey,'UserPool')].[OutputKey,OutputValue]" --output table
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-ControlPlane \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'||OutputKey=='WsUrl'].[OutputKey,OutputValue]" --output table
```

你要找的是這四個值:

- **User Pool ID** — 名稱含 `UserPoolId` 的那個;形如 `us-east-2_XXXXXXXXX`
- **User Pool Client ID** — 名稱含 `UserPoolClientId` 的那個;一長串英數
- **ApiUrl** — `https://xxxx.execute-api.us-east-2.amazonaws.com`
- **WsUrl** — `wss://xxxx.execute-api.us-east-2.amazonaws.com/prod`

## 步驟 6 — 用這些值建置網頁主控台

網頁 App 需要在建置時把這四個值烤進去。建立檔案 `web/.env.production`(從 repo 根目錄):

```bash
cd ../web
npm install
cat > .env.production <<'EOF'
VITE_COGNITO_REGION=us-east-2
VITE_COGNITO_USER_POOL_ID=貼上_UserPoolId
VITE_COGNITO_CLIENT_ID=貼上_UserPoolClientId
VITE_API_URL=貼上_ApiUrl
VITE_WS_URL=貼上_WsUrl
EOF
```

編輯這個檔,把每個 `貼上_...` 換成步驟 5 對應的 Output。然後建置:

```bash
npm run build
```

## 步驟 7 — 部署網頁主控台

```bash
cd ../infra
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Frontend --require-approval never
```

印出你的 App 網址(一個 `https://xxxx.cloudfront.net`)並開啟它,應該會看到登入頁:

```bash
aws cloudformation describe-stacks --region us-east-2 \
  --stack-name PlayAgentDev-Frontend \
  --query "Stacks[0].Outputs[?contains(OutputKey,'SiteUrl')].OutputValue" --output text
```

## 步驟 8 — 建立你的登入帳號(第一個使用者)

系統刻意關閉自助註冊,所以第一個使用者用指令建立。挑一個 email 與密碼(至少 8 字,含大小寫與數字)。`tenantId` 用來隔離各客戶的資料 —— 填任意短字串即可,例如公司名。

```bash
POOL_ID=貼上_UserPoolId    # 來自步驟 5

# 建立帶租戶 id 的使用者
aws cognito-idp admin-create-user --region us-east-2 \
  --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true "Name=custom:tenantId,Value=acme" \
  --message-action SUPPRESS

# 設定永久密碼(免去「變更密碼」提示)
aws cognito-idp admin-set-user-password --region us-east-2 \
  --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --password 'ChangeMe123!' --permanent
```

## 步驟 9 — 登入

開啟步驟 7 的 CloudFront 網址,用步驟 8 的 email/密碼登入。**你登入後看到的第一頁就是「使用說明」** —— 內建的完整功能導覽,依你的語言呈現。從那裡:

1. **應用管理** — 建立 App;原生上傳 APK/IPA/ZIP,Web 只需網址。
2. **測試案例** — 用白話描述流程,AI 轉成可執行案例。
3. **測試任務** — 選 App + 案例 + 執行環境(**Web** 或 **Device Farm**)後提交,可即時監看。
4. **測試報告** — 看 AI 敘述、截圖、逐步軌跡與成本。

✅ **你的環境已經可以用了。**

---

## 可選:用 UI-TARS(SageMaker)提升定位精準度

通用視覺模型在繁複遊戲美術上,點擊位置可能偏差數百像素。UI-TARS-1.5-7B(專為 GUI grounding 微調)準得多。這是**可選**且會額外收費(啟用期間有一台 GPU 持續運行)。

```bash
cd agent/sagemaker && npm install
# 雲端 build(不佔本機磁碟/頻寬):模型 + vLLM 映像 → S3/ECR(走 CodeBuild)
AWS_REGION=us-east-2 node cloudBuild.mjs
# 建立 endpoint(權重與映像已就緒)
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
# 把 endpoint 名接進 engine(用它印出的 ENDPOINT_NAME)
cd ../../infra && AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=<endpoint 名>
```

之後建立任務時,把定位模型選成 **UI-TARS 1.5 7B** 即可。

> **💲 成本:** UI-TARS endpoint 跑在 `ml.g6e.xlarge`(約 US$1.86/小時),開著就持續計費。**不用時請關閉:**
> ```bash
> node agent/sagemaker/teardownUitars.mjs <endpoint 名>
> ```
> 模型權重與映像會留在 S3/ECR,之後重建很快(可跳過下載/build)。

設計說明見 [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md)。

## Device Farm(真實手機)說明

Web 後端不需額外設定即可用。真機測試使用 **AWS Device Farm**,其專案位於 **us-west-2**,由 runner 自動建立。部署憑證已含 Device Farm 權限,無需手動設定 —— 提交任務時選「Device Farm」即可。

---

## 成本、清除與疑難排解

**大略運行成本(評估用):** serverless 控制面在低用量下每月數美元;每次測試依 token 計費(每次幾美分到一兩美元,報告都會顯示)。唯一的大額成本是**可選的** UI-TARS GPU endpoint(開著約 US$1.86/小時)。

**整個拆除**(刪除 stacks;資料桶與 Cognito 使用者池依設計會保留,以免誤刪資料 —— 若真要刪,到 Console 手動刪除):

```bash
cd infra
AWS_REGION=us-east-2 npx cdk destroy --all
# 若你啟用了 UI-TARS,先刪它的 endpoint:
node ../agent/sagemaker/teardownUitars.mjs <endpoint 名>
```

**常見問題**

| 症狀 | 解法 |
| --- | --- |
| 部署失敗:*"not bootstrapped"* | 執行步驟 4(`cdk bootstrap`)且區域為 `us-east-2`。 |
| 測試報錯提到某模型 / Bedrock *AccessDenied* | 開通模型存取(步驟 3),在 **us-east-2**。 |
| 登入頁出得來但登不進去 | `web/.env.production` 值填錯,或改完沒有重新 build + 重新部署前端(步驟 6–7)。 |
| 無法註冊 | 這是刻意設計 —— 用指令建立使用者(步驟 8)。 |
| 區域錯 / 看不到資源 | 全部在 **us-east-2**;檢查 Console 右上角的區域選擇器。 |

---

## 目錄結構

```
agent/            執行 runner(跑在 Fargate 容器內)
  explorationRunner.mjs    Device Farm 真機 runner(Appium 迴圈)
  webExplorationRunner.mjs Web runner(Playwright headless Chromium)
  imageTools.mjs           給 VLM 用的 smart-resize 與落點標記
  uitarsClient.mjs         UI-TARS(SageMaker)定位客戶端
  apkMerge.mjs             Device Farm 用的 XAPK / split-APK 合併
  sagemaker/               UI-TARS 部署:vLLM BYOC 容器 + CodeBuild 腳本
infra/            AWS CDK 應用(foundation、control-plane、scheduling、execution、frontend)
web/              React + Vite 網頁主控台(5 語系 i18n、自繪 SVG)
docs/             架構、設計筆記、研究
```

## 給開發者

```bash
cd infra && npm test     # CDK 與單元測試
cd web   && npm run ci    # check:i18n + 型別檢查 + 測試 + build
```

見 [CONTRIBUTING.md](CONTRIBUTING.md) 與 [docs/architecture.md](docs/architecture.md)。

## 授權

見 repo 設定。按現況提供,供內部評估使用。
