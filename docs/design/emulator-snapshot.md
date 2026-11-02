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

### 更新(2026-11-01):真正最大的一塊是遊戲自己的資源下載

上面那張表只量到「APK 裝好」。實際跑一次任務之後才看到被漏掉的那一段:
**這個遊戲首次啟動要再下載 1,364,076,377 bytes(1.36 GB)的資源**,實測速率約
1.2 MB/s,也就是 **約 20 分鐘**,而且結束後還接著一個 70 MB 的第二批。

(證據:任務 `job-mvxtpxj7-5ny1ji` 的 screenshots —— 第 15 步畫面上是
「下載中 1,193,524,636 / 1,364,076,377 Bytes 87%」,第 21 步 94%,第 24 步跳出
第二個「檔案下載,預計下載容量 70.09 MB」對話框。)

這段的代價是雙重的:

- **20 分鐘的 EC2 時間**,每一次乾淨安裝都要付。
- **整個步數預算**。AI 每 11 秒看一次畫面,也就是每 11 秒一次 VLM 呼叫,全部用在
  盯一條進度條。實測 `maxSteps=25` 的任務 25 步全部花在這裡,連大廳都沒進到。

所以快照的價值比原本寫的更大:它同時省掉 1.36 GB 下載、20 分鐘機器時間,和上百次
看進度條的 VLM 呼叫。**但也因此多了一個前提:快照必須是「資源下載完成之後」的狀態。**
在下載完成前建立的快照幾乎沒有價值 —— 還原後遊戲照樣要重新下載。
(2026-10-30 那份實驗快照就是這種:只裝了 APK、啟動一下就打包,所以用它跑任務和
乾淨安裝一樣慢。這不是 bug,是當時實驗沒跑到那麼後面。)

附帶一個同樣重要的好處:**起點一致性**。現在每次測試都從乾淨安裝開始,AI 每次走到
登入後的路徑不完全相同,所以「測同一個功能」的起點其實是浮動的。快照給出可重現的起點,
這讓它從「優化」變成「能力」。

## 前提驗證:`/data` 可以外掛、打包、從 S3 還原

Redroid 的 `/data` 用 `-v <hostdir>:/data` 外掛後:

```
data_files_after_boot=49        外掛確實生效
data_mb_after_boot=30           Redroid 自己初始化的 /data
pkg_installed=[com.InterServ.G9_aos]
pkg_after_restore=[com.InterServ.G9_aos]   從 S3 還原後 App 還在
```

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
    shared_prefs/com.InterServ.G9_aos.v2.playerprefs.xml      Unity PlayerPrefs
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

### 坑六:被測 App 是啟動器,快照裡會有兩個第三方包

這個 App 不是遊戲本身,是個啟動器:使用者上傳的 `com.InterServ.G9_aos` 首次啟動會
下載 1.36 GB,並**另外安裝一個** `com.igs.fafafa`(真正的遊戲)。所以「下載完成後」的
快照裡有兩個第三方包。

原本的包名選法是 `pm list packages -3 | head -1` —— 挑到哪一個是任意的。
實測同一份快照,兩次任務分別啟動了不同的 App(一次 `com.InterServ.G9_aos`、
一次 `com.igs.fafafa`),而報告上完全看不出來。這正好破壞快照的另一個目的
(可重現的起點)。

現在的規則:**job.json 的 `package` 若真的裝在機器上就用它**,否則才退回探測,
而且不論哪一條路都把候選清單印出來。要測的是使用者上傳的那個產物,不是它裝出來的東西。

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
| 送出時帶 `snapshot.use` → job.json → run.sh | `job-mvx8ea4h-9z6h7c` | `use=1 save=1 restored=1`,並「沿用已安裝的 `com.InterServ.G9_aos`,跳過 APK 安裝」 |
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

沒有啟動器、沒有資源下載、沒有登入流程 —— 從開機到這個畫面只用了 2 步。
相對地,乾淨安裝的同一個 case 要 7 步才到,而 `maxSteps=25` 的那次連大廳都沒進到
(25 步全部花在資源下載的進度條上)。

這同時回答了原本的兩個疑慮:**`shared_prefs` / `databases` 裡的 token 還原後 App 真的
接受**(帳號與餘額都在),而且**不需要測試帳號也驗得出來** —— 快照本身就帶著那個 session。
至於「裝置指紋綁定」的擔心,在 Redroid 上沒有發生。

## 未決 / 還沒驗的

- ~~**還原後 App 能不能真的「已登入」**~~ 已驗證,見上面「登入狀態」。
- **「下載完成後才建快照」目前只靠 `pass` 間接保證。** `pass` 代表 AI 走到了測試目標,
  通常意味著資源下載早就結束;但如果某個 case 的目標在下載完成前就達成(例如只驗
  「App 能啟動」),建出來的快照就會是下載未完成的狀態,而且看不出差別。
  可考慮的做法:打包前檢查 `/data/media/0/Android/data/<pkg>/` 的大小下限,
  或讓主機在 shell 層等下載完成(不燒 VLM 呼叫)再交給 AI。
- **AI 盯進度條很浪費。** 這不是快照的問題,但沒有快照時每次都會發生:
  `explorationRunner` 在載入畫面每 11 秒一次 VLM 呼叫,而 1.36 GB 下載要 20 分鐘。
  `loadingStreak` 到 20 步會重啟 App(下載會續傳,所以沒壞事),但步數預算就這樣沒了。
  值得做的是在載入/下載畫面拉長輪詢間隔,或直接在 shell 層等。
