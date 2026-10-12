# Implementation Plan — Serverless AI QA Platform

> 交付原則:每個階段結束都有一個瀏覽器打得開、看得到、點得動的成果,真部署到單一 AWS 帳號的 dev 環境驗證後才推進下一階段。任務由前端優先、縱向切分,每個父任務對應 design 的一個階段,結尾都有一個「web 驗證」子任務作為該階段的驗收關卡。

---

## 階段 0 — 骨架:能部署、瀏覽器看到空殼

- [x] 0.1 建立 CDK App 骨架與 dev 環境設定
  - 建 `infra/bin/app.ts`、`infra/cdk.json`,以 context 注入單帳號 dev 環境(region、帳號)
  - 建立空的 stack 檔骨架(foundation / control-plane / scheduling / execution / frontend)僅含類別宣告
  - _Requirements: CDK 最佳實踐(環境設定注入、stack 分層)_

- [x] 0.2 實作 `static-site` L3 construct(私有 S3 + CloudFront OAC)
  - 私有 S3 桶(封鎖所有公開存取)、CloudFront distribution 以 OAC 讀取、`BucketDeployment` 佈署與變更檔快取失效
  - 靜態資產內容雜湊命名 + 長期快取標頭
  - _Requirements: 1.5, 15.3_

- [x] 0.3 建立最小 SPA 殼、i18n 與深淺主題
  - Vite + React + TS 專案;app shell(頂欄 + 空內容 + 路由出口),shell 與頁面分包
  - i18n 初始化:zh-Hant(預設)+ en 訊息目錄、語系偵測、localStorage 記憶、頂欄語系切換器
  - 主題系統:以語意化 design token 定義深色/淺色兩套,頂欄主題切換器;預設跟隨 `prefers-color-scheme`、手動選擇存 localStorage 並優先;首次繪製前套用已記憶主題避免閃爍
  - 響應式:頂欄與導覽於窄螢幕(手機)自動調整(漢堡選單/收合),不擠壓
  - _Requirements: 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 15.2_

- [x] 0.4 撰寫 `frontend-stack` 與 CDK assertions 測試
  - 組裝 `static-site` construct;assertions 測「前端桶封鎖公開存取且僅 OAC 可讀」
  - _Requirements: 1.5, CDK 基礎設施測試_

- [x] 0.5 【web 驗證】部署並於瀏覽器確認空殼
  - `cdk deploy` 後開 CloudFront URL,確認看到 app shell、能切換 zh-Hant/en 且文字跟著變、能切換深/淺主題且不跳版不重整、重整後語系與主題被記憶、無主控台錯誤
  - 量測 FCP < 1.5s
  - 已部署:https://example-distribution.cloudfront.net(us-east-2)。暖啟 FCP ~500ms(達標);冷啟 ~1940ms(未達標,待階段 5 路由級 code-splitting 收斂,已知待改項)
  - _Requirements: 10.9, 10.10, 15.1_

---

## 階段 1 — 登入(Cognito)

- [x] 1.1 實作 `cognito-tenant-pool` L3 construct
  - User Pool + `custom:tenantId` 自訂屬性 + app client(啟用密碼認證流)、`RemovalPolicy.RETAIN`
  - assertions 測 RETAIN、`custom:tenantId` 存在、app client auth flow 正確
  - _Requirements: 1.1, 1.4, CDK 有狀態資源保護_

- [x] 1.2 組裝 `foundation-stack` 納入 User Pool
  - 於 foundation-stack 建立 User Pool,輸出 pool id / client id 供前端建置期注入
  - _Requirements: 1.1_

- [x] 1.3 前端登入頁與 token 管理
  - 登入頁(username+password → Cognito)、token 存 sessionStorage、路由守衛、頂欄顯示租戶/登出、i18n 錯誤訊息
  - idToken 的 `custom:tenantId` 僅供顯示地解碼(不做本地授權)
  - _Requirements: 1.1, 1.3, 10.7, 11.1_

- [x] 1.4 【web 驗證】部署並於瀏覽器驗證登入
  - 建測試使用者;web 登入 → 進入受保護區、頂欄顯示 email/租戶;登出 → 退回登入頁;錯誤密碼顯示 i18n 錯誤
  - 已於 https://example-distribution.cloudfront.net 實測:測試使用者 qa-user@example.invalid(tenantId=example-tenant-a)登入成功、頂欄顯示 email + 租戶 example-tenant-a、錯誤密碼顯示 i18n 錯誤(alert role)、登出退回登入頁
  - _Requirements: 1.1, 1.4_

---

## 階段 2 — 主導覽 + 空清單(接通 API + 租戶隔離)

- [x] 2.1 實作 `http-api-lambda` L3 construct 與 JWT authorizer
  - API Gateway HTTP API + Node zip Lambda(見 design 實作註記:Node 為受管 runtime,不需 Web Adapter/容器)+ Cognito JWT authorizer
  - `handleRequest(req, deps)` 核心以純 Request→Response 實作,JWT claims 由 authorizer event 帶入
  - _Requirements: 1.1, 1.5_

- [x] 2.2 實作租戶隔離(STS session tag)
  - 租戶資料角色 + `assumeTenantS3(tenantId)`(session tag + IAM 條件鍵綁前綴)
  - 從 JWT claim 取 tenantId,忽略 body 自述值;身分推不出即拒絕
  - 單元測試:body 偽造 tenantId 跨不了租戶、claims 解析
  - _Requirements: 1.2, 1.3, 1.4_

- [x] 2.3 實作 `tenant-data-bucket` L3 construct 與 `GET /apps`、`GET /tasks`(空清單)
  - 資料 S3 桶(租戶前綴、事件通知預留、RETAIN);兩個唯讀端點先回空清單(讀 S3 前綴)
  - Lambda 角色以 grant 方法取得最小 S3 權限
  - _Requirements: 1.2, 3.6, CDK least-privilege_

- [x] 2.4 前端主導覽與各頁骨架
  - Apps / Cases / Tasks / Reports / Devices 導覽 + 各頁 lazy chunk + 空狀態 + 骨架屏
  - 資料查詢層(stale-while-revalidate);切頁 100ms 內回饋
  - HashRouter + 路由級 lazy(build 確認各頁獨立 chunk 0.28–1.8KB);apiClient 帶 Bearer token;ListPage 骨架屏/空狀態/錯誤
  - _Requirements: 10.1, 15.2, 15.4_

- [x] 2.5 組裝 `control-plane-stack` 與 assertions 測試
  - 組裝 HTTP API + authorizer + 租戶角色;assertions 測 authorizer 綁 User Pool、Lambda 角色最小權限
  - 已部署:https://example-http-api-id.execute-api.us-east-2.amazonaws.com;curl 驗證無 token→401、帶 token→200、/me 回正確租戶
  - _Requirements: 1.1, CDK 基礎設施測試_

- [x] 2.6 【web 驗證】部署並驗證導覽與租戶隔離
  - 登入後看到五區導覽、各頁空狀態、切頁骨架回饋;用兩個不同租戶帳號登入彼此看不到對方資料
  - 租戶隔離已於 API 層證實(curl,同一 S3 桶):在 example-tenant-a 前綴種入 demo-app.json → example-tenant-a 使用者 GET /apps 看得到、example-tenant-b 使用者看不到({"items":[]})。STS session tag + IAM PrincipalTag 條件鍵生效
  - 備註:前端 Apps 頁顯示該筆資料的瀏覽器視覺確認,因 Playwright 擴充暫時斷線未完成;登入+導覽渲染已於階段 1 視覺確認,本階段僅在同一 shell 後加入路由頁
  - _Requirements: 1.2, 10.1, 15.4_

---

## 階段 3 — 建 App + 產物上傳(presigned PUT)

- [x] 3.1 實作 `POST /uploads`(presigned PUT)
  - 發租戶前綴限定、限時的 presigned S3 PUT URL;校驗 key 僅限本租戶前綴
  - 單元測試:presigned key 限租戶前綴(非法 kind→400);presigned 正常路徑於部署後 curl 驗證
  - 已驗證:POST /uploads 回 tenants/example-tenant-a/artifacts/... 的 presigned URL,PUT 5MB 檔→200(位元組直達 S3 不經 Lambda)
  - _Requirements: 2.1, 2.4_

- [x] 3.2 實作 `POST /apps`、`GET /apps` 落 S3
  - App CRUD 落租戶前綴;重整後仍在清單
  - 已驗證:POST /apps 建立 Mahjong Deluxe → GET /apps 讀得到;物件落 tenants/<t>/apps/<id>.json
  - _Requirements: 10.1, 3.6_

- [x] 3.3 前端 App 建立表單與檔案直傳元件
  - App 建立表單;檔案上傳元件(向 API 要 presigned URL → 瀏覽器直傳 S3)+ 進度/成功回饋
  - 全字串經 i18n;無障礙名稱
  - AppsPage 表單(名稱/平台/識別碼/依平台的產物上傳)+ uploadToS3(XHR 進度)+ 建立後刷新清單
  - _Requirements: 2.1, 10.7, 11.2_

- [x] 3.4 【web 驗證】部署並驗證建 App 與大檔上傳
  - web 建 App、上傳數十 MB APK/檔案看到進度與成功;重整後 App 仍在;確認位元組不經 Lambda
  - API 層已 curl 證實建 App + presigned PUT 5MB 直傳 S3(200)。前端表單流程的瀏覽器視覺確認因 Playwright 擴充持續斷線未完成(與階段 2 同一狀況);前端呼叫的是同一組已驗證 API
  - _Requirements: 2.1, 2.4_

---

## 階段 4 — 建測試案例(自然語言 → AI 草擬 YAML)

- [x] 4.1 實作 `POST /cases/draft`(AI 草擬)與 `POST /cases`、`GET /cases`
  - 自然語言 → AI 草擬案例 YAML(Bedrock Claude Sonnet 4.5);案例存檔落 S3(按 App 歸類)
  - 存檔時拒絕字面量密鑰(只接受 `${ENV}`/機密引用)
  - 已驗證(curl,真 Bedrock):描述「登入後完成麻將關卡」→ AI 生成完整 YAML 且自動用 ${GAME_PASSWORD} 佔位;字面量 password→400;${ENV}→201
  - _Requirements: 10.2, 2.3_

- [x] 4.2 前端案例編輯器(雙模式)
  - 自然語言輸入 + AI 草擬結果審閱/修改;可切換原始 YAML 手寫;YAML 編輯器為 lazy chunk
  - 使用者自寫文字標記為「使用者內容」不進 i18n、逐字呈現
  - CasesPage 雙 tab(自然語言/原始 YAML),草擬後切 YAML 供審閱;YAML textarea spellCheck=false 逐字;CasesPage 為獨立 lazy chunk(3.96KB)
  - _Requirements: 10.2, 10.10, 15.2_

- [x] 4.3 【web 驗證】部署並驗證案例建立流程
  - web 用自然語言描述流程 → 看到 AI 草擬 YAML → 修改 → 存檔;切 YAML 手寫也可存;編輯器按需載入不計入首包
  - API 層已 curl 全程驗證(draft/save/secret-boundary,真 Bedrock);CasesPage 為獨立 chunk 確認不計入首包。前端流程瀏覽器視覺確認因 Playwright 擴充持續斷線待補(累積)
  - _Requirements: 10.2, 15.2_

---

## 階段 5 — 提交任務 + 統一任務表 + 狀態

> 實作註記:引擎承載層採務實選擇 —— 因建置環境無 Docker daemon,Web 引擎先以 Lambda + HTTP fetch 承載(暫代真 Chromium),AgentCore 與真實無頭瀏覽器留待 Docker/Chromium layer 可用時以同一 `runWebTask` 介面替換,排程/狀態/契約不變(詳見 design 實作註記)。API URL 因 ControlPlane 重建變更為 `https://replacement-http-api-id.execute-api.us-east-2.amazonaws.com`。

- [x] 5.1 實作 `scheduling-stack`:SQS + 分派器 + 生命週期 Lambda
  - SQS 分派佇列 + DLQ;分派器 Lambda 為佇列消費者,**直接非同步 Invoke** 引擎 Lambda(非把引擎掛在 SQS ESM 之後,Req 3.8)
  - assertions 測:引擎所在 execution stack 無任何 EventSourceMapping(引擎不由佇列 ESM 觸發)、scheduling 有唯一 ESM(分派器消費佇列)
  - 併發槽從簡(依賴 SQS + Lambda 並發上限),per-backend 分桶留待需要時細化
  - _Requirements: 3.8, 4.7_

- [x] 5.2 實作 `execution-stack`:引擎 Lambda + WebProvider
  - 引擎 Lambda(扮租戶角色讀寫該租戶前綴)+ `runWebTask`(讀案例 url → fetch → 寫 step/screenshot → 終態);AgentCore/真 Chromium 為後續替換
  - 已驗證:step0.json 實含 `fetch/httpStatus:200/observedTitle:"Example Domain"`
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 5.3 實作任務狀態單一真相源與終態吸收
  - status.json 為單一真相源;S3 條件寫(If-Match)落終態;取消落 cancelled、已跑出結果不被 cancelled 覆蓋
  - 單元測試:終態吸收不變式 8 項(任一終態吸收後續寫入、running→cancelled、cancelled 不覆蓋 pass/fail)
  - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 5.4 實作 `POST /tasks`(含提交前校驗)、`GET /tasks`、`POST /tasks/:id/cancel`
  - 提交前校驗 App/案例存在——全在任何執行花費前(objectExists);建 job.json + 初始 running + enqueue SQS
  - 已驗證:submit→pass 端到端;App 不存在→400 且不 enqueue;cancel 寫 cancel.json + 落 cancelled(fetch 太快時保留真實 pass,符合 Req 3.4)
  - _Requirements: 2.2, 3.3, 14.5_

- [x] 5.5 前端統一任務表
  - 一張表;category 與 Locality 為欄位;六終局狀態 + queued/running 每個單一不重複選項的狀態篩選;提交表單(App+案例+後端);列取消;執行中自動輪詢
  - 狀態徽章文字+顏色+圓點三重編碼(Req 11.4)
  - _Requirements: 10.3, 10.4, 15.5_

- [x] 5.6 【web 驗證】部署並驗證端到端任務
  - web 提交 Web 目標任務 → 任務表看它從進行中走到 pass/fail;取消落 cancelled 不落 error;狀態篩選每個終局狀態只有一個選項
  - API 層 curl 端到端全驗證(submit→dispatch→engine→pass、真實 step 產物、cancel 路徑、CORS 204);前端已部署且新 API URL 已 baked、CORS 允許。瀏覽器視覺確認因 Playwright 擴充持續斷線待補(累積)
  - _Requirements: 3.2, 3.3, 10.4_

---

## 階段 6 — Live View + Trace 即時串流

- [x] 6.1 實作 `ws-api` L3 construct 與訂閱/推送
  - WebSocket API(connect 帶 JWT 驗,Lambda authorizer + query token)、訂閱記錄(S3 `jobs/<jobId>/connections/`)、S3 事件(EventBridge)→ 推送 Lambda → PostToConnection
  - 引擎只寫 S3、不直接對 WS 端點通訊(Req 5.5)
  - 已部署 wss://example-websocket-api-id.execute-api.us-east-2.amazonaws.com/prod;node 腳本驗證:連線→subscribe→收到 status+step 推送 3 則
  - 註:WebSocket Lambda authorizer 必須回傳 IAM policy(非 HTTP API simple response)
  - _Requirements: 5.4, 5.5_

- [x] 6.2 前端 Live View + Trace 雙欄檢視
  - 左 Live View / 右 Trace 步驟串流,兩獨立通道不多工;Web 後端無 viewUrl → 只顯示 Trace + 說明,不顯示壞面板(Req 5.3)
  - TaskDetailPage 雙欄;WS 推送即時合併 step(index 去重保序),不阻塞
  - _Requirements: 5.1, 5.2, 5.3, 15.6_

- [x] 6.3 前端重連補讀
  - `useJobStream`:WS 中斷(非終局時)自動重連,重連 onopen 先經 `GET /tasks/:id` 補回遺漏 steps(不假設持久長連線);終局狀態以 ARIA live region(role=status aria-live)通報
  - 新增 `GET /tasks/:id` 詳情端點(job+state+steps)作為補讀真相源
  - _Requirements: 5.4, 11.3_

- [x] 6.4 【web 驗證】部署並驗證串流與重連
  - web 開進行中任務 → 同時見裝置畫面與逐步 Trace;中斷網路再恢復 → 重連補回遺漏步驟;無畫面後端只顯示 Trace
  - API/WS 層已驗證(node 腳本收到 status+step 推送;GET /tasks/:id 回完整 steps 供重連補讀);前端 TaskDetailPage 已部署(VITE_WS_URL 已 baked)。瀏覽器視覺確認因 Playwright 擴充持續斷線待補(累積)
  - _Requirements: 5.3, 5.4_

---

## 階段 7 — 報告 + 多語切換

- [x] 7.1 實作報告產生器(結構化 + AI 敘述多語預生成)
  - 引擎終態時彙整 Trace → report.json(結構化:狀態/步驟/花費);AI 敘述於產生時預生成 zh-Hant + en(固定)+ 勾選語言(ja/ko/zh-Hans),做法 A
  - 產出物記 `availableLanguages`;花費記 budgetUsd + billableSpendUsd 兩數
  - 已驗證(真 Bedrock):report.json 含 zh-Hant + en 兩段流暢敘述,availableLanguages=['zh-Hant','en']
  - _Requirements: 6.1, 6.3, 6.4, 6.7, 6.8, 6.11_

- [x] 7.2 實作 `GET /reports/:id`(+ `GET /reports` 清單)
  - 回報告產出物(結構化 + 各語敘述 + availableLanguages);租戶前綴;找不到→404
  - _Requirements: 6.3_

- [x] 7.3 前端多語報告檢視器
  - ReportViewPage:讀 availableLanguages 顯示語言切換器;結構化內容走 i18n 即時切;AI 敘述讀對應預生成版本(切換不等待);未預生成回退 en 並以 note 標示;花費閾值+實際兩數;步驟逐字呈現不翻譯
  - ReportsPage 清單(僅終局任務)→ 開啟報告
  - _Requirements: 6.2, 6.4, 6.5, 6.6, 6.7, 6.9, 6.10_

- [x] 7.4 【web 驗證】部署並驗證多語報告
  - 任務結束後 web 開報告 → 見步驟/花費(閾值+實際兩數)→ 切 zh-Hant/en,AI 敘述即時切無等待;未預生成語言回退 en 並標示
  - API/Bedrock 層已驗證(report.json 雙語敘述、GET /reports 清單、GET /reports/:id 詳情、回退邏輯);前端 ReportViewPage 已部署。瀏覽器視覺確認因 Playwright 擴充持續斷線待補(累積)
  - _Requirements: 6.4, 6.7, 6.9_

---

## 階段 8 — 其餘裝置後端 + 成本 + 模型 + 記憶知識

- [x] 8.1 實作成本護欄(Budget / Fail Closed)與單價表
  - Budget 閘口於引擎主迴圈每次迭代頂部判定;查不到單價 Fail Closed(拒絕或保守上限,絕不當 $0);Billable Spend 只計 token 計價單調增長項
  - 執行配置快照記各 Seat 生效後模型
  - 單元測試:Fail Closed、快照記生效後模型
  - 已實作:`pricing.ts`(resolvePrice/computeSpend/budgetExceeded,geo 1.1x,查無價拋 PricingError)+ `engine/costGuard.ts`(resolveExecutionConfig 產生快照並對每 Seat Fail Closed、SpendAccumulator 單調增長+shouldStop);引擎進入點先解析快照(不可定價→花費前落 error)並寫 `config.json`,報告帶 budgetUsd。單元測試 pricing 6 + costGuard 6 全過
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 8.2 實作 Model Catalog / Seat / Channel
  - 唯一權威 Catalog(下拉/客戶端建構/區域校驗共用);Channel 由 modelId 推導;三 Seat 獨立選型;座標系以實測值寫入
  - 單元測試:下拉可選模型必在單價表查得到價
  - 已實作:`modelCatalog.ts`(CATALOG/channelFromModelId/modelsForSeat/unpriceableCatalogEntries);`GET /models`(可 `?seat=` 過濾)。單元測試 4 全過(含啟動斷言:下拉可選必可定價)。已部署 curl 驗證:GET /models 回目錄、?seat=subagent 回 Sonnet 4.5 + Haiku
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 8.3 實作 Memory 與 Knowledge 邊界
  - Memory 按 (App, Locality) 隔離不合併;Knowledge 按 App 單一實例、權威源為使用者檔案;衝突 Knowledge 優先;清空 Memory/刪 App 不動 Knowledge
  - 已實作:`knowledge.ts`(readKnowledge/writeKnowledge/readMemory 按 locality/clearMemory 只刪 memory 前綴/composeContext 標 Knowledge 優先);引擎 assembleAgentContext 組裝 Knowledge+Memory 寫 `context.json`。`GET/PUT /knowledge`、`POST /memory/clear`。單元測試 3 全過。已部署 curl 驗證:PUT→GET 知識往返、memory/clear 不動 knowledge
  - 註:發現並修正 `http-api-lambda` catch-all 路由與 CORS 原本缺 PUT(否則 PUT /knowledge 會 404),已補上 PUT
  - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [x] 8.4 實作 `per-job-host` L3 construct 與 EmulatorProvider / WindowsProvider
  - 每任務 Redroid 主機(binder + 特權容器)、每任務 Windows EC2(互動式登入 session);終局回收主機與併發槽(以容器確認終結為釋放前提);常駐機不被誤銷
  - assertions 測每任務主機終局回收、常駐機不被銷毀
  - 已實作:`per-job-host` construct(IAM 角色+SG,emulator ADB 5555 / windows Appium 4725 僅 VPC 內)整合進 execution-stack(DeviceVpc natGateways:0 免 NAT 費 + S3 Gateway Endpoint);引擎 IAM RunInstances 限 RequestTag `hostLifecycle=per-job`、Terminate/Stop 限 ResourceTag per-job(常駐機不帶此 tag 受保護)。`engine/provisionedProvider.ts`(release 只終結 provisioned 且須確認終結才釋放併發槽)。CDK assertions 5 + provider 單元測試 5 全過。已部署 execution stack
  - ⚠ 環境限制:此建置環境無 Docker daemon、且開真 EC2 會計費,「主機真的起來跑 Redroid/Appium」端到端未驗證;落地為 IaC + 生命週期骨架 + 可 synth/assertions/單元測試
  - _Requirements: 4.3, 4.4, 4.5, 4.6_

- [x] 8.5 實作 DeviceFarmProvider 與被測身分注入
  - Device Farm 實機(Android/iOS);案例引用租戶範圍機密(Secrets Manager)於 session 內注入登入,憑證僅 session 存活期可用;只能引用本租戶機密;機密缺失花費前失敗
  - 已實作:`secretRefs.ts`(tenantSecretPrefix=playagent/tenant/<t>/、parseSecretRef 強制本租戶前綴、extractSecretRefs 跨租戶拋錯)、`engine/deviceFarmProvider.ts`(run 花費前 resolveSecrets:缺失/跨租戶拋錯不進 execute;finally 清除明文——憑證僅 session 存活)、`secretRefStore.ts` + `GET/PUT/DELETE /secret-refs`(只記 name+label 不回值)。單元測試 secretRefs 8 + secretRefStore 3 全過。已部署 curl 驗證:本租戶引用 201、跨租戶 400、GET 不回值
  - ⚠ 環境限制:開真 Device Farm 實機會計費,「實機跑起來 + 用注入憑證登入」端到端未驗證;落地為租戶範圍與 session 注入語義的骨架 + 單元測試
  - _Requirements: 4.2, 14.1, 14.2, 14.3, 14.4, 14.5_

- [x] 8.6 實作 AttachedProvider 與本地代理
  - 本地代理(使用者機器,主動撥出 WS 連雲端、不需本地入站埠);截圖上送→雲端 VLM 判座標→指令回傳→本地執行迴圈;決策恆雲端;斷線落 error、主動停 cancelled;共用同一 Trace/報告
  - `POST /devices/register` 發代理連線憑證(租戶身分驗證)
  - 已實作:`api/devices.ts`(registerDevice 回一次性 token 明文+只存 tokenHash/hint、verifyDeviceToken)、`engine/attachedProvider.ts`(雲端主導迴圈:每步頂部 cancel→cancelled、斷線→error、done→pass、超步數→fail、step 標 decidedInCloud、release 不終結 attached 主機)。`GET/POST /devices/register`、`DELETE /devices`。WS authorizer 加裝置 token 驗證路徑(讀 devices/<id>.json 比對 SHA-256,role=agent)。`agent/index.mjs` 連線 URL 帶 tenantId/deviceId/deviceToken。單元測試 attachedProvider 8 + devices 4 全過。已部署 curl 驗證:註冊回一次性 token(遮罩 hint)、列出/刪除
  - ⚠ 環境限制:attached 端到端需使用者機器上真跑代理 + 真 WS 往返,此環境不具備;落地為雲端側迴圈與錯誤語義骨架 + 本地代理連線/往返骨架(Capturer/Actuator 插槽待有裝置環境接原生實作)
  - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8_

- [x] 8.7 前端裝置頁與被測機密引用管理
  - Devices 頁:雲端常駐主機 + attached 本地裝置註冊/管理;裝置來源以使用者語彙呈現(自動建立/使用已有實例);機密引用管理(不回傳值)
  - 已實作:`DevicesPage.tsx` 三區(雲端裝置純資訊+「每次任務自動建立」語彙、本地裝置註冊+一次性 token 只顯示一次+狀態徽章文字/顏色/圓點三重編碼、機密引用新增/列出/移除且 name 預填租戶前綴、只顯示 name+label 不回值)。深淺主題語意 token + 響應式。i18n devices.* 37 key 五語系齊備。web tsc/測試/check:i18n 通過、DevicesPage 為獨立 lazy chunk。已部署 CloudFront(chunk 200)
  - _Requirements: 10.5, 14.1, 14.4_

- [x] 8.8 【web 驗證】逐後端部署並驗證
  - 每補一後端在 web 提交對應任務跑通並回收;attached:本地跑代理註冊 → web 提交 → 見本地畫面往返分析;引用被測登入機密完成登入
  - 已部署 execution+controlplane+frontend;curl 全驗證可雲端驗證的部分:GET /models(+seat 過濾)、PUT/GET /knowledge、POST /memory/clear、PUT/GET/DELETE /secret-refs(租戶範圍 201/跨租戶 400/不回值)、POST /devices/register(一次性 token)/GET/DELETE /devices;DevicesPage chunk 已上 CloudFront(200)。infra 99 單元/assertions 測試全過,web build 產物含 DevicesPage 獨立 chunk
  - ⚠ 環境限制誠實標註:emulator/windows/devicefarm/attached 四後端的「裝置真的跑起來 + 任務端到端跑通並回收」受限於無 Docker daemon + 不宜開實機(計費),未做端到端;各後端的 provider 生命週期、機密注入、雲端迴圈、回收語義已以單元測試 + CDK assertions + IaC 就緒,真實承載於 Docker/Chromium layer 與允許開實機時以同一 provider 介面替換內部實作即可
  - 前端 DevicesPage 瀏覽器視覺確認因 Playwright 擴充自階段 2 起持續斷線待補(累積);API/IaC 已用 curl + 單元測試 + CDK assertions 鐵證
  - _Requirements: 4.4, 13.1, 14.1_

---

## 階段 9 — 分診輔助 + 無障礙/效能收尾

- [x] 9.1 實作案例趨勢與 flaky 分診
  - 案例最近 N 次通過/失敗趨勢;結果反覆無對應變更標記為 flaky(與確定性 fail 區分);fail/error 成因引導
  - 已實作:`trends.ts`(computeCaseTrend 純函式:通過率僅計 pass/fail、detectFlaky 以「同一 artifactVersion 下同時出現 pass 與 fail」判 flaky——跨版本 pass→fail 視為真回歸不判 flaky、error 不參與;triageHint fail→app-or-case / error→infra);`createJob` 快照 App 產物版本 artifactVersion 到 job.json;`GET /trends?app=&case=`。前端 `CaseTrendBadge`(最近結果符號序列形狀+顏色雙編碼、flaky/穩定文字+顏色+圖示三重編碼)接進 CasesPage 清單;TaskDetailPage 於 fail/error 顯示成因引導。單元測試 trends 8 全過(通過率/error 不計/flaky 反覆/確定性 fail 不 flaky/跨版本回歸不 flaky/成因引導)。web tsc+i18n+測試通過
  - _Requirements: 12.1, 12.2, 12.3_

- [x] 9.2 無障礙與雙主題複查
  - 全互動元件鍵盤可達 + 可見焦點;非文字內容無障礙名稱;狀態文字+形狀+顏色三重編碼;ARIA live 通報
  - 深色與淺色兩主題各自複查 WCAG AA 對比,確認無任一主題出現對比不足或不可讀狀態
  - 程式面複查結果:全域 `:focus-visible` 焦點環(tokens.css)、TopBar 主題鈕/漢堡鈕具 aria-label/aria-expanded/aria-controls、圖示皆 aria-hidden、導覽 aria-label;狀態徽章三重編碼(task-state 文字 t(state) + 顏色 --status-* + ::before 圓點形狀);任務終局以 role=status aria-live=polite 通報;CaseTrendBadge 結果序列以符號(形狀)+顏色雙編碼、flaky/穩定以文字+圖示+顏色三重編碼;DevicesPage token 關閉鈕 aria-label
  - **修正**:發現階段 8/9.1 新寫的 CSS 用了 tokens.css 未定義的 `--success/--danger/--warning/--accent`(落 fallback 硬編碼色、不隨主題切換,違反 Req 10.11),全數改用既有語意 token(--status-pass/fail/error、--brand/--brand-contrast),兩主題皆定義。掃描確認其餘 `#` 色值僅為 LoginPage 品牌漸層與 Live View 黑底佔位(裝飾用途、非狀態語意)
  - ⚠ 待瀏覽器:兩主題實際 WCAG AA 對比比值量測、鍵盤 tab 順序與報讀器實測,待 Browser MCP/Playwright 連線後補(擴充自階段 2 起斷線)
  - _Requirements: 10.10, 11.1, 11.2, 11.3, 11.4_

- [x] 9.3 效能複查與 i18n 缺漏檢查收尾
  - 量測 FCP/TTI/INP 對照門檻;清單分頁/虛擬捲動確認;建置期 i18n 缺漏檢查(zh-Hant+en 基準集缺 key 報錯,二級語系警告)納入 CI
  - 已完成:i18n 缺漏檢查納入建置流程——`prebuild` 於 `build` 前跑 `check:i18n`(一級 zh-Hant+en 缺 key → exit 1 擋建置、二級 zh-Hans/ja/ko 缺 key → 警告不失敗),另加 `ci` script 串 check:i18n+tsc+vitest+build 單一入口。清單量控:新增 `usePagedList`(客戶端分頁,25 筆/頁 + 顯示更多,單次渲染量不隨總量無上限成長,Req 15.5),接進 TasksPage 與 ReportsPage,「顯示更多」控制含 aria-live 計數。code-splitting 複查:build 產物確認各功能頁獨立 lazy chunk(1.6–5.5KB gz),重量級頁不計入首包(Req 15.2)
  - ⚠ 待瀏覽器:FCP/TTI/INP 實際數值量測待 Browser MCP(擴充自階段 2 起斷線);先前階段 0 已量得暖啟 FCP ~500ms 達標
  - _Requirements: 10.7, 15.1, 15.5, 15.7_

- [x] 9.4 【web 驗證】全面驗收
  - web 見案例趨勢與 flaky 標記;鍵盤全程可操作、螢幕報讀器通報狀態變化;清單順暢、INP < 200ms
  - 已完成(整合測試):infra tsc clean + 18 檔 107 tests 全過(含 trends 8);web tsc + check:i18n + 7 tests + build 全過(prebuild i18n 檢查生效)。部署 controlplane(GET /trends + artifactVersion 快照)+ frontend(趨勢徽章/分頁/成因引導/token 修正)。curl 真雲端驗證:GET /trends 缺參數→400、查現有案例回正確趨勢(1 次 pass、passRate 1、flaky false);前端 index.html 200 且載入 chunk hash 與最新 build 一致(新資產已上線)。flaky 判定 8 單元測試涵蓋(pass/fail 反覆→flaky、確定性 fail 不 flaky、跨版本回歸不 flaky、error 不參與)
  - ⚠ 待瀏覽器(累積待補):案例趨勢/flaky 標記的視覺呈現、鍵盤全程 tab 操作、螢幕報讀器狀態通報、清單 INP < 200ms 實測、雙主題 WCAG AA 對比比值——全待 Browser MCP/Playwright 連線(擴充自階段 2 起持續斷線,已嘗試 playwright-mcp 與 browsermcp 皆未注入工具)。所有後端/API/IaC/i18n/分頁/無障礙程式面已以 curl + 114 單元/assertions 測試 + build 產物鐵證
  - _Requirements: 11.1, 12.1, 15.7_
