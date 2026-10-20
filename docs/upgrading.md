# 升級 PlayAgent Checker

## 先看這段：為什麼會「升級失敗」

實測某環境最近 20 次更新，5 次失敗 —— **每一次**都在另一次成功的 7~8 秒內啟動，錯誤都是同一句：

```
Cannot delete ChangeSet in status CREATE_IN_PROGRESS
```

兩個更新同時跑，搶同一個 CloudFormation changeset，第二個死掉。

所以多數「升級失敗」其實是：**升級已經成功了，但你收到失敗通知**。兩個更新一起跑，一個成功一個失敗，你看到的是失敗那個。

2026-10 的修正把這件事擋掉了（並行上限由 AWS 強制）。但有一個前提：

> **「更新器」自己不會被一鍵更新**，所以這個修正要先手動部署一次。

---

## 一次性步驟：升級更新器

在專案根目錄執行：

```bash
git pull
npm run upgrade:updater
```

這個腳本會自動偵測區域與環境，不需要你填任何參數。它會：

1. 掃描區域找出 `<前綴>-Updater` stack
2. 確認 stack 處於可更新的狀態
3. 確認目前沒有更新正在執行
4. 只部署 Updater 這一個 stack（`--exclusively`，不連帶動其他 stack）
5. **驗證結果**：並行上限是不是 1、buildspec 有沒有帶上部署前檢查與自我更新

第 5 步是刻意的 —— 部署成功但內容沒變的情況必須被抓出來，否則你會以為修好了。

想先看會做什麼而不實際變更：

```bash
npm run upgrade:updater -- --plan-only
```

同一個區域有多個環境（例如 dev 和 prod）時，腳本會要求你指定，不會自己猜：

```bash
npm run upgrade:updater -- --stage prod
```

**跑過這一次之後就不用再跑了。** 之後每次一鍵更新都會順便更新更新器自己。

---

## 之後的日常升級

系統管理頁 →「一鍵更新」。沒有別的步驟。

---

## 遇到問題時

### 「已有更新正在執行」

正常的防護，不是錯誤。等前一個更新結束再按。

如果確定沒有更新在跑卻一直這樣，去 CodeBuild 看 `<前綴>-self-update` 專案有沒有卡住的 build。

### 「部署前檢查未通過」

更新在**還沒做任何變更**之前就停下來了，log 會指出是哪個 stack、以及該做什麼：

| 狀態 | 意思 | 怎麼辦 |
|---|---|---|
| `*_IN_PROGRESS` | 有另一個部署在跑，或上一次還沒結束 | 等它結束 |
| `ROLLBACK_COMPLETE` | 這個 stack 第一次建立就失敗，CloudFormation 不允許更新 | 刪掉它，再執行完整安裝 |
| `UPDATE_ROLLBACK_FAILED` | 上一次更新回滾失敗 | 在 CloudFormation 主控台對它執行 **Continue rollback**，完成後再更新 |

這個檢查就是為了避免「一次失敗 → 之後永遠失敗」。少了它，`cdk` 會在部署中段丟一個很難解讀的錯誤。

### 「requires bootstrap stack version X」或 bootstrap 找不到

CDK bootstrap 太舊或沒做過。在同一個帳號與區域執行：

```bash
npx -y aws-cdk@2 bootstrap aws://<帳號>/<區域>
```

更新 log 現在會先印出目前的 bootstrap 版本，所以這個問題看 log 就知道。

### 本機跑 `cdk deploy` 出現「SSM parameter /cdk-bootstrap/... not found」

**幾乎都是區域不對**，不是 bootstrap 真的缺。`aws` CLI 的 `--region` 和 CDK 讀的 `CDK_DEFAULT_REGION` 是兩套。

`npm run upgrade:updater` 會自己處理區域，所以建議用腳本而不是手打 `cdk deploy`。真要手打：

```bash
# Windows PowerShell
$env:AWS_REGION='us-west-2'; $env:CDK_DEFAULT_REGION='us-west-2'
cd infra; npx cdk deploy PlayAgentDev-Updater --exclusively --require-approval never
```

```bash
# macOS / Linux
export AWS_REGION=us-west-2 CDK_DEFAULT_REGION=us-west-2
cd infra && npx cdk deploy PlayAgentDev-Updater --exclusively --require-approval never
```

### 更新顯示失敗，但其實已經更新了

修正之前的典型症狀。確認實際版本：

```bash
aws ssm get-parameter --name /playagent/<前綴>/deployed-version \
  --region <區域> --query Parameter.Value --output text
```

裡面的 `sha` 就是目前真正跑著的版本。

---

## 乾淨安裝

全新環境不需要上面的步驟 —— 完整安裝本來就會建立更新器：

```bash
node scripts/deploy-latest.mjs
```

---

## 這些修正做了什麼（給要 review 的人）

| 修正 | 位置 | 擋掉什麼 |
|---|---|---|
| `concurrentBuildLimit: 1` | `infra/lib/updater-stack.ts` | 兩個更新互撞（AWS 層強制，繞過 API 也擋得住） |
| 啟動前再檢查一次 | `infra/lambda/api/systemUpdate.ts` | 把競態窗口從數秒縮到毫秒級 |
| 並行錯誤翻譯 | 同上 | `AccountLimitExceededException` 看起來像帳號額度爆了，其實只是有更新在跑 |
| 部署前檢查 | `updater-stack.ts` 的 buildspec | 卡住的 stack 讓之後每次升級都失敗 |
| 更新器自我更新 | 同上 | 更新器的修正送不到已安裝環境 |
| `DescribeStacks` 權限放寬 | `updater-stack.ts` | 權限不足時檢查會靜默放行，等於沒檢查 |
