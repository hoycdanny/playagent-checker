# Windows 測試超過 1 小時(GameLift Streams 保活)

狀態:**尚未實作**。本文記錄已經用真實 API 驗證過的事實與一個已被推翻的推論,
目的是讓實作的人不必重複踩同樣的坑(其中一個坑要花一個 GPU session 才會發現)。

## 問題

engine 以 `SignalRequest='NO_CLIENT_CONNECTION'` 開 stream session,沒有任何 client 連進來。
這種 session 一定在一小時內被收掉,所以 Windows 任務的時數選項只有 1 小時
(`WINDOWS_HOUR_OPTIONS = [1]`)。新楓之谷這類「安裝 → 啟動器 → 下載更新 → 登入 → 進遊戲」
的流程很可能超過一小時。

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
  媒體做得到,但如上所述光有 media 還不夠。

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

### 實作順序

1. engine 解耦 `SessionLengthSeconds` 與 `ConnectionTimeoutSeconds`(無保活時行為不變)。
2. 保活 task 的映像:Playwright + 建置時下載 SDK zip + 一頁極簡 HTML。
3. task 內的 Node:輪詢 session 狀態、`generateSignalRequest` → `CreateStreamSessionConnection`
   → `processSignalResponse`、斷線重連(退避),並在 session 終止時自己結束。
4. engine 在 `maxHours > 1` 時連同 Windows session 一起啟動 task,收尾時停掉。
5. 前端放寬 `WINDOWS_HOUR_OPTIONS`,並說明「超過一小時需要保活」。

### 還沒驗證的關鍵假設

**「有 client 連著就能活過 3600 秒」這件事本身還沒實測過。** 已經證明的是「連得上、
session 會變成 CONNECTED」,但沒有真的掛超過一小時。文件說 `SessionLengthSeconds`
不管連線狀態、`ConnectionTimeoutSeconds` 只在等 client 時適用,兩者合起來強烈暗示可行。

**所以下一個測試就是「連上並掛 70 分鐘」,不要直接接上真實任務** —— 不然失敗時分不清
是保活沒用,還是任務本身的問題。那一次測試要花約 70 分鐘的 GPU 時間,是這條路上
最後一個未知。

### 目前的進度

- [x] 解耦 `SessionLengthSeconds` 與 `ConnectionTimeoutSeconds`(無保活時行為不變)
- [x] `page.html` + `keepalive.mjs`:連得上,實測 4 秒進入 CONNECTED
- [ ] 掛 70 分鐘的驗證(最後一個未知)
- [ ] Fargate task 映像(Playwright + 建置時下載 SDK)
- [ ] engine 在 `maxHours > 1` 時啟動 / 收尾保活
- [ ] 放寬前端的 `WINDOWS_HOUR_OPTIONS`
