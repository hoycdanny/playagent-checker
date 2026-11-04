# Android 容器的 per-app 快照

狀態:**已實作並在真實任務上驗證**(還原、跳過安裝、只在 `pass` 時打包三條路徑都走過)。
本文記下量測數據、踩過的坑,以及兩個被量測修正過的動機 —— 目的是讓之後維護的人不要
為了錯的理由做這件事,也不要重踩同樣的坑。

## 動機要先講對

直覺上的理由是「APK 很大,不要每次重裝」。**量測顯示這個理由不成立。**

一台 `m7g.xlarge` 從開機到 AI 開始跑的實測分解(428 MB 的 split APK):

| 階段 | 耗時 |
| --- | --- |
| apt 裝套件 | **80s** |
| binder 設定 | 5s |
| `docker pull` Redroid | 16s |
| Redroid 開機 | 27s |
| 下載 231 MB APK | **5s** |
| `install-multiple`(4 個分片) | **5s** |
| 合計到可測 | **138s** |

APK 下載加安裝只佔 10 秒(7%)。同區域 S3 到 EC2 有 46 MB/s,而 `install-multiple`
本身也只要 5 秒。相對地,**快照還原要 22 秒**(下載 93 MB + 解開 265 MB + 開機),
比重新安裝更慢。

**所以 per-app 快照若是為了省安裝時間,是負收益。**

真正的理由是另一個:**省掉 AI 每次重新走「啟動器 → 更新 → 登入 → 新手教學」的步數。**
那是幾十次 VLM 呼叫,遠大於 10 秒的 EC2 時間。安裝從來不是成本所在。

### 更新(2026-11-04):1.36 GB 的下載是「啟動器型」App,不是這個產物

2026-11-01 我在這裡寫過「這個遊戲首次啟動要再下載 1.36 GB」,**那個歸因是錯的**,
已更正如下 —— 連續兩次被同一份過期快照誤導,就是坑六講的那件事。

量到的事實沒有錯:任務 `job-mvxtpxj7-5ny1ji` 畫面上確實是
「下載中 1,193,524,636 / 1,364,076,377 Bytes」,約 1.2 MB/s、將近 20 分鐘,
結束後還接一個 70 MB 的第二批,而且 `maxSteps=25` 的 25 步全花在那條進度條上,
連大廳都沒進到。錯的是「這個遊戲」是誰:

| 任務 | 實際啟動的包 | 結果 |
| --- | --- | --- |
| `job-mvxtpxj7-5ny1ji` | `com.example.gameB`(**G9 啟動器**,來自那份過期快照) | 下載 1.36 GB,25 步沒進到大廳 |
| `job-mw1yd67y-qkmgoo` | `com.example.gameA`(產物 `art-mva92xdd-s6il77` 真正安裝的) | 乾淨安裝,**9 步進到大廳**,沒有大檔下載 |

所以:**被測產物自己不需要那 1.36 GB**;會下載的是 G9 啟動器,而它只是被誤放在
那個 key 上的實驗快照。「啟動器 → 下載一大包 → 更新 → 登入」這條路在這個市場很常見
(所以值得支援),但它不是這個 App 現在的狀況。

快照對這個產物的價值因此要用實測的步數講,不要用那 20 分鐘:

| 起點 | 到 pass 的步數(case「進入遊戲大廳」) |
| --- | --- |
| 乾淨安裝 | 7 ~ 9 步 |
| 快照(857 MB) | **2 步** |

省下的是「啟動 → 開場動畫 → 關彈窗 → 進大廳」那幾步,以及**起點一致性**——
快照那條路第 1 步就是已登入的大廳,不必每次重走。

另外一個仍然成立的前提:**快照必須是「該 App 的資源都就位之後」的狀態。**
對啟動器型的 App,在下載完成前建的快照幾乎沒有價值 —— 還原後照樣要重新下載。

附帶一個同樣重要的好處:**起點一致性**。現在每次測試都從乾淨安裝開始,AI 每次走到
登入後的路徑不完全相同,所以「測同一個功能」的起點其實是浮動的。快照給出可重現的起點,
這讓它從「優化」變成「能力」。

## 前提驗證:`/data` 可以外掛、打包、從 S3 還原

Redroid 的 `/data` 用 `-v <hostdir>:/data` 外掛後:

```
data_files_after_boot=49        外掛確實生效
data_mb_after_boot=30           Redroid 自己初始化的 /data
pkg_installed=[com.example.gameB]
pkg_after_restore=[com.example.gameB]   從 S3 還原後 App 還在
```

> 注意這裡的包名是 `com.example.gameB`。那是這次實驗自己抓的 APK,**不是**
> App `app-mva95wxf-camd57` 目前的產物(`art-mva92xdd-s6il77` 裝的是 `com.example.gameA`)。
> 當時沒注意到這件事,而實驗產出的快照又被放到以那個 artifactVersion 命名的 key 上,
> 後來就踩出坑六。

壓縮比約 2.8 倍(265 MB → 93 MB;App 啟動後 351 MB → 149 MB)。
打包 2 秒、上傳 3 秒、下載 2 秒、解開 2 秒 —— 都不是瓶頸。

### 關鍵證據:私有資料完整保留

這是整個方案成立與否的關鍵,而且**不能用 adb 驗證**(見下面的坑三)。
直接讀 host 端產生的歸檔:

```
/data/data/<pkg>/        files=22  mb=0.7
    10  shared_prefs
     7  files
     4  databases
     1  cache
  其中:
    shared_prefs/com.facebook.sdk.USER_SETTINGS.xml           Facebook SDK(第三方登入)
    shared_prefs/com.facebook.internal.preferences.APP_SETTINGS.xml
    shared_prefs/com.example.gameB.v2.playerprefs.xml      Unity PlayerPrefs
    files/PersistedInstallation...json                        Firebase 裝置身分
    databases/com.google.android.datatransport.events

/sdcard/Android/data/<pkg>/   files=106  mb=78.7   (Unity 資源快取)
```

登入狀態會落在 `shared_prefs` 與 `databases`,兩者都在快照裡。
**私有資料只有 0.7 MB**,大的是外部儲存的 Unity 快取(78.7 MB)。

## 三個踩過的坑

### 坑一:實驗腳本漏抄 binder 設定

第一次實驗容器 `Exited (255)`、`/data` 外掛目錄空的,看起來像「外掛 `/data` 會讓
Redroid 起不來」。實際原因是實驗腳本沒有照抄正式 userdata 的 binder 核心模組設定:

```bash
modprobe binder_linux devices="binder,hwbinder,vndbinder"
mount -t binder binder /dev/binderfs
```

白燒 40 分鐘的機器。**自己寫實驗腳本驗證既有流程時,關鍵步驟要照抄而不是重寫。**
(後來的實驗加了一個分支:boot 失敗時重試一次「不掛 `/data`」,用來區分
「外掛造成的」與「本來就起不來」。這種對照分支應該一開始就有。)

### 坑二:`awscli` 在這個 AMI 上裝不上,而結果上傳依賴它

`apt-get install -y awscli` 在 Ubuntu noble 失敗,正式 userdata 有
`|| snap install aws-cli --classic` 的退路,我的實驗腳本漏了。
結果是**所有結果寫入都靜默失敗**,實驗跑完卻什麼都看不到。

而且第一版把 stdout 整個重導向到檔案(`exec > >(tee ...)`),所以連
EC2 console output 也看不到。最後是靠 SSM(AMI 內建 `amazon-ssm-agent`)
連上去讀 `/var/log` 才知道發生什麼事。

**教訓**:診斷輸出不要只有一條路徑。後來改成先寫 `/tmp/r.txt`(SSM 可讀),
S3 上傳只是 best-effort。

### 坑三:用 adb 驗證私有資料,會得到錯的否定結論

Redroid 的 adb shell 是 `uid=2000(shell)`,不是 root:

```
adb_id=[uid=2000(shell) gid=2000(shell) groups=...,1015(sdcard_rw),...]
marker_written_prefs=[cat: /data/data/<pkg>/shared_prefs/exp.xml: Permission denied]
```

所以透過 adb 寫/讀 `/data/data/<pkg>/` 都失敗,實驗因此回報
`PARTIAL-sdcard-only-private-data-lost`。**那個結論是錯的** —— 資料在,只是看不到。

正確的驗證方式是讀 host 端的歸檔:`/data` 既然外掛到 host,host 的 root 就能完整
讀寫 Android 的私有資料,而 `tar` 也是在 host 以 root 執行的。

**這點對實作本身也有用**:快照的建立與「注入設定」都該在 host 端做,不要繞 adb。

## 實作(主機端)

主體腳本在 `infra/lambda/engine/emulator/run.sh`(從 userdata 搬出來的,見下節)。

**快照 key** 帶滿所有會讓它失效的維度:

```
tenants/<t>/apps/<appId>/snap-<artifactVersion>-<av>-<arch>-<w>x<h>.tar.zst
```

`/data` 與 OS 版本、架構綁死,換了就不能重用;APK 換版本後舊資料可能不相容。
任一維度不符就當成「沒有快照」,乾淨重裝 —— 不要試著沿用。

**`use` 預設關、`save` 預設開。** 這個不對稱是刻意的:

- 建立快照沒有副作用(只是多存一份,而且只在 `pass` 時建),所以預設開著讓資產累積。
- 使用快照會**改變測試的起點**。跳過安裝與登入就測不到那段流程,而那可能正是某個
  case 的目的。所以要在 job.json 明確寫 `snapshot.use: true` 才會用。

**只在 `pass` 時建立。** 快照會成為之後每次測試的起點,而把一個壞掉的狀態
(卡在錯誤畫面、被登出、更新失敗)存成起點,會讓後續每一次測試都從那裡開始,
而且很難看出原因。`pass` 至少代表那一刻的狀態是能用的。

### 實作時擋掉的四個坑

1. **`/data` 要外掛**(`-v /mnt/redroid-data:/data`)。原本沒有,資料隨容器消失,
   也沒辦法打包。順帶一個對實作很有用的性質:外掛之後主機的 root 能直接讀寫 Android
   的私有資料,不必繞 adb(Redroid 的 adb shell 是 `uid=2000`,讀不到 `/data/data/<pkg>`)。
2. **「關閉沉浸模式提示」與「啟動遊戲」原本在 `if [ -n "$APK_KEY" ]` 區塊內。**
   快照路徑會把 `APK_KEY` 清空(跳過安裝),於是整段被跳過 —— 症狀是遊戲沒被啟動、
   AI 從 Android 桌面開始測,而看起來像「遊戲啟動失敗」。已移出區塊。
3. **還原失敗要退回乾淨安裝。** 半還原的 `/data` 會讓 Redroid 用一個壞掉的系統狀態開機,
   症狀會是「開機逾時」之類跟真正原因無關的錯誤。
4. **還原後找不到第三方 App = 壞快照**,刪掉它並改為乾淨安裝,免得下次再踩。
   這一步需要 `s3:DeleteObject`,而主機角色原本只有 `GetObject/PutObject/ListBucket`。
   權限範圍收在 `tenants/*/apps/*/snap-*`:App 自己的 metadata 是 `apps/<appId>.json`
   (路徑少一層)比對不到,被測 App 若能影響主機也刪不到別的測試資料。

### 坑六:快照 key 帶 artifactVersion,但沒有任何東西綁住「內容」

這是目前找到最嚴重的一個,因為它不會失敗 —— 它會給出看似正常的假資料。

事情是這樣發現的:還原同一個 key 的快照,兩次任務回報的包名不一樣,一次
`com.example.gameB`、一次 `com.example.gameA`。查下去才知道**不是挑錯**,而是
那個 key 底下的檔案被換過:

- `art-mva92xdd-s6il77` 這個產物(使用者上傳的 split APK)實際安裝的是
  `com.example.gameA`(`XPKG=com.example.gameA`,`am start -n com.example.gameA/.SlotsActivity`)。
- 但 10-30 那份手動放進去的實驗快照裝的是 `com.example.gameB` —— 另一個 APK。
  它被放在 `snap-art-mva92xdd-s6il77-…` 這個 key 上,所以主機照樣還原、跳過安裝、
  啟動了那個完全不相干的 App,而報告寫的是 `art-mva92xdd-s6il77`。

**整份報告在測一個不是被測對象的東西,而從結果完全看不出來。** 快照 key 裡的
`artifactVersion` 只是檔名;快照路徑不下載 APK,所以沒有機會用 APK 去核對。

(順帶推翻一個我自己寫過的猜測:**不是**「`com.example.gameA` 的啟動器另外裝一個遊戲」。
那個猜測是從「兩次任務包名不同」倒推來的,方向錯了 —— 真正的變因是快照檔案被換過,
兩次任務各自跑的是兩個不相干的 App,各自只有一個第三方包。
而那 1.36 GB 是 `com.example.gameB` 這個啟動器在下載,跟被測產物無關;
詳見最前面「更新(2026-11-04)」。)

**修法**:打包時把包名寫進歸檔(`/data/.playagent-package`),還原後跟實際裝的比對,
不符就當壞快照刪掉並改乾淨安裝。標記寫在歸檔裡而不是另一個 S3 物件,所以不會有
「快照在、標記不見」的錯配。舊快照沒有標記 → 放行但在 log 明講,不為了這個把既有
資產全部作廢。

包名本身的選法也一併講清楚:`job.json` 的 `package` 若真的裝在機器上就用它,否則探測。
多數 App 的 `job.json` 沒有 `package`(App 設定的「識別碼」是選填),所以實際上
幾乎都走探測 —— 這也是為什麼候選清單一定要印出來。

### 坑五:`aws s3 mv` 需要主機沒有的 `GetObjectTagging`

第一版的上傳是「先寫 `<key>.part` 再 `aws s3 mv` 搬正」,理由是「上傳中斷留下的半份
檔案會被下一次任務當成快照」。**那個理由本身是錯的**:S3 不會讓讀取者看到寫到一半的
物件 —— 大檔走 multipart,只有 `CompleteMultipartUpload` 成功時物件才出現,中斷的話
舊快照原封不動留著。所以搬正那一步從頭到尾只是多一次伺服器端複製。

而它實際上還是壞的。`aws s3 mv` 為了保留物件標籤會呼叫 `GetObjectTagging`:

```
move failed: ... An error occurred (AccessDenied) when calling the GetObjectTagging
operation: ... is not authorized to perform: s3:GetObjectTagging
```

接著清理用的 `aws s3 rm` 同樣沒有 `DeleteObject` 權限也失敗,於是一份 **857 MB 的
`.part` 永久留在桶裡**。症狀是「任務 pass 了,但 App 頁的快照沒有更新」,而唯一的
錯誤訊息講的是 tagging —— 跟快照毫無關係。

現在直接寫最終 key。`infra/test/device-options.test.ts` 釘住這件事(連「註解裡可以
提到 `aws s3 mv`、程式碼裡不行」都分開判)。

另外補了一條 bucket lifecycle:`abortIncompleteMultipartUploadAfter: 7 days`。
中斷的 multipart 分段**不會**出現在物件清單裡,卻照樣計費 —— 這桶最大的寫入就是
這種 800 MB 級的快照,沒有這條規則等於留一筆看不見的費用。

## 設計方向

- **快照內容**:先包整個外掛的 `/data`(149 MB 壓縮後),不要試著只挑私有資料。
  App 的安裝狀態需要 `/data/app/` 與 `/data/system/packages.xml`,挑漏一個就會變成
  「App 不見了」這種難查的失敗。還原只要 22 秒,不值得為此冒風險。
- **快照 key 必須含**:appId、artifact 版本(APK 換了就失效)、Android 版本、架構、
  解析度。`/data` 與 OS 版本綁,換版本不能重用。
- **位置**:`tenants/<t>/apps/<appId>/snap-<av>-<arch>-<w>x<h>.tar.zst`。
  App metadata 現在是 `tenants/<t>/apps/<appId>.json`,S3 沒有真資料夾,兩者可並存。
- **安全**:快照含測試帳號的登入 token(`shared_prefs`),要與 App 憑證同級對待
  —— 租戶隔離的前綴,不可跨租戶讀取。
- **要有開關**:快照不能取代「首次安裝 / 首次啟動流程」的測試,那本身是測試項目。
- ~~**何時建立**:自動建還是使用者按按鈕?~~ 已定:**只在任務 `pass` 時自動建**,
  理由見上面的「實作(主機端)」。使用者端只有「用不用」(送出任務時的核選方塊)
  與「刪不刪」(App 頁的快照清單),沒有「手動建立」—— 手動建立無法保證當下的狀態是
  能用的,正是要避免的事。

## 真實任務上的驗證紀錄

| 路徑 | 任務 | 結果 |
| --- | --- | --- |
| 送出時帶 `snapshot.use` → job.json → run.sh | `job-mvx8ea4h-9z6h7c` | `use=1 save=1 restored=1`,並「沿用已安裝的 `com.example.gameB`,跳過 APK 安裝」(包名不對 —— 這一次就是坑六,當時沒看出來) |
| 非 `pass` 時不建立 | 同上(`maxSteps=3` 必然 fail) | `snapshot: 不建立(save=1 state=fail …)` |
| `pass` 時打包 | `job-mvxuuvj2-6wpzql` | tar+zstd 產出 817 MiB、上傳成功,但搬正失敗(見坑五)→ 已修 |
| `pass` 時打包(修好後) | `job-mvy1w79z-xmfqd7` | `snapshot: 已建立(817 MB)`,物件由 157 MB 換成 857,061,954 bytes;打包到上傳完共 15 秒 |
| 還原 857 MB 的快照 | `job-mvy2wufz-ycoont` | 2 步 pass(乾淨安裝要 7 步);下面的登入狀態證據就出自這一次 |

跨機器也順帶驗到了:快照是 10-30 那台實驗機建的,還原是另外兩台任務主機做的。

### 登入狀態:已驗證(原本列為未決)

`job-mvy2wufz-ycoont` 還原快照後的第 1 步畫面,直接就是**已登入的遊戲大廳**:

```
帳號 りょう   餘額 5,379,522,350   SCORE 15   League 1st
畫面:機台選擇大廳(Hot Slots / JACKPOT 3,750,000,000)
提示:「Ready? Click to enter the game.」
```

沒有登入流程、沒有新手教學 —— 從開機到這個畫面只用了 2 步。
相對地,乾淨安裝的同一個 case 要 7 ~ 9 步才到。

這同時回答了原本的兩個疑慮:**`shared_prefs` / `databases` 裡的 token 還原後 App 真的
接受**(帳號與餘額都在),而且**不需要測試帳號也驗得出來** —— 快照本身就帶著那個 session。
至於「裝置指紋綁定」的擔心,在 Redroid 上沒有發生。

## 未決 / 還沒驗的

- ~~**還原後 App 能不能真的「已登入」**~~ 已驗證,見上面「登入狀態」。
- ~~**「下載完成後才建快照」目前只靠 `pass` 間接保證**~~ 已處理:打包前先等網路靜止,
  見下面「打包前等資源下載結束」。
- ~~**AI 盯進度條很浪費**~~ 已處理,見下節。

## 載入/下載畫面:不要用模型盯進度條

這一節處理的不是快照,而是「載入畫面本身很貴」這件事,兩者獨立。

起因是 `job-mvxtpxj7-5ny1ji`:G9 啟動器首次啟動要下載 1.36 GB(約 1.2 MB/s、
將近 20 分鐘),而 AI 每 11 秒看一次畫面、每次一次 VLM 呼叫,`maxSteps=25` 的
25 步全部花在同一條進度條上,連大廳都沒進到。

快照能免掉「已經下載過」的情況,但**第一次**總是要下載,而且任何遊戲的載入畫面
都有同樣的問題,只是規模小一點。

### 做法:確認在載入畫面之後,就地輪詢截圖,不花模型呼叫

截圖 + pHash 這條路不花錢(`agent/imageTools.mjs`,一張幾十毫秒)。所以在
`explorationRunner` 的每步收尾處插一段:畫面被判定為載入中時,就地每 5 秒抓一張圖比對,
只有畫面**真的**變了才回去交給模型。hold 回來的那張順便當下一步的預抓圖,不多花一次取圖。

**門檻是量出來的。** 拿 `job-mvxtpxj7-5ny1ji` 的實際畫面兩兩比 pHash(1024 bit):

| 比較 | 距離 |
| --- | --- |
| 同一個下載畫面、相鄰步(只有進度條與數字在動) | 10 ~ 48 bit |
| 同一個下載畫面、相隔 5 步以上 | 6 ~ 58 bit |
| 下載畫面 → 下載確認對話框 | 560 bit |
| 下載畫面 → 遊戲大廳 | 459 ~ 461 bit |

兩群之間差了五倍以上,所以 `PA_LOADING_DIFF_BITS=160` 放在中間,兩邊都有很大餘裕。
上線後的實測也落在同一個區間:`job-mw1yd67y-qkmgoo` 離開載入畫面時量到 **440 bit**,
於是 hold 在第 8 秒就break 出來交回模型(沒有多等)。
(對照:既有的 `screenChanged` 用 40 bit —— 那是問「上一步的點擊有沒有生效」,要很敏感;
這裡問的是「有沒有離開這個畫面」,要很鈍。同一個指標、兩個完全不同的門檻,不能混用。)

### 「還在下載」與「真的卡死」在畫面上分不出來

這是這件事唯一的難點。進度條可能好幾十秒才動一格,而卡死的載入畫面往往還有動畫 ——
純看畫素沒辦法分。而兩者的處置完全相反:前者要繼續等,後者要重啟 App。

分得出來的是**網路**:下載中裝置會持續收位元組。`agent/downloadProbe.mjs` 讀
`/proc/net/dev`(一個小檔,adb 與 Appium 的 `mobile: shell` 都讀得到)累計接收量,
兩次取樣算速率。它影響兩個決定:

- **hold 多久**:有下載證據 → 一次等 90 秒(20 分鐘的下載只花十幾次呼叫);
  沒有證據 → 只等 15 秒。沒有證據就不要把卡死的偵測拖慢 —— 重啟是靠 `loadingStreak`
  數步數觸發的,hold 越長就越晚到。
- **要不要重啟 App**:下載中一律不重啟。實測那次 1.36 GB 的下載在 streak 20/40/60
  連續觸發三次重啟,每次 8 秒加上 AI 重走一遍流程,純粹是浪費。

### 驗到哪裡了

| 項目 | 狀態 |
| --- | --- |
| hold 會啟動、畫面變了會 break 出來 | **已驗**:三次任務分別量到 439 / 440 / 457 bit,都在第 5~8 秒就回去交給模型 |
| 門檻 160 在真機上落在正確的那一側 | **已驗**:上面那三個讀數落在離線量到的「換畫面」區間(297~560),離 160 很遠 |
| 裝置端真的讀得到 `/proc/net/dev`,速率算得出來 | **已驗**(`job-mw1zngyk`:`下載 2.37 MB/s`)。順帶證明這個遊戲啟動時確實有在收資料,而 2.37 MB/s 遠高於 150 KB/s 的門檻,會被判定為「下載中」 |
| `parseRxBytes` / `rxRateBps` / 取樣器的所有分支 | **已驗**(`infra/test/download-probe.test.ts`,17 項) |
| 長 hold(90 秒)與「下載中連續 20 步不重啟」 | **還沒驗**:需要一個首次啟動會持續下載好幾分鐘的 App。那個 App(G9 啟動器)不是目前任何一個產物,現在沒有素材可重現 |

最後一項的範圍很窄:它依賴的 `downloading` 已經證明算得出來、而且在真機上會變成 true;
沒驗到的是「連續 20 個載入步」那條路。

還有一個實測發現的 bug 值得記著:速率取樣原本寫在 hold 迴圈「畫面變了就 return」的
**後面**,於是每次都提早離開的情況永遠累積不到第二個取樣點,`rxBps` 一直是 null。
後果不只是 log 難看 —— 沒有速率就沒有下載證據,整個「下載中要耐心等、不要重啟」的
設計在那條路上等於沒生效。第一次真機驗證印出來的全是 `下載 ?`,才看出來(`e635e69`)。

兩個實作細節,錯了很難查:

1. **一定要排除 `lo`。** runner 的截圖是走 adb 過來的,在容器裡就是迴圈介面的流量 ——
   每 5 秒一張 1.8 MB 的 PNG 等於 360 KB/s,足以超過「正在下載」的門檻。算進去的話
   訊號會完全反過來,而症狀是「卡死的任務永遠不會被重啟」。
2. **「量不到」不等於「沒在下載」。** 探測器問不到時回 `null`,呼叫端一律當成沒有證據
   (保守的那一邊:做短 hold、照原本的規則重啟)。iOS、Windows、web 沒有這個檔案,
   行為就退回成原本的樣子。一次 adb 逾時也不該讓「正在下載」瞬間翻成「卡死了」,
   所以 shell 失敗時沿用上一個值。

### 旋鈕與觀測

| 環境變數 | 預設 | 作用 |
| --- | --- | --- |
| `PA_LOADING_HOLD_MS` | 90000 | 有下載證據時一次等多久 |
| `PA_LOADING_HOLD_SHORT_MS` | 15000 | 沒有證據時一次等多久 |
| `PA_LOADING_POLL_MS` | 5000 | hold 期間多久抓一張圖 |
| `PA_LOADING_DIFF_BITS` | 160 | 判定「離開載入畫面」的 pHash 距離 |
| `PA_DOWNLOAD_RX_BPS` | 150000 | 判定「正在下載」的速率門檻(實測 1.2 MB/s 離它很遠) |

`PA_LOADING_HOLD_MS=0` 可以整個關掉,行為回到原本每步一次呼叫。

收尾的 `runner.log` 會印省下多少:

```
[loading] 在載入/下載畫面就地等了 1180s,省下約 229 次模型呼叫
```

hold 期間每 30 秒也會更新一次任務狀態(`遊戲正在下載資源(1.21 MB/s),已等 420 秒`)——
一條 20 分鐘的進度條如果畫面與訊息都不動,使用者只會以為任務死了。

## 打包前等資源下載結束

`save` 是在任務 `pass` 時觸發的,而「App 能啟動」「進得去大廳」這類 case 可能在遊戲的
資源還沒下載完就通過了。那樣打出來的快照還原後照樣要重新下載,**但它跟一份完整的快照
長得一模一樣** —— 大小、檔名、清單全都看不出差別。結果是之後每一次任務都用一份沒有價值
的快照,而且沒人知道為什麼還是那麼慢。

所以 `run.sh` 在打包前先等網路靜止(`snap_wait_quiet`):每 5 秒讀一次
`/proc/net/dev` 的累計接收量,連續兩次低於 150 KB/s 才開始打包,上限 10 分鐘。

幾個刻意的選擇:

- **連續兩次才算完。** 下載常有短暫空檔(換檔案、解壓),一次就收手會在半路把快照打下去。
- **一定要有上限**(`SNAP_WAIT_MAX`,預設 600 秒)。下載卡住的機器不該一直燒到 TTL。
  等滿了照樣打包,但 log 會明講「這份快照可能不完整」。
- **等待期間不可以寫 status。** `run.sh` 的 `writestatus` 是直接覆寫 S3,**沒有**終態吸收
  (那是 API 端 `writeStatus` 才有的)。在 `pass` 之後寫 `running`,任務就會永遠顯示
  「執行中」而且沒有報告。測試結果在 runner 結束時就定案了,快照只是副產物,
  等多久都不該影響它。`device-options.test.ts` 有一條測試專門釘這件事。
- **排除 `lo`。** 跟 runner 那邊同一個坑:adb 自己的流量走迴圈介面,算進去就永遠不會
  「靜止」,於是每次都等滿 10 分鐘上限。
- **只收純數字欄位。** 這個是實際踩到的:`cat: /proc/net/dev: No such file` 這行有冒號、
  冒號後第一欄是 `/proc/net/dev`,awk 把非數字當 0 —— 於是「讀不到」會變成「讀到 0 bytes」,
  接著速率算出垃圾,而且不會走「讀不到就直接打包」那條路。驗過的輸入:真實三介面格式 /
  數字緊貼冒號 / 只有 lo / `cat` 的兩種錯誤訊息 / 空輸入 / 全新介面 0 bytes。

這段 awk 跟 `agent/downloadProbe.mjs` 的 `parseRxBytes()` 是同一套規則(那邊有單元測試)。
一份邏輯兩個實作不理想,但 shell 這邊只需要加總一個數字,為此在打包路徑上多拉一個
node 程序並不划算 —— 兩邊的註解都互相指著對方,改一邊要記得改另一邊。

### 真機驗證(`job-mw25y41s-uq7178`)

```
snapshot: 任務 pass,開始建立快照 …
snapshot: 網路已靜止(0 KB/s),開始打包(等了 10s)
snapshot: 已建立(818 MB)
```

這幾行證明了四件事:

- `rx_bytes` 在 Redroid 上**讀得到**(讀不到會走另一條路印「讀不到 /proc/net/dev」)。
- 靜止判定有效(遊戲閒置後量到 0 KB/s)。
- 「連續兩次才算完」有效:等了 10 秒 = 2 × 5 秒,正好是最短可能值,沒有多等。
- 等待期間沒有蓋掉終態:整段 `pass` 都維持著,快照物件同時從 857,674,227 更新為
  858,000,205 bytes。

沒驗到的是「還在下載就繼續等」那條分支 —— 這次任務在啟動後跑了 8 步才打包,
那時遊戲早就閒置了。它跟靜止那條走的是同一個迴圈本體,量測路徑既然通了,
剩下的是比較大小;真要驗需要「剛啟動就 pass」的 case。
