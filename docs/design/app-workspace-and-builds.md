# 應用工作區、多版本安裝檔、成本分析

這份文件說明三件事的設計與限制:

1. 測試案例／測試任務／測試報告／記憶地圖／知識管理整合進「應用管理」的工作區。
2. 應用管理頁的成本分析(含每個應用的縮小走勢圖)。
3. 單一應用保留多個版本安裝檔(APK／IPA／EXE)。

---

## 1. 應用工作區(`/apps/{appId}`)

點應用卡片進入工作區,原本分散在側邊欄的功能都以分頁呈現,而且全部**鎖定在這個應用**:

| 分頁 | 內容 | 資料來源 |
| --- | --- | --- |
| 總覽 | 案例數／任務數／報告數／通過率／記憶畫面數、最近 5 筆任務 | 下列各項的彙總 |
| 版本 | 多版本安裝檔管理(見第 3 節) | `GET /apps/{id}`、`POST /apps/{id}/builds*` |
| 測試案例 | 建立／編輯／刪除(建立時自動綁本應用) | `GET /cases?app=` |
| 測試任務 | 送出測試、任務清單 | `GET /tasks?app=`、`POST /tasks` |
| 測試報告 | 報告清單、搜尋、排序 | `GET /reports?app=` |
| 記憶地圖 | 畫面圖、提示、已刪節點、清空記憶 | `GET /memory?app=` |
| 知識 | 綁定「這個應用預設帶哪幾座知識庫」 | `GET /knowledge-bases`、`PUT /apps/{id}` |
| 測試憑證 | 這個應用的帳密(值永不回傳) | `/apps/{id}/credentials` |

分頁狀態寫進網址(`?tab=builds`),所以重新整理、分享連結、瀏覽器上一頁都會回到同一個分頁。

### 實作上的取捨:工作區直接用主頁面的元件

案例／任務／報告三個分頁**不是**另寫一份清單,而是直接 render 獨立頁面的元件並傳入 `appId`:

```tsx
{tab === 'cases'   && <CasesPage   appId={appId} />}
{tab === 'tasks'   && <TasksPage   appId={appId} />}
{tab === 'reports' && <ReportsPage appId={appId} />}
```

三頁都支援這個「嵌入模式」:傳了 `appId` 就少掉頁標題與應用選擇／應用篩選,資料範圍鎖定該應用,其餘結構(統計、篩選列、表格、分頁載入、建立／送出表單)一字不差 —— 因為就是同一個元件。版面無法走歪,也不會修了一邊忘了另一邊。

- 版面層只多一個 class:`.listpage--embed` 把頁面層級的寬度上限與內距歸零,內部 class 全不變。
- 嵌入模式各自的資料範圍:`GET /cases/overview`(沒有 app 參數,前端依 `item.app` 篩)、`GET /tasks?app=…&limit=200`、`GET /reports?app=…`。
- 報告頁的篩選狀態存在網址 query;嵌入時「清除篩選」會保留 `?tab=`,否則會把使用者踢回工作區總覽。
- **記憶地圖**同樣共用:抽成 `components/memory/MemoryPanel.tsx`,`/memory` 整頁只剩「選應用」+ 這個面板。
- **知識管理**只在工作區提供「綁定預設知識庫」,完整的建立/上傳/索引仍在 `/knowledge`。原因:知識庫是**跨應用共用**的資源(存在共用 bucket),不屬於任何單一應用;工作區要回答的只是「這個應用預設用哪幾座」。
- 行為上的一個變化:工作區送出的任務以前固定帶 `category: 'exploration'`,現在與主頁面一致(預設 `test`)。引擎不看這個欄位,它只影響報告上的類型標籤與篩選。

### 導覽列

測試案例／測試任務／測試報告／記憶地圖**不放在上方導覽列** —— 它們都綁在某個應用上,入口是「應用管理 → 進入工作區」的分頁。導覽列只留跨應用的入口(指南、應用管理、真機、知識管理、費用分析)。`#/cases`、`#/tasks`、`#/reports`、`#/memory` 這些路由仍然有效,直接輸入網址或從報告/任務詳情返回都還能用,只是不佔版面。

### 限制

- `GET /tasks?app=` 的篩選在後端做在截斷之前,所以冷門應用也看得到任務;但它要掃過全部任務的索引,應用數/任務數非常多時這支 API 會變慢(目前沒有二級索引)。
- 工作區的任務清單一次抓 200 筆(後端上限),沒有無限捲動。更久以前的任務請到 `/tasks`。

---

## 2. 應用卡片上的花費指標

應用管理頁**不放**成本分析區塊 —— 完整的成本分析已經是獨立一頁(`/cost`),在應用清單上再放一份只是重複又吃掉版面(曾經做過,已移除)。

留下的是每張應用卡片下方一條窄指標:近 30 天測試次數、近期通過率、近 30 天花費,加一張 `components/charts/Sparkline.tsx` 走勢圖(自己一列、撐滿卡片寬度)。

- 資料來源:`GET /cost?days=30`,`useQuery` 的 key 刻意用 `cost:30`,與成本分析頁**共用快取** —— 那支 API 要掃全部任務,兩頁之間來回不會重打後端。
- 走勢圖是純 SVG(專案沒有引入圖表套件),刻意不畫座標軸 —— 那個尺寸讀不出精確數值,它要回答的是「在漲還是在跌、有沒有突然暴衝」,精確數字由旁邊的文字給。

### 限制

- **卡片上的通過率取自最近 200 筆任務**(`GET /tasks?limit=200`,後端上限),是「近期通過率」而不是全期間通過率;只計入已判定 pass/fail 的任務,error／取消不列入。
- 成本只含 AI 模型費用(token × 官方單價估算)與真機實際計量分鐘,**不含** Fargate／S3／API 等基礎設施。實際帳單在 `/cost` 的「AWS 帳單」分頁(Cost Explorer,約 24 小時延遲)。
- 已刪除的應用仍可能有歷史花費,這時列表顯示 appId 而不是名稱。

---

## 3. 一個應用、多個版本安裝檔

### 資料模型

```ts
interface AppBuild {
  artifactId: string;              // 版本身分 = S3 產物 id
  label: string;                   // 顯示用版本標籤,如 1.2.12
  kind: 'apk' | 'ipa' | 'zip' | 'exe';
  uploadedAt: string;
  notes?: string;                  // 這一版改了什麼
  uploadedBy?: string;
}

interface AppRecord {
  // ...
  artifactId?: string;   // 「使用中」的版本(保留純量,沒有資料遷移)
  builds?: AppBuild[];   // 新到舊,上限 30
}
```

刻意**保留純量 `artifactId` 當作「使用中版本」**,而不是改成陣列:`job.json`、`appPurge`、`POST /tasks` 都讀它,換成陣列要動資料遷移。讀取時 `withBuilds()` 會把「只有 `artifactId` 沒有 `builds`」的舊應用即時補成一筆版本(不改寫 S3),所以前端一致處理。

**版本身分就是 `artifactId`**,而任務的 `job.json.artifactVersion` 存的正是它,`trends.ts` 也已經依 `artifactVersion` 分組做 flaky 分診 —— 所以「跨版本回歸比較」不需要改趨勢分析,舊版重跑的結果會自動落在不同分組。

### API

| 路由 | 行為 |
| --- | --- |
| `POST /apps/{id}/builds` | 新增版本並設為使用中;同一個 `artifactId` 重複加是更新(冪等);超過 30 版拒絕(要先刪舊版,不無聲丟棄安裝檔) |
| `POST /apps/{id}/builds/{artifactId}/activate` | 切換使用中版本,應用的顯示版本跟著標籤走 |
| `DELETE /apps/{id}/builds/{artifactId}` | 從清單移除。**不允許刪使用中的版本**(除非它是最後一版);安裝檔只有在沒有任何應用還引用它時才真的從 S3 刪掉,回應帶 `artifactDeleted` |

`POST /tasks` 多一個可選的 `buildId`:沒給就測使用中的版本。工作區的送出表單在版本數 > 1 時才顯示「測試版本」下拉。

### 一併修掉的兩個既有缺陷

- `appPurge`(刪應用時清產物)原本只看每個應用的純量 `artifactId`,導致刪 A 應用會連帶刪掉 B 應用歷史版本的安裝檔。現在「正在使用」的集合會展開所有應用的 `builds[]`。
- iOS 送出任務時產物路徑寫死 `app.apk`,`app.ipa` 永遠選不到。現在依版本的 `kind` 決定。

### 限制

- 歷史報告指向舊版不受影響(報告看的是當時的執行結果),但**刪掉版本後就無法再用那一版重跑**。
- 每個應用最多 30 個版本,這是避免無節制堆 S3;要更多請先刪舊版。
- 版本之間沒有自動 diff／自動回歸判定。要比較就是「用舊版重跑同一個案例」,再看報告或趨勢頁。
- 「使用中」只有一個;不支援同時對多版本批次送出同一個案例(要自己送兩次)。

---

## 4. 卡片瘦身與入口位置

應用卡片只留「辨識 + 近況」:圖示、名稱、平台/類型標記、狀態標記(沒有安裝檔、有幾個版本、版本號)、近 30 天指標與走勢圖,以及一個「進入工作區」。

搬走的東西:

| 原本在卡片上 | 現在在哪 |
| --- | --- |
| 版本 / 識別碼 / 被測產物 / 建立時間 / 備註 | 工作區(身份列的標記 + 編輯表單) |
| 編輯 | 工作區標題列的「編輯」→ 連到 `/apps?edit=<id>`,應用管理頁載入後直接開該應用的編輯表單並清掉 query |
| 刪除 | 工作區標題列的「刪除」(同樣要輸入名稱確認,後端回 `done:false` 時續呼叫到刪完,然後回應用清單) |

一張卡少四行 meta,等於同一個畫面多看到一整列應用。

## 5. 機密引用移進工作區

`被測登入機密引用`(`${鍵名}` / `secretRef:全名`)原本在裝置管理頁,現在抽成 `components/secrets/SecretRefsPanel.tsx`,放在工作區的「測試憑證」分頁下半部。

**範圍要講清楚**:這組機密是 `playagent/tenant/<tenantId>/<鍵名>`,**整個租戶共用**,不是單一應用 —— 每個應用的工作區看到的是同一份清單。介面上直接寫了這句(`workspace.secretsShared`)。只屬於某個應用的帳密請用同一頁上半部的「測試憑證」(`/apps/{id}/credentials`,每個應用一個 secret、key→{value,visible} 的 JSON)。

兩者沒有合併:合併會改掉機密命名,已經寫在案例 YAML 裡的 `secretRef:playagent/tenant/<t>/KEY` 會失效。

## 6. 裝置管理:四種執行資源

裝置管理頁現在有五張卡:

| 卡片 | 資料來源 | 內容 |
| --- | --- | --- |
| 雲端真機(Device Farm) | `GET /devices/cloud` | 可用真機池(機型/Android 版本/解析度/記憶體/CPU) |
| 容器(Fargate) | `GET /devices/infra` → `containers` | 執行中的 ECS task:cluster、vCPU/記憶體、已執行時間 |
| 每任務主機(EC2) | `GET /devices/infra` → `hosts` | 帶 `playagent:jobId` 標籤的機器:機型、AZ、已執行時間、任務編號 |
| Windows 串流(GameLift Streams) | `GET /devices/infra` → `streams` | stream group id/狀態、每個地點的常駐/隨需/已配置/閒置容量、進行中 session 數 |
| 本地裝置(attached) | `GET /devices` | **整區反灰 + 「開發中,尚未開放」**;註冊欄位與按鈕 disabled,已註冊的裝置仍可移除 |

### 實作細節與限制

- `GET /devices/infra` 三段各自 try/catch,失敗的那一段寫進 `errors: ["streams: …"]`,前端只在該張卡顯示「無法讀取:原因」。容量顯示錯誤比不顯示更糟,所以不會用 0 代替讀取失敗。
- 後端快取 30 秒(同一個 Lambda 實例),避免每次開頁都打 ECS/EC2/GameLift。
- 這些是**平台共用資源,不分租戶**(和 `/devices/cloud` 同性質,不經租戶隔離角色),頁面上已註明。
- GameLift stream group id 用 `ssm:GetParametersByPath('/playagent', recursive)` 找 `*/windows-gls/streamGroupId`,不把 Execution stack 名稱跨 stack 傳進 ControlPlane。注意 `GetParametersByPath` 的授權資源是**路徑本身**(`parameter/playagent`),不只是底下的參數。
- `@aws-sdk/client-gameliftstreams` 不保證在 Lambda runtime 內建,所以 API Lambda 的 esbuild 從「全部 `@aws-sdk/*` 當外部」改成明列外部模組,讓這個 client 打包進 bundle。**打包 CJS client 進 ESM bundle 一定要加 `createRequire` banner**,否則載入時會炸 `Dynamic require of "node:https" is not supported`,而且是整支 Lambda 起不來(所有 API 都 500),不是只有那一個路由壞掉。
- `ecs:ListClusters/ListTasks` 與 `ec2:DescribeInstances` 原本只在有 updater 時授權(更新前檢查用),現在改成常駐授權,並補上 `ecs:DescribeTasks`、`ec2:DescribeTags`。全部是唯讀。
