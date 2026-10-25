# Windows 測試的聲音判斷(WASAPI 音量)

狀態:**機制已實作並部署,本機驗證通過;但在 GameLift Streams 主機上量不到聲音,
所以 Windows 目前還測不了音效。** 關鍵是啟動時的自我檢查會發現這件事並停用聲音判斷,
不會讓模型憑空報出「沒有音效」這種缺陷。詳見文末「GameLift Streams 主機上的結果」。

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

## GameLift Streams 主機上的結果(2026-10-24)

這一段記兩個被自己的工具抓出來的 bug。結論先寫:**那台主機量得到聲音**,
中間「量不到」的兩次都是我們自己的程式錯了。

### 第一輪:自我檢查說鏈路不通

```json
{"ok":true,"peak":0,"avg":0,"samples":25,"state":1,
 "device":"{0.0.0.00000000}.{404f29f2-217f-4974-93f8-c0b36689cb08}"}
{"chainOk":false,"peak":0,"quiet":0,"why":"test-tone-not-heard"}
```

端點是真的(`state=1` ACTIVE、id 真實、樣本都讀到),但主機自己播的測試音量表不動。
當時的結論是「我們量錯了地方」—— **這個結論是錯的**。

### 第二輪:診斷同時量所有候選,預設端點其實會動

```
輸出端點 2 個
  state=1 meter=true idle=0 during=0.36621  ← 會動  (預設端點)
  state=1 meter=true idle=0 during=0
播測試音時的 session
  pid=8024 name=powershell state=1 meter=true peak=0.36621  ← 會動
```

`0.36621` 與本機的 `0.36618` 幾乎相同。所以同一台機器、同一個端點,診斷量得到而自我檢查
量不到 —— 差別只在**初始化的位置**:

- 自我檢查:`播放 → 取得量表(COM CoCreateInstance + Activate) → 量`
- 診斷:`取得所有量表 → 播放 → 量`

那段 COM 初始化在本機很快(所以本機通過),在 GameLift 主機上慢到足以吃掉整段 700ms
的測試音。**先準備好量表再播放**,問題就消失。

### 第三個 bug:COM 方法沒標 `[PreserveSig]`

修時序之後本機反而開始丟 `0x80070490`(ERROR_NOT_FOUND)。原因與音訊無關:
`[ComImport]` interface 的方法若不標 `[PreserveSig]`,COM interop 會把宣告的 `int`
回傳值當成額外的 `[out, retval]` 參數,並且自己把真正的 HRESULT 轉成例外。
於是 `if (x.Method(...) == 0)` 檢查到的是一個**未初始化的值** ——
表現成「有時候好、有時候丟例外」,而不是乾淨地失敗。

全部標上 `[PreserveSig]` 之後本機穩定:

```json
{"during":{"ok":true,"peak":0.36618,"samples":40,"device":"{3.0.0.00000002}.{6C26...}"},
 "after": {"ok":true,"peak":0.00000,"samples":20,"device":"{3.0.0.00000002}.{6C26...}"}}
```

### 這一輪學到的

自我檢查的價值不只是「擋掉不可信的量測」—— 它和診斷**互相校驗**。
兩個工具在同一台機器上給出不同答案,那個矛盾本身就是線索,
而且比任何單一量測都更有用。如果當時只有自我檢查,結論會停在「GameLift 主機測不了音效」,
那是錯的。

### 還沒驗證

**修好之後在 GameLift 主機上的結果。** 上面的 `0.36621` 是診斷量到的,
而修好的自我檢查還沒在那台機器上跑過。等它通過,`devlogs/audio` 才會真的開始產出快照、
模型才會收到聲音的敘述。

`chainOk=false` 不會讓任務失敗:聲音判斷停用,測試照跑,報告裡就是沒有音效這一項。

## 還沒做的

- **波形 / 時間軸**:目前每步一個峰值,不是連續的 RMS 曲線。Android 的 `audio/levels.json`
  有波形是因為它有一整段錄影可以分析;Windows 要有等價的東西需要真的擷取 PCM
  (`IAudioClient` + `AUDCLNT_STREAMFLAGS_LOOPBACK`),那是另一個量級的工作。
- **影片帶音軌**:即時影片仍然無聲。前端有四處預設靜音(`LivePlayer.tsx` 的 prop 預設、
  `source === 'live'` 的強制靜音、`<video>` 的靜態屬性、`LiveScreen` 的傳值),
  要讓 Windows 的影片有聲音得先能擷取 PCM,然後這四處都要一起改。
