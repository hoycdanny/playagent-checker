# Windows 測試的聲音判斷(WASAPI 音量)

狀態:**已實作,本機驗證通過;GameLift Streams 主機上還沒驗證**(最大的未知是那台機器
到底有沒有音訊輸出端點,見文末)。

## 要解的問題

「按了技能有沒有音效」「BGM 有沒有在放」「切到設定把音樂關掉後真的安靜了嗎」——
這類檢查項模型光看畫面得不到答案。而模型在沒有資訊時傾向「照常回答」,所以它會寫出
「已聽到技能音效」這種憑空的結論。那比不回答更糟:報告看起來驗證過了,其實沒有。

Android 那條有兩套既有做法:`deviceLogs.mjs` 用 `dumpsys audio` 取每步的播放器狀態,
`mediaAudio.mjs` 用 MediaProjection 錄整場再用 ffmpeg 算 RMS。兩套都依賴 Android
(adb / Appium 的 `mobile:` 擴充),Windows 一個都用不了。

## 為什麼不是 ffmpeg

ffmpeg 在 Windows 的音訊輸入走 dshow,而 **dshow 不暴露 WASAPI loopback** —— 要錄系統
「播放出去」的聲音,得先裝一個虛擬音訊驅動(virtual-audio-capturer、VB-CABLE 之類)。
那是核心模式驅動,需要重開機與簽章,在一個用完就消失的 stream session 裡裝不了。
這個結論已經寫在 `agent/windowsCapture.mjs` 的檔頭(即時影片那條也因此只有畫面)。

## 做法:問系統「現在播多大聲」

`IAudioMeterInformation::GetPeakValue` 不必裝任何東西、也不必開音訊串流,它直接回報
輸出端點當下的峰值(0~1)。要回答「有沒有在出聲」這就夠了,而且成本極低。

鏈路沿用既有的三層結構(與截圖、滑鼠鍵盤同一條):

| 層 | 檔案 | 這次加的東西 |
| --- | --- | --- |
| P/Invoke | `agent/WinHelper.cs` | `AudioSample(ms)` + 三個 COM 介面宣告 |
| JSON 行協定 | `agent/winHost.ps1` | `audio` 指令 |
| runner 介面 | `agent/windowsClient.mjs` | `audioSample()`、`parseAudioSample()`、`audioSnapshot()`、`soundNote()` |
| runner 主迴圈 | `agent/explorationRunner.mjs` | 每步取樣 → 寫 `devlogs/audio/*.json` → 注入 prompt |

### 兩個實作細節

**COM 介面方法必須按 vtable 原順序宣告,用不到的也要佔位。** 少一個後面全部錯位,
而錯位不會乾淨地失敗 —— 它會呼叫到別的方法。`IMMDevice` 的順序是
`Activate` / `OpenPropertyStore` / `GetId` / `GetState`。

**peak 是瞬時值,所以不能只讀一次。** 音效的波形會經過零點,剛好讀在那裡就會把有聲音
判成靜音。所以在一段時間內以 10ms 間隔連續取樣(預設 250ms,約 25 個樣本),取最大值。

### 取樣在主線上等完,不丟背景

效能取樣與裝置 log 都是「與 VLM 推理並行、晚一點收回來」,但聲音不行:它必須對應
「這一張畫面的這一刻」。丟到背景會變成「上一步的聲音配這一步的畫面」,那比沒有資訊更糟。
250ms 的代價換這個對應關係是值得的。

### 快照沿用 Android 的 schema

`devlogs/audio/<6位>.json` 刻意與 Android 同形狀(`{step, at, players[], outputs[], playbackRaw}`),
所以前端的「音效」分頁(`DeviceLogsPanel` 的 `AudioSnap`)不用改就能用:有聲音時給一筆
`state: 'started'` 的播放器,前端的「♪ 播放中」就會亮。代價是 `players` 在 Windows 上
只是「有/沒有在出聲」的一筆,不像 Android 能列出每個播放器;實際數字放在 `peak` / `avg`,
並原樣寫進 `playbackRaw` 給人看。

### 「量不到」和「沒聲音」必須分開

這是這個功能最容易做錯的地方,也是測試裡條目最多的地方:

| 情況 | `ok` | 給模型的話 |
| --- | --- | --- |
| 有聲音 | true | 有聲音輸出(帶峰值) |
| 靜音 | true | 沒有聲音輸出;**如果這一步本來該有音效,這就是一個缺陷** |
| 沒有音訊裝置 | false | 讀不到輸出音量;**不要宣稱聽到或沒聽到** |

把「量不到」講成「沒聲音」等於憑空生出一個缺陷報告。

門檻取 `0.002`:本機實測靜音是 `0.00000`、播放 Windows 內建 wav 是 `0.13195`,
中間差兩個數量級,所以門檻放在很低的位置就夠,不必調參。

## 本機驗證(2026-10-24)

`Add-Type` 編譯 `WinHelper.cs`(C# 5,不需要 .NET SDK)之後:

```
silent:     {"ok":true,"peak":0.00000,"avg":0.00000,"samples":30,"state":1,"device":"{3.0.0.00000002}.{6C26...}"}
playing:    {"ok":true,"peak":0.13195,"avg":0.07920,"samples":70,"state":1,"device":"{3.0.0.00000002}.{6C26...}"}
after stop: {"ok":true,"peak":0.00000,"avg":0.00000,"samples":30,"state":1,"device":"{3.0.0.00000002}.{6C26...}"}
```

COM 宣告正確(讀到真實的 endpoint id 與 `state=1` = ACTIVE)、峰值會隨播放而動、停止後歸零。

## GameLift Streams 主機上的結果(2026-10-24):端點有,但鏈路不通

兩次真實任務的結果:

**端點存在,而且讀得到。** 這一點推論正確(GLS 要把遊戲的聲音串流給觀看端,所以必須有一個
虛擬輸出裝置):

```json
{"ok":true,"peak":0,"avg":0,"samples":25,"state":1,
 "device":"{0.0.0.00000000}.{404f29f2-217f-4974-93f8-c0b36689cb08}"}
```

`state=1` 是 ACTIVE、device id 是真實的、25 個樣本都讀到了。

**但主機自己播出去的測試音,量表量不到:**

```json
{"chainOk":false,"peak":0,"quiet":0,"why":"test-tone-not-heard"}
```

所以 `peak=0` 的原因不是「遊戲沒出聲」,是**我們量的那個端點不是聲音實際走的地方**。
自我檢查就是為了分辨這兩件事,它正確地抓到了:runner 因此停用聲音判斷,
`devlogs/audio` 不再產生快照,模型也不會收到任何聲音相關的敘述 ——
**不會憑空生出一個「沒有音效」的缺陷**,這是目前最重要的行為。

結論:**Windows 目前測不了音效。** 機制與防線都就位,缺的是找到正確的端點。

### 往下追的方向(還沒做)

1. **列舉所有端點**(`IMMDeviceEnumerator::EnumAudioEndpoints`,含 `DEVICE_STATE_UNPLUGGED`
   等所有狀態),看這台機器上到底有幾個輸出裝置、`GetDefaultAudioEndpoint(eRender, eConsole)`
   回的是不是 GLS 串流實際用的那一個。最可能的情形是有多個虛擬裝置而預設的那個不是。
2. **改讀程序層級的 session**(`IAudioSessionManager2::GetSessionEnumerator` +
   `IAudioMeterInformation`):即使端點層的量表不動,遊戲程序建立的音訊 session 仍可能
   量得到。這條的好處是順便知道「是哪個程序在出聲」。
3. **Windows Audio 服務與 session 隔離**:確認 `winHost.ps1` 所在的 Windows session 與
   遊戲是同一個(截圖與輸入是同一個桌面 session,但音訊的 endpoint 對應關係要另外確認)。

`chainOk=false` 不會讓任務失敗:聲音判斷停用,測試照跑,報告裡就是沒有音效這一項。

## 還沒做的

- **波形 / 時間軸**:目前每步一個峰值,不是連續的 RMS 曲線。Android 的 `audio/levels.json`
  有波形是因為它有一整段錄影可以分析;Windows 要有等價的東西需要真的擷取 PCM
  (`IAudioClient` + `AUDCLNT_STREAMFLAGS_LOOPBACK`),那是另一個量級的工作。
- **影片帶音軌**:即時影片仍然無聲。前端有四處預設靜音(`LivePlayer.tsx` 的 prop 預設、
  `source === 'live'` 的強制靜音、`<video>` 的靜態屬性、`LiveScreen` 的傳值),
  要讓 Windows 的影片有聲音得先能擷取 PCM,然後這四處都要一起改。
