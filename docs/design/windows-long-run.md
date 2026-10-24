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

## 一個已被推翻的推論(重要)

從我們自己的 session 讀出 `SignalResponse`,它是**標準的 WebRTC JSON**:

```json
{"type":"answer","sdp":"v=0\r\no=- ...(含 ICE candidate 與 DTLS fingerprint)","webSdkProtocolUrl":"..."}
```

據此我推論 `SignalRequest`(offer)也是 `{"type":"offer","sdp":"..."}`,於是用
`node-datachannel` 寫了一個純 Node 的 WebRTC peer,想完全跳過 AWS 的 Web SDK 與瀏覽器。

**這是錯的。** 真的打 API 的結果:

```
ValidationException: 'SignalRequest' value is not a valid WebSDK signal request
```

答案是標準格式,請求不是。請求要 Web SDK 產生的專有封裝。
這個錯誤只有實際呼叫一次才會發現(花了一個約 7 分鐘的 session)。

順帶兩個也已確認的細節:

- `GetStreamSession` 回的 `webSdkProtocolUrl` 指向一支 185 KB 的 JS,但那只是**輸入模組**
  (掛在 `window.GameCastInputModule`,GameCast 是 GameLift Streams 的前身),不是完整 SDK。
- `node-datachannel` 的 **polyfill** 把 `addTransceiver` 做成會丟 `Not implemented` 的樁,
  只能用 data channel。它的**原生 API** 有 `Video` / `Audio` / `Track` / `RtcpReceivingSession`,
  媒體是做得到的 —— 但既然 offer 格式不對,這條路本身走不通。

## 可行的做法

必須用 AWS 的 Web SDK,而它需要 `videoElement` / `audioElement`,也就是需要 DOM
→ **無頭瀏覽器躲不掉**。

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

**「有 client 連著就能活過 3600 秒」這件事本身還沒實測過。** 文件說 `SessionLengthSeconds`
不管連線狀態、`ConnectionTimeoutSeconds` 只在等 client 時適用,兩者合起來強烈暗示可行,
但沒有真的跑超過一小時驗證。第 2、3 步做完後,第一個測試就該是「連上並掛 70 分鐘」,
而不是直接接上真實任務。
