# Android 容器的 per-app 快照

狀態:**前提已用真實機器驗證通過,尚未實作。** 本文記下量測數據、三個踩過的坑,以及
一個被量測推翻的動機 —— 目的是讓實作的人不要為了錯的理由做這件事。

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
- **何時建立**:測試結束時自動建?或使用者在 App 頁按「建立快照」?
  自動建的風險是把「壞掉的狀態」(卡在錯誤畫面、被登出)存成起點。
  傾向由使用者明確觸發,或只在任務 pass 時建。

## 未決 / 還沒驗的

- **還原後 App 能不能真的「已登入」**:已證明 token 檔案存活,但沒有實際走過
  「登入 → 快照 → 還原 → 確認仍登入」的完整迴圈(需要一組測試帳號與一次 AI 登入)。
  檔案在不代表 App 一定接受(有些 App 綁裝置指紋,而 Redroid 的裝置 id 可能每次不同)。
- **跨機器**:實驗是在同一台機器上「打包 → 刪掉 → 從 S3 還原」。從 S3 還原等價於
  跨機器,但沒有真的在第二台機器上跑過。
- **`m7g.xlarge` 在 us-west-2a 容量不足**(實驗時遇到,改用 2b 才起得來)。
  正式的 emulator 只綁單一 subnet,機型回落 `m7g→m6g→m7gd` 全在同一個 AZ,
  遇到這種情況會整串失敗。這是獨立於快照的可用性缺口。
