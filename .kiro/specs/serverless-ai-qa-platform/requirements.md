# Requirements — Serverless AI QA Platform (playagent-checker)

## 簡介

本專案是一個 **AI 驅動的遊戲/App 自動化測試平台**:使用者以自然語言描述一個待測使用者流程,雲端 AI Agent 觀察被測裝置畫面、決定要點什麼或輸入什麼、驅動裝置、判斷流程是否成功,並產出含截圖的報告。平台目標有二:

1. **Serverless-first**:平台的「大腦與骨架」——控制面、任務排程、VLM/Agent 決策呼叫、產物儲存、Web 介面——以無伺服器元件承載,不預設任何常駐主機作為系統核心。**Serverless 的邊界僅涵蓋平台大腦與 Web 瀏覽器這一類本就能無伺服器化的裝置**;模擬器、Device Farm 實機、Windows 桌面這些**本質上是實體或半實體資源**,不在 serverless 範圍內——這是預期內的分工,不是破例。這些非無伺服器裝置以每任務起停的專屬主機(或受管實機服務)承載,並被建模成**任務的附屬資源**而非平台底座。
2. **UI/UX 測試工程師導向的介面**:介面的主要使用者是 UI/UX 測試工程師,不是雲端維運人員。介面語彙、預設流程、報告呈現都以「我要驗一個使用者流程、我要看到它在畫面上發生、我要知道它為什麼過或不過」為中心。

平台以雲端多租戶 Web 服務為主入口。本規格用到的領域概念(Task 任務、Seat 模型座位、Budget 預算、Memory 記憶、Knowledge 知識、終局狀態)一律在本文件的「術語」一節與各需求中自足定義。

**Locality(運行地)的語義**:Locality 是 Task 的一個屬性,指「**被測裝置在哪**」——注意它指裝置位置,不指引擎位置(引擎恆在雲端,平台不存在「引擎在使用者本地執行」的承載形態):

- `cloud` — 裝置由雲端供給(Device Farm 實機、每任務 Redroid 主機、每任務 Windows EC2、無伺服器瀏覽器)。截圖與動作都發生在雲端側。
- `attached` — 裝置是使用者**主動註冊到系統的本地裝置**(筆電桌面、本地模擬器、本地瀏覽器)。裝置在使用者側,但**驅動它的大腦(Agent/VLM 決策迴圈)仍在雲端**:本地代理擷取畫面上送雲端,雲端 VLM 依上一動的影像判斷下一步座標並回傳指令,本地代理執行後回傳新畫面,如此往返直至終局;分析與報告都在雲端呈現。`attached` 模式下本地端只是一個**被遠端驅動的裝置 + 一個輕量代理**,不含決策邏輯。

### 設計約束的歷史根據(非需求,但界定可行解空間)

以下兩個已知的無伺服器限制界定了可行解空間,本規格的 serverless 決策必須繞開它們:

- **AWS App Runner 自 2026-04-30 起停收新客戶**:對「要交付給多人各自部署到自己帳號」的產品等於不可用。
- **Lambda Web Adapter + Function URL / CloudFront OAC**:(a) 公開 Function URL 會被帳號級安全掃描判為 world-accessible 並自動改寫 resource policy 打斷存取;(b) OAC 對 POST/PUT 要求 `x-amz-content-sha256`,須在 Lambda@Edge 計算,而其 origin-request body 上限 1MB,**數十 MB 的 APK 上傳直接爆掉**。

因此:**大體積上傳(APK / Windows 遊戲包)一律走 presigned S3PUT 由瀏覽器直傳,位元組永不經過任何運算層**;任何要求把上傳位元組送進 Lambda 的方案都不予採用。

## 術語

- **Task(任務)** — 一次可提交、可觀察、有終態的 Agent 執行。有兩個正交屬性:**category**(`test` 測試 / `exploration` 探索,=這次要做什麼)與 **Locality**(`cloud` / `attached`,=被測裝置在哪)。Task 是介面上唯一對使用者呈現的說法,兩個屬性只是任務列表上的欄位/篩選,不是不同入口。
- **Test Case(測試案例)** — 描述一個待測流程的 YAML 輸入,按 App 歸類,是可復現性的一部分。
- **Seat(模型座位)** — 引擎中一個需要模型、且可獨立選型的位置。三個:**Agent Seat**(決定下一步做什麼,需支援 tool-calling)、**VLM Seat**(看截圖回答畫面上有什麼/元素在哪,需圖像輸入)、**Sub-Agent Seat**(單動作執行器)。座位是職責,不是 provider。
- **Channel(客戶端通道)** — 與某模型對話所需的 SDK+端點+認證組合。由 modelId 推導,不是使用者的選擇。
- **Model Catalog(模型登記表)** — 可選模型的唯一權威清單,記錄每個模型的 Channel、可用區域、座標系(千分制 vs 像素)、可坐哪些 Seat。介面下拉、執行時客戶端建構、區域校驗共用同一張表。
- **Budget(預算)** — 一次執行的花費(美元)觸發閾值,達到即停止。作用域為單一測試案例/單次探索。
- **Billable Spend(可計費花銷)** — 一次執行中按 token 計價、可歸因到單次執行且隨步數單調增長的模型呼叫累計金額;不含按小時計費的常駐端點。
- **Pricing Table(單價表)** — 把 token 換算成 Billable Spend 的唯一權威模型單價表。查不到價時採 Fail Closed(拒絕或按保守上限計費),絕不當作 $0。
- **Memory(記憶)** — 頁面/控件的機器學習記憶,按 `(App, Locality)` 隔離為互不合併的實例(由機器寫入)。
- **Knowledge(知識)** — 使用者手寫的 App 長期事實,按 App 單一實例,權威源恆為使用者可編輯的檔案(只有人寫)。
- **終局狀態(Terminal State)** — 一個 Task 對外呈現的互斥結束狀態,共六種且不可混同:`pass`(跑完且斷言成立)、`fail`(跑完但斷言不過)、`error`(執行本身出錯,未達判定)、`cancelled`(使用者主動取消)、`budget_exceeded`(達成本上限而主動停止)、`dead`(心跳逾時判死)。
- **Trace(執行軌跡)** — 一次 Task 執行的完整可觀察記錄:逐步驟的截圖、Agent 決策、工具輸入/輸出、token 用量與時間戳。Trace 是報告的資料來源,也是即時串流與事後回看共用的同一份東西。
- **Live View(即時畫面)** — 測試進行中,使用者在瀏覽器看到被測裝置畫面的通道。它與 Trace 步驟串流是**兩條獨立通道**,並列呈現(左畫面、右步驟),不互相多工。
- **Visual Script(視覺腳本)** — 從一次成功執行固化出的可重播互動腳本,可脫離 Agent 重跑已知路徑。它不是 Task、不是 Test Case、不使用終局狀態詞表。
- **本地代理(Local Agent)** — 使用者在自己機器上執行的輕量程式,把本機桌面/模擬器/瀏覽器註冊為 `attached` 裝置,負責畫面擷取、動作執行與轉發,不含決策邏輯。
- **Tenant(租戶)** — 一組隔離的使用者資料邊界。跨租戶不可讀寫。租戶身分由登入頒發,不由請求內容自述。

---

## Requirements

### Requirement 1 — 多租戶控制面(無伺服器)

**User Story:** 作為平台使用者,我要登入後只看到與操作自己租戶的 App、測試案例、任務與報告,這樣不同團隊/客戶的資料彼此隔離。

#### Acceptance Criteria

1. WHEN 一個未認證的請求到達任何控制面 API THEN 系統 SHALL 拒絕該請求且不回傳任何租戶資料。
2. WHEN 一個已認證使用者請求任務/報告/產物清單 THEN 系統 SHALL 僅回傳其所屬租戶前綴下的資料。
3. WHERE 請求主體(body)自述了一個 tenant id THE 系統 SHALL 忽略該自述值,並僅以登入身分推導的租戶為準。
4. IF 使用者所屬租戶身分無法從登入憑證推導 THEN 系統 SHALL 拒絕請求並回報身分錯誤,而非退回任何預設租戶。
5. THE 控制面 API SHALL 以無伺服器運算承載(不依賴任何常駐應用主機),且其認證與大體積上傳路徑 SHALL NOT 依賴會被帳號安全掃描判為 world-accessible 的公開函式端點。

### Requirement 2 — 產物上傳與參照

**User Story:** 作為測試工程師,我要把被測 App(Android APK / iOS 建置 / Windows 遊戲包)上傳,並在建立任務時引用它,這樣任務能裝到正確的被測目標。

#### Acceptance Criteria

1. WHEN 使用者要上傳一個被測產物 THEN 系統 SHALL 發給瀏覽器一個租戶前綴限定、限時的 presigned S3 PUT URL,使位元組由瀏覽器直傳 S3 而不經過任何運算層。
2. WHEN 使用者建立任務並引用一個 artifact THEN 系統 SHALL 在任務建立時校驗該 artifact 已上傳、大小與類型合法,校驗失敗 SHALL 在任何模型花費發生之前拒絕該任務。
3. WHERE 測試案例需要登入憑證等機密 THE 系統 SHALL 僅接受以 `${ENV}`/機密引用形式表達,並 SHALL 拒絕案例檔中出現的字面量密鑰。
4. IF 一個大體積上傳的實作路徑會要求位元組經過 Lambda/邊緣函式 THEN 該路徑 SHALL NOT 被採用。

### Requirement 3 — 任務生命週期與終局狀態

**User Story:** 作為測試工程師,我要提交、監看、取消一個測試任務,並在結束時得到一個明確、不含糊的終局狀態,這樣我知道下一步該查什麼。

#### Acceptance Criteria

1. THE 系統 SHALL 以單一 Task 概念對使用者呈現任務,category(test / exploration)與 Locality(cloud = 雲端供給裝置 / attached = 使用者註冊的本地裝置)為其屬性(欄位/篩選),而非兩個獨立入口。無論 Locality 為何,驅動任務的引擎恆在雲端。
2. THE 系統 SHALL 對每個 Task 呈現以下互斥終局狀態之一,且 SHALL NOT 將任何兩者混同:`pass`、`fail`、`error`、`cancelled`、`budget_exceeded`、`dead`。
3. WHEN 使用者主動取消一個任務 THEN 該任務的終局狀態 SHALL 落為 `cancelled`,SHALL NOT 落為 `error`。
4. WHEN 引擎在取消訊號到達前已自然跑出 `pass`/`fail` THEN 系統 SHALL 保留該真實結果,SHALL NOT 以 `cancelled` 覆蓋。
5. WHEN 一個雲端任務的執行容器心跳逾時且未寫出終態 THEN 系統 SHALL 由排程層將權威終態回寫為 `dead`,使客戶端可見的真相源反映實況。
6. THE 任務存活與終態的客戶端可見真相源 SHALL 為單一來源(S3 上的 status 快照),即時查詢/清單/跟隨 SHALL 只讀該來源。
7. WHERE 多個寫入者可能更新同一任務狀態 THE 系統 SHALL 保證終態吸收不變式:一旦落終態,永不被非終態覆蓋,且 `cancelled` 優先於其他終態。
8. THE 任務排程 SHALL 以無伺服器元件承載(佇列 + 無伺服器長時執行),且長時執行的總時長 SHALL 不受「由佇列事件來源映射觸發」而被壓縮至短於單一任務所需的時長。

### Requirement 4 — 執行引擎與裝置後端

**User Story:** 作為測試工程師,我要能對 Android、iOS、Windows、Web 四類目標下測試任務,而不需要理解每種裝置底層是怎麼供給的。

#### Acceptance Criteria

1. THE 系統 SHALL 以單一的引擎(Agent 決策迴圈 + 工具呼叫)作為執行核心且引擎恆在雲端執行,SHALL NOT 存在任何「引擎在使用者本地執行」的承載形態;不同裝置後端 SHALL 透過統一的裝置抽象接入同一引擎,而非為每種裝置分叉引擎。
2. THE 系統 SHALL 支援以下裝置後端:Android(Device Farm 實機 / 每任務 Redroid 主機)、Windows(每任務 EC2 + Appium/WinAppDriver)、iOS(Device Farm 實機)、Web(serverless 瀏覽器自動化)、以及 attached(使用者註冊的本地裝置,見 Requirement 13)。
3. WHERE 一個裝置後端可以純無伺服器承載(Web 瀏覽器自動化) THE 系統 SHALL 以無伺服器運算承載該裝置;WHERE 一個裝置後端在技術上無法純無伺服器承載(Android Redroid 需核心 binder 模組 + 特權容器;Windows 需互動式登入桌面;Device Farm 為實機) THE 系統 SHALL 以每任務起停的專屬主機或受管實機服務承載,且動態建立的主機 SHALL 被建模為該任務的附屬資源。
4. WHEN 一個每任務主機所屬的任務進入任何終局狀態 THEN 系統 SHALL 保證回收(釋放/銷毀)該主機與其併發槽,回收 SHALL 以「容器已確認終結」為釋放併發槽的前提。
5. WHERE 一台主機是使用者長期保留的常駐機(非任務動態建立) THE 系統 SHALL NOT 因任務終局而銷毀它。
6. THE 主機銷毀權 SHALL 跟隨生命週期歸屬:任務所有的主機隨任務終局銷毀,人所有的常駐主機只能被顯式銷毀。
7. THE 併發容量 SHALL 按後端分桶,各後端有獨立併發上限互不爭搶;attached 後端不佔用雲端裝置併發槽。

### Requirement 5 — 即時觀察:Live View 與 Trace 並列

**User Story:** 作為 UI/UX 測試工程師,我要在任務執行時同時看到裝置畫面與 AI 每一步在做什麼,這樣我能即時判斷它是否走在對的流程上。

#### Acceptance Criteria

1. WHILE 一個任務正在執行 THE 系統 SHALL 在 Web 介面並列呈現兩條獨立通道:Live View(裝置即時畫面)與 Trace 步驟串流(截圖 + Agent 決策 + 工具 I/O + token 用量)。
2. THE 系統 SHALL NOT 將裝置畫面像素多工進步驟串流通道,反之亦然。
3. IF 一個任務的執行後端不提供即時畫面(如無頭快速路徑,其裝置租約無 view URL) THEN 系統 SHALL 只呈現 Trace 步驟串流,SHALL NOT 顯示一個空白或壞掉的 Live View 面板。
4. WHEN 即時串流連線因傳輸層限制(如 WebSocket 2 小時上限 / 10 分鐘閒置逾時)中斷 THEN 前端 SHALL 自動重連,並自產物儲存的步驟前綴補回中斷期間遺漏的步驟,SHALL NOT 假設一條持久長連線。
5. WHERE 步驟串流的即時推送需要憑證 THE 執行引擎 SHALL NOT 直接對推送端點通訊;推送 SHALL 由「產物寫入事件 → 無伺服器函式 → 連線推送」的鏈路完成,使引擎保持無憑證。

### Requirement 6 — 事後報告與可回看軌跡

**User Story:** 作為測試工程師,我要在任務結束後打開一份報告,逐步回看它做了什麼、每步的截圖與判斷,並知道這次花了多少錢,這樣我能寫缺陷單或回歸比對。

#### Acceptance Criteria

1. WHEN 一個任務進入終局狀態 THEN 系統 SHALL 產生一份報告,含終局狀態、逐步驟截圖、Agent 決策與工具 I/O、以及本次的 Billable Spend。
2. THE 報告 SHALL 對即時觀看與事後回看呈現同一份 Trace 資料,使兩者的狀態/步驟/花費語義完全一致。
3. THE 歷史任務 SHALL 可自儲存的報告重新開啟回看,不依賴任務執行時的記憶體狀態。
4. WHEN 報告呈現花費 THEN 系統 SHALL 同時顯示 Budget 閾值與實際 Billable Spend 兩個數,SHALL NOT 只顯示「已達上限」而暗示實際花費恰等於閾值。
5. THE 一份報告 SHALL 是「讀者可切換語言」的多語產出物,而非綁定單一語言:報告的閱讀語言由**開啟報告的讀者**選擇,SHALL NOT 綁定為當初下指令或跑測試那位使用者的操作語系。此即支援「甲以繁體中文操作跑出報告,乙開啟同一份報告切換為英文或日文閱讀」的情境。
6. THE 報告中由平台產生的結構化內容(欄位標題、狀態文字、步驟標籤、圖表說明)SHALL 經 i18n 機制依讀者選定語系即時切換呈現,SHALL NOT 硬編碼單一語言。
7. WHERE 報告含由 AI 生成的敘述性內容(缺陷摘要、流程分析、markdown 報告正文) THE 系統 SHALL 在報告產生時**預先生成多語版本**並隨報告產出物一併儲存,使讀者切換語言時直接讀取對應版本,SHALL NOT 於讀者切換當下才即時翻譯(不讓讀者等待、不依賴事後再次呼叫模型、確保離線可讀)。
8. THE 預生成的敘述語言集 SHALL 至少固定包含 zh-Hant 與 en(對齊主要市場台灣與美國兩個一級語系);zh-Hans / ja / ko SHALL 為可由使用者於報告設定中勾選是否一併預生成的選項,勾選後方才產生對應語言(避免未使用語言的生成成本)。
9. WHEN 讀者選擇的語言不在某報告已預生成的敘述語言集內 THEN 系統 SHALL 依 Req 10.8 的優先序回退(優先 en)並明確標示該敘述為回退語言,SHALL NOT 呈現空白或未翻譯的原文卻不標示。
10. THE 使用者自寫的測試案例文字 SHALL NOT 被翻譯,無論它出現在介面或報告中,系統 SHALL 逐字呈現。
11. WHEN 一份報告產出物(HTML / JSON / markdown)被儲存 THEN 系統 SHALL 記錄其已預生成的語言集,使事後回看能正確列出可切換語言且不需重新呼叫模型即可切換。

### Requirement 7 — 成本護欄(Budget / Fail Closed)

**User Story:** 作為對成本負責的人,我要為每次執行設一個花費上限,超過就停,並且絕不會因為系統算不出價而讓上限靜默失效。

#### Acceptance Criteria

1. THE 系統 SHALL 支援對單一測試案例 / 單次探索設定 Budget(美元閾值),達到即停止該執行。
2. THE Budget 閘口 SHALL 在引擎主迴圈每次迭代頂部判定,系統 SHALL 接受實際花費略微超過閾值(約一次迭代開銷),並 SHALL 在報告中同時給出閾值與實際花費兩個數。
3. WHEN 系統為某個模型 ID 查不到單價 THEN 系統 SHALL 拒絕執行或按保守上限計費,SHALL NOT 當作 $0(避免 Budget 閘口靜默失效)。
4. THE Billable Spend SHALL 僅計入按 token 計價、可歸因到單次執行且隨步數單調增長的模型呼叫,SHALL NOT 把按小時計費的常駐端點費用歸入單次執行的閘口判據。
5. THE 執行配置快照 SHALL 記錄各 Seat「生效後」的模型(經 CLI > 案例 YAML > 設定檔 > 內建預設的覆蓋鏈解析),使報告與 Budget 閘口按實跑模型計價。

### Requirement 8 — 模型選擇(Seat / Channel / Catalog)

**User Story:** 作為測試工程師,我要能為不同的被測 App 選不同模型,而不需要知道每個模型該用哪個 SDK 或協定。

#### Acceptance Criteria

1. THE 系統 SHALL 讓使用者對三個 Seat(Agent / VLM / Sub-Agent)各自獨立選型,並在介面上以職責而非 provider 呈現。
2. WHEN 使用者選定一個模型 THEN 系統 SHALL 由 modelId 推導其 Channel(SDK/端點/認證),SHALL NOT 要求使用者選擇 Channel。
3. THE 模型下拉清單、執行時客戶端建構、區域校驗 SHALL 共用同一張 Model Catalog,且下拉可選的每個模型 SHALL 在單價表中查得到價。
4. THE Model Catalog SHALL 記錄每個模型的座標系(千分制 vs 像素),並 SHALL 以實測確認值而非文件推斷寫入,避免座標系判錯導致點擊全錯卻不報錯。

### Requirement 9 — 記憶與知識的邊界

**User Story:** 作為測試工程師,我要平台記住它學到的頁面/控件經驗,也要能手寫關於這個 App 的長期事實,而這兩者不會互相污染。

#### Acceptance Criteria

1. THE 系統 SHALL 將 Memory(機器學習得到的頁面/控件記憶)按 `(App, Locality)` 隔離為互不合併的實例(此處 Locality 取本版本語義:cloud / attached)。
2. THE 系統 SHALL 將 Knowledge(使用者手寫的 App 長期事實)按 App 存為單一實例,其權威源恆為使用者可編輯的檔案,無機器寫入者。
3. WHEN Agent 上下文同時含 Knowledge 與 Memory 且兩者衝突 THEN 系統 SHALL 令 Knowledge 優先於 Memory。
4. WHEN 使用者清空 Memory 或刪除 App THEN 系統 SHALL NOT 連帶刪除手寫 Knowledge。

### Requirement 10 — UI/UX 測試工程師導向的介面

**User Story:** 作為 UI/UX 測試工程師,我要一個以「驗使用者流程」為中心的介面,用我熟悉的語彙與流程操作,而不是被迫理解雲端維運細節。

#### Acceptance Criteria

1. THE 介面主導覽 SHALL 以測試工程師的工作對象組織(App、測試案例、任務、報告),而非以雲端資源類型組織。
2. WHEN 使用者要新增一個測試 THEN 系統 SHALL 提供以自然語言描述待測流程的入口,並由 AI 草擬測試案例 YAML 供使用者審閱、修改後再存檔;使用者亦 SHALL 可切換至原始 YAML 直接手寫。
3. THE 任務清單 SHALL 為一張統一表格,以欄位/篩選呈現 category 與 Locality(cloud / attached),SHALL NOT 為不同 Locality 各設一個入口或頁面。
4. THE 任務清單的狀態篩選 SHALL 對每個終局狀態使用單一、不重複的選項,SHALL NOT 因裝置來源不同而出現兩個同義的狀態選項。
5. WHERE 介面呈現裝置來源選擇 THE 系統 SHALL 以使用者語彙呈現(「自動建立」對應任務動態建立的主機、「使用已有實例」對應接入常駐主機),SHALL NOT 暴露內部 host origin 取值。
6. THE 介面 SHALL 支援多語系切換,涵蓋 zh-Hant(繁體中文)、en(英文)、zh-Hans(簡體中文)、ja(日文)、ko(韓文),選擇 SHALL 按瀏覽器記憶;使用者自寫的測試案例文字 SHALL NOT 被翻譯。
7. THE 每一個面向使用者的介面字串 SHALL 經 i18n 機制提供,SHALL NOT 在元件中硬編碼可見文字;新增介面時缺少某語系翻譯 SHALL 可被自動化檢查偵測。
8. THE 翻譯完成度優先序 SHALL 為 zh-Hant > en > zh-Hans = ja = ko(主要市場為台灣與美國):zh-Hant 與 en SHALL 為完整一級語系,其餘為二級;預設語系 SHALL 為 zh-Hant,當瀏覽器語言無對應翻譯時 SHALL 回退至 en。
9. THE 介面 SHALL 同時提供深色與淺色兩種佈景主題並可由使用者切換,預設 SHALL 跟隨作業系統偏好(`prefers-color-scheme`),使用者的手動選擇 SHALL 按瀏覽器記憶並優先於系統偏好。
10. THE 兩種佈景主題 SHALL 各自獨立達到 WCAG AA 文字對比(對齊 Req 11.4),SHALL NOT 有任一主題下出現不可讀或對比不足的狀態呈現;主題切換 SHALL NOT 造成版面跳動或需重新載入頁面。
11. THE 顏色 SHALL 以語意化的設計權杖(design token)定義而非散落的硬編碼色值,使新增元件自動適用兩種主題,SHALL NOT 出現只在單一主題下正確的硬編碼顏色。

### Requirement 11 — 無障礙(Accessibility)

**User Story:** 作為使用輔助技術的測試工程師,我要能用鍵盤與螢幕報讀器操作整個介面,這樣工具本身不會成為我的障礙。

#### Acceptance Criteria

1. THE 所有互動元件 SHALL 可鍵盤操作(可聚焦、有可見焦點樣式、可用鍵盤觸發),SHALL NOT 存在只能用滑鼠完成的關鍵操作。
2. THE 介面 SHALL 為非文字內容(狀態徽章、圖示按鈕、截圖縮圖)提供文字替代或無障礙名稱。
3. WHEN 任務狀態或即時串流更新 THEN 系統 SHALL 以螢幕報讀器可感知的方式通報關鍵狀態變化(如任務進入終局),SHALL NOT 僅以顏色傳達狀態。
4. THE 文字與背景色 SHALL 達到 WCAG AA 對比度;狀態不 SHALL 僅以顏色區分(須輔以文字或形狀)。

> 註:完整的 WCAG 合規需以輔助技術實機測試與專家審查驗證;本需求界定的是可自動化檢查與設計階段可落實的部分。

### Requirement 12 — 缺陷分診輔助(flaky / 趨勢)

**User Story:** 作為測試工程師,我要區分「App 真的壞了」與「這個測試本身不穩」,並看到一個案例過去的通過趨勢,這樣我不會把 flaky 當缺陷追。

#### Acceptance Criteria

1. WHEN 同一測試案例存在多次歷史執行 THEN 系統 SHALL 呈現其通過/失敗趨勢與最近 N 次結果。
2. WHERE 一個案例在近期執行中結果反覆(時過時不過)無對應被測變更 THE 系統 SHALL 以可見標記提示其可能為 flaky,SHALL NOT 將 flaky 與確定性 fail 呈現為同一種東西。
3. WHEN 使用者查看一次 `fail` THEN 系統 SHALL 引導其區分成因方向(被測 App/測試案例 → 查 `fail`;環境/基礎設施 → 查 `error`),對應終局狀態的既有語義。

### Requirement 13 — 本地裝置代理(裝置在本地、大腦在雲端)

**User Story:** 作為測試工程師,我要把自己的筆電桌面、本地模擬器或本地瀏覽器註冊為一台受測裝置,讓雲端的 AI 逐步分析我這台裝置上的操作並回報,這樣我不必把被測目標搬上雲也能享有雲端分析。

#### Acceptance Criteria

1. THE 系統 SHALL 提供一個本地代理(agent),使用者可在自己的機器上執行它,將本機的桌面 / 本地模擬器 / 本地瀏覽器註冊為一台 `attached` 裝置。
2. THE 本地代理與雲端之間的連線 SHALL 由本地代理**主動向雲端撥出**(outbound-initiated),SHALL NOT 要求雲端主動連入本地或要求使用者在本地開放對外入站埠(以相容 NAT/防火牆後的一般筆電環境)。
3. WHILE 一個 attached 任務執行中 THE 系統 SHALL 依此迴圈運作:本地代理擷取當前畫面 → 上送雲端 → 雲端 VLM 依「上一動之後的影像」判斷下一步動作與座標 → 指令回傳本地代理 → 本地代理在本地裝置執行該動作 → 擷取新畫面回送,如此往返直至任務進入終局狀態。
4. THE 決策邏輯(Agent / VLM Seat)SHALL 恆在雲端,本地代理 SHALL NOT 內含任何測試決策邏輯,僅負責畫面擷取、動作執行與轉發。
5. WHERE attached 模式的每步往返延遲較高(數百毫秒至數秒) THE 系統 SHALL 接受此延遲為正常,定位於逐步行為分析與慢節奏/回合制流程;THE 系統 SHALL NOT 假設 attached 模式能滿足即時動作類遊戲的逐幀時效。
6. WHEN 本地代理連線中斷或本地裝置失聯 THEN 系統 SHALL 將該任務落為明確的終局狀態(裝置失聯歸 `error` 類,使用者主動停止歸 `cancelled`),SHALL NOT 停在無限等待。
7. THE attached 任務的截圖、步驟、報告 SHALL 與雲端任務共用同一 Trace 與報告呈現,使兩者的觀看/回看體驗一致。
8. THE 本地代理在建立連線時 SHALL 以登入使用者的租戶身分驗證,其上送的畫面與產物 SHALL 落在該租戶前綴下,SHALL NOT 跨租戶。

### Requirement 14 — 使用者身分帶入受測 session(登入被測遊戲/網頁)

**User Story:** 作為測試工程師,我要 AI 在測試時能用「我這個使用者的帳號」登入被測遊戲或網頁,這樣我測的是登入後的真實流程,而不是卡在登入頁。

#### Acceptance Criteria

1. WHERE 一個測試案例需要以某使用者身分登入被測目標 THE 系統 SHALL 允許該案例引用一份**租戶範圍的機密**(存於機密管理服務),由執行引擎在裝置端注入,而 SHALL NOT 要求把該登入憑證以字面量寫進案例 YAML 或存入產物儲存明文。
2. WHEN 一個 Device Farm 或其他雲端裝置 session 需要使用者遊戲/網頁帳號登入 THEN 系統 SHALL 在該 session 內以引用的機密完成登入注入,登入憑證 SHALL 僅在該 session 存活期間可用,session 結束即不再保留於裝置。
3. THE 被帶入的使用者登入身分(遊戲/網頁帳號)SHALL 與平台自身的租戶身分(Cognito)在概念與儲存上分離:平台身分決定「這是誰的資料/資源」,被測身分決定「用哪個帳號登入被測目標」。
4. THE 系統 SHALL 僅允許使用者引用其所屬租戶範圍內的機密,SHALL NOT 讓一個租戶引用另一租戶的登入機密。
5. IF 一份被引用的登入機密不存在或無權存取 THEN 系統 SHALL 在任何模型花費發生之前使任務失敗並明確回報成因,SHALL NOT 在裝置上以空憑證盲目嘗試登入。

### Requirement 15 — 介面效能與操作流暢性(非功能)

**User Story:** 作為每天用這個工具的測試工程師,我要介面開得快、切頁不卡、操作有即時回饋,這樣工具不會拖慢我的節奏。

#### Acceptance Criteria

1. WHEN 使用者於一般寬頻網路首次載入應用 THEN 首頁可互動時間(Time to Interactive)SHALL 在 3 秒內,首屏內容繪製(FCP)SHALL 在 1.5 秒內。
2. THE 前端 SHALL 以路由層級程式碼分割(code-splitting / lazy load)交付,使首次載入僅下載當前頁所需的程式碼,重量級模組(如程式碼編輯器、圖表、Live View 檢視器)SHALL 按需載入而非計入首包。
3. THE 前端靜態資產 SHALL 經內容雜湊命名並以長期快取交付於 CDN 邊緣,使回訪載入主要命中快取;應用外殼 SHALL NOT 因單次部署而讓所有資產快取全數失效(僅變更的檔案失效)。
4. WHEN 使用者切換分頁或觸發一個操作 THEN 介面 SHALL 在 100 毫秒內給出可見回饋(載入指示 / 骨架屏 / 樂觀更新),SHALL NOT 呈現無回饋的凍結。
5. WHEN 一個清單(任務 / 報告)資料量增長 THEN 系統 SHALL 以分頁或虛擬捲動呈現,單次請求與渲染量 SHALL NOT 隨總量無上限增長而拖垮載入。
6. WHILE Live View 與 Trace 串流持續更新 THE 介面 SHALL 維持流暢(串流更新 SHALL NOT 阻塞使用者對其他區域的操作),SHALL NOT 因高頻步驟推送造成畫面卡頓或記憶體無上限成長。
7. THE 互動延遲 SHALL 對應 Web 核心指標良好門檻(Interaction to Next Paint 於一般操作下 SHALL 維持在 200 毫秒內)。

> 註:上述數值為設計目標與驗收基準;實測值受網路與資料量影響,驗證方式見 design 各階段的效能檢查點。