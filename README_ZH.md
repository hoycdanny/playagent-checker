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

## 適合誰用

- **QA 團隊**:不想寫、也不想維護脆弱 UI 腳本,卻要測遊戲/App。
- **多產品的遊戲公司**(拉霸、RPG、MMORPG、休閒…):每次改版都要跨 build 做可重複的冒煙/回歸測試。
- **任何人**:能用文字描述流程,但不想學自動化框架。

## 運作原理(端到端)

```
① 建立應用    上傳 APK/IPA/ZIP,或指定網址。標上遊戲類型。
② 撰寫案例    用白話描述流程 → AI 產出可執行 YAML。
③ (可選)知識庫  掛遊戲類型或情境知識,讓 AI 懂這個領域。
④ 提交任務    選執行環境(Web / Device Farm)+ 定位模型,排入雲端佇列。
⑤ AI 執行    截圖 → VLM 判座標 → Agent 決策 → 執行操作 → 循環。
⑥ 報告 + 記憶  多語報告(敘述、截圖、逐步軌跡、成本)+ 跨次累積的導覽地圖。
```

AI **不依賴脆弱的元件選擇器** —— 它像真人測試員一樣「看實際畫面」,所以連沒有可檢視 UI 樹的畫布型遊戲(Cocos2d-x、Unity)也能測。

## 功能總覽(每個頁面在做什麼)

| 頁面 | 用途 |
| --- | --- |
| **使用說明** | 內建的操作導覽(登入後的首頁),5 種語言。 |
| **應用管理** | 每款遊戲/App 一個工作區。填名稱 + 平台 + 類型;原生上傳產物,Web 只需網址。集中管理該 App 的案例、任務、報告、記憶。 |
| **測試案例** | 一個案例 = 一段要 AI 執行的流程。用白話草擬(AI → YAML)或手寫 YAML。密鑰用 `${ENV}` 佔位,明文密碼會被擋。 |
| **測試任務** | 把案例送去執行。選**執行環境**(Web 瀏覽器或 Device Farm 真機)、**定位模型**(預設 UI-TARS)、並複選**知識庫**。可即時監看、隨時取消。 |
| **測試報告** | 唯讀結果:AI 敘述、逐步軌跡、遊戲截圖、導覽關係圖,以及預算 vs 實際花費與 token 用量。 |
| **記憶地圖** | 跨多次測試累積的 App 全景:走過的畫面成為節點、操作轉移成為連線 —— 後續測試更快定位。 |
| **知識管理** | 跨使用者共用的知識庫。兩種(遊戲類型 / 情境),各可放 **Markdown**(整份注入)與/或 **PDF 檢索**(對上傳文件做向量搜尋)。 |
| **裝置管理** | 瀏覽 AWS Device Farm 目前可用的真實機型。雲端 runner 依任務自動建立、結束即回收,無需手動管理。 |

## AI:三個模型「座位」

模型依**職責(座位)**分工,而非綁定供應商。每個座位可各自獨立選模型:

- **Agent(決策)** —— 主腦;看當前畫面與目標,決定下一步做什麼。
- **VLM(判座標)** —— 視覺;把「要點的東西」轉成畫面上的實際像素。**預設用 SageMaker 上的 UI-TARS-1.5-7B**(專為 GUI grounding 微調,在遊戲美術上比通用模型準得多,且回覆繁體中文)。
- **Subagent(輔助)** —— 用較便宜的模型處理輕量子任務,省成本。

知識庫檢索另用 **Amazon Titan Text Embeddings v2** 搭配 **Amazon Bedrock Knowledge Bases + S3 Vectors**。你不需選 SDK/端點 —— 系統依 modelId 自動推導。

## 成本護欄

每個任務都有預算上限。執行前先為各座位模型**鎖定單價快照**(Fail Closed:查不到價就拒絕執行,絕不以未知成本起跑)。累計花費達上限即停,報告顯示實際花費與 token 用量。

## 名詞說明

- **Seat(座位)** —— 模型的職責(Agent / VLM / SubAgent),非供應商。
- **VLM** —— 視覺語言模型;讀截圖並定位座標。
- **UI-TARS** —— ByteDance 專為 GUI grounding 微調的視覺模型,以 vLLM 部署在 SageMaker;在 smart-resize 後的圖上回報絕對像素座標。
- **Agent 執行迴圈** —— 截圖 → VLM 判座標 → Agent 決策 → 執行 → 再截圖。引擎恆在雲端(Lambda 編排,執行容器在 Fargate)。
- **知識庫** —— Markdown(整份注入)或 PDF 檢索(依任務目標做向量搜尋)。
- **Locality(運行地)** —— 被測裝置在哪:`cloud`(雲端供給)或 `attached`(你註冊的本地裝置,仍由雲端大腦遠端驅動)。
- **終局狀態** —— 任務結束狀態:`pass` / `fail` / `error` / `cancelled` / `budget_exceeded` / `dead`。
- **Fail-closed** —— 查不到單價時,寧可不跑也不以未知成本起跑。

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

> **選用 —— 成本分攤標籤。** 每個資源都會自動貼上 `project`、`stage`、`component`。你可以在部署時用 `-c` 帶入自己的標籤(例如歸帳到某成本中心),這些標籤會套到所有資源(含執行期動態起的 EC2/Fargate),並在啟用後供「費用分析」頁使用(見下方「啟用費用分析頁」)。
>
> ```bash
> AWS_REGION=us-east-2 npx cdk deploy \
>   PlayAgentDev-Foundation PlayAgentDev-ControlPlane \
>   PlayAgentDev-Scheduling PlayAgentDev-Execution \
>   --require-approval never \
>   -c costCenter=QA-1234 -c owner=alice -c team=game-qa
> ```
>
> 可用的鍵:`costCenter`、`owner`、`team`、`env`、`costAllocation`。每次部署各 stack 都帶相同的 `-c` 旗標,標籤才會一致。

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

## 步驟 6 — 部署 UI-TARS 定位模型(必備)

PlayAgent 用 SageMaker 上的 **UI-TARS-1.5-7B** 做精準的畫面座標定位 —— 它是預設、也是好結果的必要條件(通用模型在遊戲美術上點擊常偏差數百像素)。全程在雲端 build,**不佔**你電腦的磁碟或頻寬。

```bash
cd ../agent/sagemaker && npm install
# 1) 雲端 build:下載模型、build 服務映像、推到你的帳號(走 AWS CodeBuild)。
#    約 20–40 分,在 AWS 內跑,不會下載到你電腦。
AWS_REGION=us-east-2 node cloudBuild.mjs
# 2) 建立 endpoint(權重與映像已就緒)。InService 後會印出 ENDPOINT_NAME。
PA_SKIP_DOWNLOAD=1 PA_SKIP_UPLOAD=1 PA_SKIP_BUILD=1 AWS_REGION=us-east-2 node deployUitars.mjs
```

記下它最後印出的 `ENDPOINT_NAME=ui-tars-...`。接著把它接進 engine,只重新部署 execution stack:

```bash
cd ../../infra
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Execution \
  --require-approval never --exclusively -c uitarsEndpoint=貼上_ENDPOINT_NAME
```

> **💲 重要成本提醒:** UI-TARS 跑在 GPU 機器(`ml.g6e.xlarge`,約 US$1.86/小時),**開著就持續計費**。當天測試結束後請關掉:
> ```bash
> node agent/sagemaker/teardownUitars.mjs 貼上_ENDPOINT_NAME
> ```
> 模型與映像會保留,之後要再用只需幾分鐘(重跑上面第 2 步的 skip 旗標,再重新部署 execution stack)。

## 步驟 7 — 用這些值建置網頁主控台

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

## 步驟 8 — 部署網頁主控台

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

## 步驟 9 — 建立你的第一個(管理員)帳號

系統刻意關閉自助註冊,所以使用者由你自己建立。挑一個 email 與密碼(至少 8 字,含大小寫與數字)。`tenantId` 用來隔離各客戶的資料 —— 填任意短字串即可,例如公司名。把第一個使用者設為**管理員**,之後就能在 App 內的「成員管理」頁管理其他人。

擇一即可:

**方案 A — 一鍵腳本(推薦)。** 建帳號、設永久密碼,加 `--admin` 則同時加入 `admins` 群組。會自動解析 User Pool。

```bash
cd agent/sagemaker && npm install
AWS_REGION=us-east-2 node createUser.mjs \
  --email you@example.com --tenant acme --password 'ChangeMe123!' --admin
```

**方案 B — 部署時建立管理員。** 部署 Foundation stack(或任何部署)時用 `-c` 帶入,CDK 會自動建立並加入 `admins` 群組:

```bash
AWS_REGION=us-east-2 npx cdk deploy PlayAgentDev-Foundation --require-approval never \
  -c adminEmail=you@example.com -c adminPassword='ChangeMe123!' -c adminTenant=acme
```

有了一個管理員之後,其他人直接在 App 的「成員管理」頁建立即可(見步驟 10)—— 不必再用指令。非管理員看不到該頁。

<details>
<summary>方案 C — 純 AWS CLI(不用腳本)</summary>

```bash
POOL_ID=貼上_UserPoolId    # 來自步驟 5
aws cognito-idp admin-create-user --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true "Name=custom:tenantId,Value=acme" \
  --message-action SUPPRESS
aws cognito-idp admin-set-user-password --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --password 'ChangeMe123!' --permanent
# 設為管理員(才能用「成員管理」頁)
aws cognito-idp admin-add-user-to-group --region us-east-2 --user-pool-id "$POOL_ID" \
  --username you@example.com --group-name admins
```
</details>

## 步驟 10 — 登入

開啟步驟 8 的 CloudFront 網址,用步驟 9 的 email/密碼登入。**你登入後看到的第一頁就是「使用說明」** —— 內建的完整功能導覽,依你的語言呈現。從那裡:

1. **應用管理** — 建立 App;原生上傳 APK/IPA/ZIP,Web 只需網址。
2. **測試案例** — 用白話描述流程,AI 轉成可執行案例。
3. **測試任務** — 選 App + 案例 + 執行環境(**Web** 或 **Device Farm**)後提交;定位模型預設就是**步驟 6** 裝好的 **UI-TARS 1.5 7B**。可即時監看。
4. **測試報告** — 看 AI 敘述、截圖、逐步軌跡與成本。

✅ **你的環境已經可以用了。**

UI-TARS 定位的原理說明見 [docs/design/uitars-sagemaker-grounding.md](docs/design/uitars-sagemaker-grounding.md)。

## 啟用費用分析頁

**費用分析**頁(在「知識管理」旁)並排顯示兩種數字:

- **AWS 真實成本** —— 即時取自 **AWS Cost Explorer**:你的實際帳單,依服務、依 `component` 標籤、依月份分解。涵蓋全部(SageMaker GPU、Fargate、EC2、CloudFront 等)。
- **任務估算成本** —— 由任務的 token × 單價估算加總,依應用與模型分組。不含基礎設施,所以會低於真實帳單;兩者口徑不同,不應直接相減。

估算那側立即可用。真實那側需要**一次性的帳號設定**(Cost Explorer 屬帳號層級,CDK 無法代為啟用):

1. **啟用 Cost Explorer。** 在 AWS 主控台進入 **Billing and Cost Management → Cost Explorer** 啟用它。首次啟用後約 **24 小時**開始有資料。
2. **啟用成本分攤標籤。** 在 **Billing and Cost Management → Cost allocation tags → User-defined cost allocation tags**,勾選 `project`、`stage`、`component`(以及你部署時帶入的 `costCenter` / `owner` / `team` 等),按 **Activate**。
3. **隔天再看。** 標籤僅對啟用**之後**產生的成本生效 —— 過去成本不回溯,在此之前依 `component` 分組會全部落在「未標記」。隔天再回來看。

備註:

- Cost Explorer API 僅在 `us-east-1`;無論你部署在哪一區,程式都已固定查該區。
- 每次查詢由 AWS 收取約 **US$0.01**,且資料通常延遲約 24 小時(非即時)。
- 只有帳號擁有者 / 具帳務權限的 IAM 使用者能啟用成本分攤標籤。

## Device Farm(真實手機)說明

Web 後端不需額外設定即可用。真機測試使用 **AWS Device Farm**,其專案位於 **us-west-2**,由 runner 自動建立。部署憑證已含 Device Farm 權限,無需手動設定 —— 提交任務時選「Device Farm」即可。

---

## 成本、清除與疑難排解

**大略運行成本(評估用):** serverless 控制面在低用量下每月數美元;每次測試依 token 計費(每次幾美分到一兩美元,報告都會顯示)。最大的成本是 **UI-TARS GPU endpoint**(`ml.g6e.xlarge`,約 US$1.86/小時)—— 開著就持續計費,所以**不測試時請關掉**(`node agent/sagemaker/teardownUitars.mjs <endpoint 名>`),要用時幾分鐘就能重建。

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
