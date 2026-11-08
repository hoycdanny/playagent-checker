# Windows 主機 PoC:當次驗證的紀錄,不是可重用工具

這個目錄保存 2026-10-06 那次 Windows 遊戲主機 PoC 的腳本原貌。它的用途是**佐證**,
不是給人拿去跑的工具 —— 結論與量測結果寫在
[`docs/design/multi-platform-workers.md`](../../../docs/design/multi-platform-workers.md),
這些腳本是那份結論的依據。

## 為什麼直接跑不會動

腳本寫死了當次環境,換一台機器就不成立:

- 遊戲安裝路徑(`C:\Games\<遊戲名>\`)、執行檔名與處理程序名
- 當次受測遊戲的伺服器主機與版本查詢端點
- 特定 EC2 執行個體類型、GPU 驅動版本與顯示器組態
- 寫死的視窗大小與解析度實驗值

要在別的環境重做,請把它當**參考**:看它驗了哪些項目、怎麼驗,然後針對自己的遊戲與
主機重寫。照原樣執行只會得到一堆「找不到檔案」。

## 平台正式的實作在哪裡

PoC 驗過的東西，正式實作在 `worker/` 底下(`WindowsWorker` 的流程與檢查)。
碰 OS 的那一層(`WindowsHostAgent`)尚未完成,呼叫時會丟 `PlatformNotReadyError`,
不會假裝成功 —— 這一點也記在上面那份設計文件裡。

## 檔案大致分類

| 檔案 | 當次用途 |
|---|---|
| `setup.ps1`、`userdata.ps1`、`ssm*.ps1`/`ssm*.json`、`trust.json`、`iam-policy.json` | 架起 EC2 執行個體與 SSM 通道 |
| `run.ps1`、`interactive.ps1`、`PocHelper.cs` | 在互動式桌面(console session)啟動遊戲與送輸入 |
| `diag*.ps1` | 逐項診斷:處理程序、GPU/顯示、設定檔、網路連線 |
| `fix-display.ps1`、`window-size-test.ps1`、`rotate-test.ps1` | 顯示器與解析度/旋轉的實驗 |

> 註:為了不把第三方的發行商識別碼寫進公開版控,`diag3.ps1` 的設定檔比對改用通用副檔名,
> 檔名搜尋條件也少了一個廠商專屬的關鍵字。對一份歷史紀錄沒有影響,但與當時執行的版本
> 有這一點差異。
