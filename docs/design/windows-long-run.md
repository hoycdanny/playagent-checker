# Windows 測試超過 1 小時(GameLift Streams 保活)

狀態:**已實作並以真實 session 驗證**(2026-10-24,見下方「70 分鐘耐久測試」)。
時數選項已放寬到 24 小時。本文記錄一路上用真實 API 驗證過的事實、兩個被推翻的推論,
以及接線時才發現的兩個陷阱 —— 其中一個坑要花一個 GPU session 才會發現。

## 問題

engine 以 `SignalRequest='NO_CLIENT_CONNECTION'` 開 stream session,沒有任何 client 連進來。
這種 session 一定在一小時內被收掉,所以 Windows 任務的時數選項原本只有 1 小時。
新楓之谷這類「安裝 → 啟動器 → 下載更新 → 登入 → 進遊戲」的流程很可能超過一小時。

## 已驗證的事實

### `ConnectionTimeoutSeconds` 上限是 3600,AWS 強制

送 7200 / 43200 / 86400 都被拒:

```
ValidationException: 1 validation error detected: Value '7200' at
'connectionTimeoutSeconds' failed to satisfy constraint:
Member must have value less than or equal to 3600
```

所以 `windowsHost.ts` 的 `MAX_UNATTENDED_SECONDS = 3600` 是正確的,**沒有參數可以放寬**。
(這三次呼叫在驗證階段就被拒,沒有真的開 session —— 這個答案是免費的。)

### `SessionLengthSeconds` 可以到 86400(24 小時)

欄位語意(SDK 型別文件):

- `ConnectionTimeoutSeconds`:等 client **連線或重連**的窗口,從 session 進入 `ACTIVE` 起算。
  時間內沒有 client 連上就終止。預設 120。
- `SessionLengthSeconds`:session 的硬性總長,**不管有沒有 client 連著**。預設 43200(12 小時)。

目前 engine 把兩者都設成同一個值(`seconds`,上限 3600),所以 session 的壽命被自己壓到
一小時。實測最近一個 session 的終止原因是 `maxSessionLengthTimeout` 而不是 `connectionTimeout`
—— 就是這個設定造成的。

**解耦這兩個值是實作的第一步**:`SessionLengthSeconds` 給使用者選的時數(上限 24 小時),
`ConnectionTimeoutSeconds` 維持 3600。沒有保活時行為完全不變(還是一小時),有保活才吃得到
長時數。

### 結論:一定要有一個真的 client 連著(或定期重連)

`CreateStreamSessionConnection` 的用途正是這個:它讓 client 接進一個既有 session,
並且**保留 session 的全部狀態與資料**。可用狀態是 `PENDING_CLIENT_RECONNECTION` 或 `ACTIVE`。

## 為什麼一定要用 AWS 的 Web SDK(踩過兩次才弄清楚)

`SignalRequest` 與 `SignalResponse` **都是** `{"type":"offer"|"answer","sdp":"..."}` 這種
標準的 WebRTC JSON,沒有專有封裝。所以第一眼會以為可以跳過 SDK 自己用 WebRTC 連。

**但自己組的 offer 會被拒:**

```
ValidationException: 'SignalRequest' value is not a valid WebSDK signal request
```

差別不在封裝,在 **SDP 的內容**。SDK 產出的 offer 有三條 m-line
(`a=group:BUNDLE 0 1 2`:video、audio、再加一條 data channel —— GLS 用它傳輸入與控制),
而我用 `node-datachannel` 只做了 video + audio 兩條,就被判為不合法。

這個錯誤分兩階段才看清:先是 API 拒絕(花了一個約 7 分鐘的 session),
之後把 SDK 載進瀏覽器印出它的 offer,才發現封裝一樣、內容不一樣。
**結論是用 SDK,而它需要 `videoElement` / `audioElement`,所以瀏覽器躲不掉。**

順帶兩個也已確認的細節:

- `GetStreamSession` 回的 `webSdkProtocolUrl` 指向一支 185 KB 的 JS,但那只是**輸入模組**
  (掛在 `window.GameCastInputModule`,GameCast 是 GameLift Streams 的前身),不是完整 SDK。
- `node-datachannel` 的 **polyfill** 把 `addTransceiver` 做成會丟 `Not implemented` 的樁,
  只能用 data channel。它的**原生 API** 有 `Video` / `Audio` / `Track` / `RtcpReceivingSession`,
  媒體是做得到的 —— 但既然 offer 格式不對,這條路本身走不通。

## 已實測可行(2026-10-24)

`worker/windows-host/keepalive/` 的 `page.html` + `keepalive.mjs`,在本機用真實 Chromium
(Playwright)對一個 `NO_CLIENT_CONNECTION` 的 session 跑:

```
08:14:18 可以連了,啟動保活
08:14:19   SDK 已注入
08:14:22 [keepalive] 已連線(第 1 次)
08:14:24 狀態 CONNECTED | 連線次數 1 | up 2s
```

**session 從 ACTIVE 轉成 CONNECTED,約 4 秒。** 整條鏈(SDK 注入 → generateSignalRequest
→ CreateStreamSessionConnection → processSignalResponse)都通。

兩個踩到的實作細節:

- `addInitScript` 搭 `setContent` **不會**把腳本帶進頁面(實測 `window.gameliftstreams`
  不存在)。要先 `setContent` 再 `addScriptTag`;頁面的 inline 腳本只在 `init()` 裡才讀
  那個全域,而 `init()` 是之後才呼叫的,所以順序沒問題。
- `init()` 的回傳值一定要檢查。不檢查的話 `gls` 留在 null,接著 `offer()` 丟
  「尚未 init()」—— 那是個誤導的訊息,真正的原因(「SDK 未載入」)只出現在第一次嘗試,
  後面七次重試全都報錯的那一個。

## 保活的瀏覽器必須是真正的 Google Chrome

Playwright 官方 Docker 映像裡的 Chromium 是**開源建置,不含 H.264**,而 GameLift Streams
的 WebRTC 走 H.264。保活 task 第一次在 Fargate 上跑時,SDK 直接拒絕:

```
[keepalive] 連線失敗(第 1 次,等 5s):page.evaluate:
Error: Browser does not support H.264 video playback over WebRTC
    at $.internalGenerateOffer
```

修法是在映像裡裝真的 Chrome(`npx playwright install chrome`)並用
`chromium.launch({ channel: 'chrome' })`。Playwright 官方對這個問題的回答也是如此 ——
[Chromium 建置不支援 H264 這類專有編解碼器,請改用 Google Chrome 或 Microsoft Edge](https://github.com/microsoft/playwright/issues/36550)。
(內容為依授權限制改寫。)

**為什麼本機驗證沒踩到**:本機用的 Chromium 建置帶了編解碼器,所以這個差異只在 Linux
容器裡才冒出來。這也是為什麼 `keepAliveRunner.mjs` 多了一個 `PA_CHECK_ONLY=1` 模式:
映像層面的問題(Chrome 沒裝、SDK 的檔名變了、缺編解碼器)原本只有在真實任務裡才看得見,
而那代表每修一次都要燒一個 GPU session。現在用一個 Fargate task 就能單獨回答
「映像有沒有壞」,它會印出實際可用的編解碼器清單:

```
[keepalive] 自我檢查通過:Chrome + Web SDK + 視訊編解碼器就位
[keepalive] 視訊編解碼器:video/VP8, video/rtx, video/VP9, ..., video/H264, ...
```

順帶一個已知但還不急的事:Playwright 的 jammy 映像帶 Node 20,而 AWS SDK for JavaScript
在 2027 年之後的版本會要求 Node >= 22(目前只是警告)。換 base image 的時候要一起處理。

## SDK 取得方式

SDK 有公開的 S3 直連網址(可程式化取得,不必手動下載):

```
https://gameliftstreams-public-website-assets.s3.us-west-2.amazonaws.com/AmazonGameLiftStreamsWebSDK-v1.1.0.zip
```

bundle 內含 `gameliftstreams-x.x.x.js` / `.mjs` / `.d.ts`。

API 形狀(取自 AWS 官方範例 `aws-samples/sample-gameliftstreams-web-application`):

```js
window.myGameLiftStreams = new gameliftstreams.GameLiftStreams({
  videoElement, audioElement,
  inputConfiguration: { /* 保活不需要輸入,可全關 */ },
  clientConnection: { connectionState, channelError, serverDisconnect, applicationMessage },
});
const signalRequest = await myGameLiftStreams.generateSignalRequest();
// → 交給後端呼叫 CreateStreamSessionConnection,拿回 SignalResponse
await myGameLiftStreams.processSignalResponse(signalResponse);
```

重連走同一組呼叫(`generateSignalRequest` → `CreateStreamSessionConnection` → `processSignalResponse`)。

### 跑在哪

建議 Fargate,因為**平台已經有一樣的東西**:web 探索 runner 就是 Fargate + Playwright
無頭 Chromium(`agent/Dockerfile.web`、`agent/webExplorationRunner.mjs`)。保活 task 是那個
模式的縮小版,不是新的基礎設施類型。

不建議跑在 Windows 主機自己身上:主機沒有瀏覽器,而且為了保活在被保活的機器裡裝 Chromium
是倒過來的。

### 接進產品路徑要先解決的兩件事

接線之前查過一遍現有程式,有兩個不是「照抄 web runner」就能帶過的地方。

**一、session ARN 目前沒有被任何地方記住,也沒有任何人在輪詢它。**
`windowsHost.ts` 只 import 了 `StartStreamSessionCommand`,engine 的 windows 分支
(`infra/lambda/engine/index.ts`)拿到 `run.arn` 之後只用 `run.display` / `run.minutes` 組
一句 status 訊息就 return 了。engine IAM 雖然早就給了 `GetStreamSession` 與
`TerminateStreamSession`,但整個雲端沒有任何呼叫端;專案也沒有 Step Functions、
EventBridge 排程或任何 sidecar 協調機制(SQS/DynamoDB 旗標)。

所以保活 task 的啟動點只有一個可能:engine 在 `StartStreamSession` 回來之後、同一次
invoke 內立刻 `RunTask`,把 session ARN 當環境變數交給 task。**不需要**新增旗標機制 ——
`keepalive.mjs` 的收工判斷本來就是主動輪詢 `GetStreamSession`(`FINAL_STATES` =
`TERMINATED` / `TERMINATING` / `ERROR`),session 一結束它自己就退出。

反過來說,`RunTask` 失敗就不能放著不管:session 已經開了,卻沒有人會連它。那種情況要
`TerminateStreamSession` 之後丟錯,讓 engine 最外層的 catch 寫 `state:'error'`。
開著一個沒人連的 session 等 GameLift 一小時後收掉,換來的是一筆卡在「執行中」、
沒有報告的任務。

**二、`PA_DEADLINE_MS` 不能直接改成長的。**
runner 靠它在 session 被收掉前 5 分鐘自己收尾寫報告。`RunTask` 成功不等於保活連上
(映像拉不到、WebRTC 出不去都可能),而一旦 deadline 給了長值但保活其實沒連上,
session 會在 3600 秒被 `connectionTimeout` 收掉,runner 卻以為還有好幾小時 ——
任務停在「執行中」、沒有報告,正是最糟的結果。

所以 deadline 要做成**租約**而不是常數:

- 初始 `PA_DEADLINE_MS` 仍用保守值 `min(session, 3600) - 300`,和現在完全一樣。
- 保活 task 每次確認連線還活著(`decide()` 回 `hold`),就把
  `tenants/<t>/jobs/<job>/lease.json` 的 deadline 往後推。
- runner 每分鐘讀一次 lease,取 `max(初始 deadline, lease)`。

這樣兩種失敗都是安全的:保活連不上 → lease 從來沒出現過 → runner 照一小時收尾寫報告;
保活中途死掉 → lease 停止更新 → runner 在最後一次租約到期前收尾。而且不必讓 engine
去預測保活會不會成功,它預測不了。

(順帶:斷線本身不急。WebRTC 斷掉後 session 轉 `PENDING_CLIENT_RECONNECTION`,
`ConnectionTimeoutSeconds` 的 3600 秒窗口重新開始算,保活 task 有整整一小時可以重連。)

### 實作順序

1. engine 解耦 `SessionLengthSeconds` 與 `ConnectionTimeoutSeconds`(無保活時行為不變)。
2. 保活 task 的映像:Playwright + 建置時下載 SDK zip + 一頁極簡 HTML。
3. task 內的 Node:輪詢 session 狀態、`generateSignalRequest` → `CreateStreamSessionConnection`
   → `processSignalResponse`、斷線重連(退避),並在 session 終止時自己結束。
4. runner 端的 deadline 租約(上面第二點)。
5. engine 在 `maxHours > 1` 時連同 Windows session 一起啟動 task;`RunTask` 失敗要收掉 session。
6. 前端放寬 `WINDOWS_HOUR_OPTIONS`,並說明「超過一小時需要保活」。

### 70 分鐘耐久測試(2026-10-24)

這是整條路上最後一個未知:「有 client 連著就能活過 3600 秒」這件事本身。
前面只證明了「連得上、session 會變成 CONNECTED」,沒有真的掛超過一小時。

刻意不接真實任務,用一個「只睡覺」的治具應用,不然失敗時分不清是保活沒用還是任務本身
的問題。`SessionLengthSeconds=7200`、`ConnectionTimeoutSeconds=3600`:

```
09:10:19 ACTIVE,啟動保活
09:10:24 [keepalive] 已連線(第 1 次)
09:11:20 +  1 分(61s)   狀態 CONNECTED | 連線 1 次
...
10:09:55 + 60 分(3575s) 狀態 CONNECTED | 連線 1 次
10:10:55 + 61 分(3636s) 狀態 CONNECTED | 連線 1 次  ← 已跨過 3600 秒
10:13:57 + 64 分(3818s) 狀態 CONNECTED | 連線 1 次
```

**結論:活過 3600 秒,壽命由 `SessionLengthSeconds` 決定。** 而且整段只連了一次 ——
WebRTC 連線一小時都沒有斷過,重連路徑在這次測試裡沒有被用到(所以它仍然只有單元測試
蓋著,沒有真實驗證)。

對照組不必另跑:之前幾次沒有保活的 session 都在 3600 秒以 `connectionTimeout` 被收掉。

### 實作後的檔案分布

保活的程式碼放在 `agent/` 而不是 `worker/windows-host/`:它跑在 Fargate,不是跑在被保活
的那台 Windows 主機上。放在 `agent/` 還有一個實際好處 —— `infra/test/runner-dockerfiles.test.ts`
會檢查每個 Dockerfile 有沒有 COPY 它 entry 模組所 import 的全部檔案,漏一個的話
容器一啟動就 `ERR_MODULE_NOT_FOUND`(Device Farm runner 踩過)。

| 檔案 | 作用 |
| --- | --- |
| `agent/glsKeepAlive.mjs` | 保活邏輯:`decide()`、`retryDelayMs()`、`leaseDeadlineMs()`、`createKeepAlive()` |
| `agent/glsKeepAlivePage.html` | SDK 需要的最小頁面(隱藏且靜音的 video/audio;不呼叫 `attachInput()`) |
| `agent/keepAliveRunner.mjs` | task 的 entry:開 Chromium、跑保活、維護 deadline 租約 |
| `agent/Dockerfile.keepalive` | Playwright 映像 + 建置時下載 Web SDK(`test -s` 擋 URL 變動) |
| `agent/sagemaker/buildspec.keepalive.yml`、`cloudBuildKeepAlive.mjs` | 雲端建置並推 `playagent-keepalive-runner` |
| `infra/lambda/engine/keepAliveHost.ts` | engine 的 `RunTask`(照 `webHost.ts` 的模式) |

接上去要改的名稱清單有四處,漏一處就是「映像沒重建」或「日誌頁看不到它」:
`infra/bin/app.ts`(`imageBuildProjects` / `imageRepos`)、`infra/lib/updater-stack.ts`
(自更新時重建映像的那一行)、`scripts/deploy-latest.mjs`(`repos`)、
`infra/lambda/api/systemLogs.ts` 與 `web/src/components/system/LogsPanel.tsx`(日誌來源 id)。

### 工具上的小坑

本機的 AWS CLI **沒有 `gameliftstreams` 子命令**(版本太舊),所以查 application / stream group
的狀態要寫 Node 腳本用 SDK,不能用 `aws gameliftstreams ...`。

耐久測試的治具不能用 `host.ps1`,也不能用真實任務:
- `host.ps1` 跑完就結束,而**應用結束 session 就跟著結束**,撐不到 60 分鐘。
- 真實任務會被 runner 的死循環護欄在幾分鐘內停掉。

所以治具是一個「只睡覺」的最小應用(`launcher.bat` 跑 `Start-Sleep -Seconds 9000`)。

### 目前的進度

- [x] 解耦 `SessionLengthSeconds` 與 `ConnectionTimeoutSeconds`(無保活時行為不變)
- [x] 保活頁面 + 模組:連得上,實測 4 秒進入 CONNECTED
- [x] Fargate task 映像(Playwright + 建置時下載 SDK)
- [x] runner 端的 deadline 租約(`explorationRunner.mjs` 每分鐘讀 `lease.json`)
- [x] engine 在 `maxHours > 1` 時啟動保活;`RunTask` 失敗會收掉 session 再丟錯
- [x] 掛 70 分鐘的驗證:活過 3600 秒(2026-10-24)
- [x] 放寬前端的 `WINDOWS_HOUR_OPTIONS` 到 `[1, 2, 6, 12, 24]`

### 還沒驗證的部分(誠實記錄)

- **保活在 Fargate 裡連得上嗎**:上面的驗證是在本機 Chromium 跑的。Fargate 的
  security group 是 stateful、task 在 public subnet 帶公網 IP,推論上與家用 NAT 後面的
  瀏覽器一樣(client 主動發起,回應流量自動放行),但沒有實跑過。
- **斷線重連**:耐久測試整段沒斷過,重連路徑只有單元測試蓋著。
- **deadline 租約的端到端**:`leaseDeadlineMs` 與 runner 的讀取各自有測試,但「保活寫、
  runner 讀、收尾時間真的被延後」這條鏈沒有在真實任務上跑過。
- **超過一小時的真實遊戲任務**:還沒跑過一次。
