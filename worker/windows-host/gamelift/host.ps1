# PlayAgent Windows 主機(Amazon GameLift Streams 的 Windows 執行環境)。
# 每個測試 = 一個沒有人連線的 stream session(NO_CLIENT_CONNECTION);engine 用環境變數帶入任務設定,
# AWS 憑證由 session 的 IAM 角色自動提供(RoleArn)。
# 流程:下載 runner + 遊戲 → 解開 / 安裝 → 跑 AI runner(本機直接呼叫 Bedrock)→ 上傳 log → 結束應用(= session 結束)。
# 環境變數:PA_JOB PA_TENANT PA_APP PA_BUCKET PA_PREFIX PA_DATA_REGION PA_ARTIFACT_KEY PA_PKG PA_VLM PA_AGENT_MODEL PA_SUBAGENT_MODEL PA_MAXSTEPS
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path $env:LOCALAPPDATA 'playagent'
$null = New-Item -ItemType Directory -Force -Path $work, "$work\runner", "$work\game", "$work\dl"
$log = Join-Path $work 'host.log'
# 資料區域:engine 一定會帶 PA_DATA_REGION。預設值從 us-east-2 改成 us-west-2 ——
# 平台在 us-west-2,舊的預設值只會在「忘記帶變數」時把人導向空無一物的區域。
$region = if ($env:PA_DATA_REGION) { $env:PA_DATA_REGION } else { 'us-west-2' }
Import-Module AWS.Tools.S3 -ErrorAction SilentlyContinue
Import-Module AWS.Tools.SecurityToken -ErrorAction SilentlyContinue
# GameLift 會把應用的 pa-logs/ 收走(ApplicationLogPaths);host.log 同步寫到那裡,連不上 S3 時仍有紀錄。
$glsLogDir = Join-Path $root 'pa-logs'
$null = New-Item -ItemType Directory -Force -Path $glsLogDir

<#
  主機 log 的雙軌輸出。
  
  整份 host.log 走 UploadLog(覆寫單一檔案),但那只在收尾時才呼叫 —— session 被 GameLift
  逾時直接砍掉時腳本一起死,整份 log 就沒了。實際發生過:安裝卡住一小時,最後 S3 上連
  host.log 都沒有,GameLift 收到的壓縮檔是空的,完全無從診斷。
  
  所以另外把每一行同時排進 devlogs/host/<序號>.txt 分段上傳,格式刻意與 logcat 相同
  (agent/browserLogs.mjs 也是這招),前端的 parseLogcat / LogcatView 直接重用,
  而且每個階段 flush 一次 —— 之後就算被砍掉,已經 flush 的部分都還在。
#>
$script:pending = New-Object System.Collections.Generic.List[string]
$script:chunkNo = 0
$inv = [Globalization.CultureInfo]::InvariantCulture
$epoch = [DateTime]'1970-01-01'
function Log($m, $level = 'I', $tag = 'host') {
  $now = (Get-Date).ToUniversalTime()
  "$($now.ToString('o')) $m" | Add-Content -Path $log -Encoding UTF8
  # logcat 行格式:<epoch秒.毫秒>  <pid>  <tid>  <等級>  <來源>: <訊息>
  # 來源不能有冒號(parseLogcat 以第一個冒號切 tag / msg);訊息壓成一行。
  $sec = (($now - $epoch).TotalSeconds).ToString('F3', $inv)
  $one = ($m -replace '[\r\n]+', ' | ')
  $script:pending.Add(("{0}  1  0  {1}  {2}: {3}" -f $sec, $level, ($tag -replace '[:\s]+', '-'), $one))
}
function FlushLog {
  if ($script:pending.Count -eq 0) { return }
  if (-not $env:PA_BUCKET -or -not $env:PA_PREFIX) { return }
  $script:chunkNo++
  $now = (Get-Date).ToUniversalTime()
  $ms = [long](($now - $epoch).TotalMilliseconds)
  $sec = (($now - $epoch).TotalSeconds).ToString('F3', $inv)
  # 標頭供前端 clockOffset 對時;主機與 runner 同一個時鐘,所以 dev 與 sent 一致、位移為 0。
  $head = "# step=0 at=$($now.ToString('o')) pid=1 dev=$sec sent=$ms"
  $body = $head + "`n" + ($script:pending -join "`n")
  $name = '{0:d6}.txt' -f $script:chunkNo
  try {
    Write-S3Object -BucketName $env:PA_BUCKET -Key "$($env:PA_PREFIX)/devlogs/host/$name" -Content $body -ContentType 'text/plain; charset=utf-8' -Region $region
    $script:pending.Clear()
  } catch {
    # 上傳失敗就留在 buffer 裡,下一次 flush 一起送(別把行丟掉)。
    $script:chunkNo--
  }
}
function UploadLog {
  FlushLog
  try { Copy-Item $log (Join-Path $glsLogDir 'host.log') -Force } catch { }
  try { Write-S3Object -BucketName $env:PA_BUCKET -Key "$($env:PA_PREFIX)/host.log" -File $log -Region $region } catch { }
}
function Status($state, $msg) {
  $body = @{ jobId = $env:PA_JOB; state = $state; message = $msg; steps = 0; updatedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
  try { Write-S3Object -BucketName $env:PA_BUCKET -Key "$($env:PA_PREFIX)/status.json" -Content $body -ContentType 'application/json' -Region $region } catch { Log "status write failed: $_" }
}
function Fail($msg) { Log "FAIL: $msg" 'E' 'host'; Status 'error' $msg; UploadLog; exit 1 }

<#
  跑安裝程式,但不要無限等。
  
  靜默安裝參數是「常見」而非保證:安裝程式可能需要提權、跳出對話框、或等一個永遠不會來的
  輸入。原本是 Start-Process -Wait,一卡就卡到 GameLift 在 60 分鐘後砍掉整個 session,
  而且因為腳本沒走到收尾,連 log 都沒留 —— 一小時的 GPU 換到零資訊。
  
  逾時就殺掉並明確記錄是「逾時」而不是「失敗」,這兩者的下一步完全不同。
#>
$installTimeoutSec = if ($env:PA_INSTALL_TIMEOUT_SEC) { [int]$env:PA_INSTALL_TIMEOUT_SEC } else { 600 }
function RunInstaller($exe, $argList, $label) {
  Log "嘗試安裝($label):$($argList -join ' ')" 'I' 'install'
  FlushLog
  $t0 = Get-Date
  $p = Start-Process -FilePath $exe -ArgumentList $argList -PassThru
  <#
    不要等安裝程式自己結束。
    
    實測(Gamania Games Manager 1.5.0.2):靜默安裝其實成功了,但安裝程式裝完之後
    「不會退出」—— 它顯示成功對話框並把自己留在前景。-Wait 就這樣等一個已經做完事的
    程序,等到 session 被 GameLift 逾時收掉。第一次踩到時白燒了一小時。
    
    所以改成等「結果」而不是等「程序」:每 3 秒看一次目標目錄有沒有出現 exe,
    出現且連續兩輪數量不再增加(還在寫檔就會繼續增加)就視為裝好,收掉安裝程式往下走。
    逾時仍然保留當最後防線。
  #>
  $stableRounds = 0
  $lastCount = 0
  $deadline = (Get-Date).AddSeconds($installTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ($p.WaitForExit(3000)) {
      $p.Refresh()
      $code = try { $p.ExitCode } catch { '?' }
      Log "安裝程式自行結束($label)exit=$code 耗時 $([int]((Get-Date) - $t0).TotalSeconds)s,裝出 $((GameExes).Count) 個 exe" 'I' 'install'
      FlushLog
      return $true
    }
    $n = (GameExes).Count
    if ($n -gt 0 -and $n -eq $lastCount) { $stableRounds++ } else { $stableRounds = 0 }
    $lastCount = $n
    if ($stableRounds -ge 2) {
      Log "安裝程式仍在執行但目標目錄已穩定($n 個 exe,耗時 $([int]((Get-Date) - $t0).TotalSeconds)s);視為安裝完成並收掉它" 'I' 'install'
      KillTree $p
      FlushLog
      return $true
    }
  }
  Log "安裝程式超過 $installTimeoutSec 秒沒有結束且沒有裝出東西($label),判定卡住並終止" 'E' 'install'
  KillTree $p
  FlushLog
  return $false
}
function KillTree($p) {
  # Kill(true) 連子程序一起殺,但那是 .NET 5+ 才有;PowerShell 5.1 走 .NET Framework 要退回 Kill()。
  try { $p.Kill($true) } catch { try { $p.Kill() } catch { Log "終止安裝程式失敗:$_" 'W' 'install' } }
}
function GameExes { @(Get-ChildItem "$work\game" -Recurse -Filter *.exe -ErrorAction SilentlyContinue) }

Log "start job=$env:PA_JOB user=$env:USERNAME session=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
try { Log "caller: $((Get-STSCallerIdentity -Region $region).Arn)" } catch { Fail "沒有 AWS 憑證(stream session 未帶 IAM 角色?):$_" }
if (-not $env:PA_BUCKET -or -not $env:PA_PREFIX -or -not $env:PA_JOB) { Fail 'engine 未帶入 PA_JOB / PA_BUCKET / PA_PREFIX' }
Status 'running' 'Windows GPU 主機已啟動,下載遊戲中'
FlushLog  # 第一段:主機起來了、憑證拿到了。越早送越好 —— 後面每一步都可能是最後一步。

# 1) runner 程式(agent/*.mjs + WinHelper.cs + winHost.ps1,與 Android / Device Farm 同一份)
try {
  $n = 0
  foreach ($o in Get-S3Object -BucketName $env:PA_BUCKET -KeyPrefix '_engine/runner/' -Region $region) {
    $name = Split-Path $o.Key -Leaf
    if ($name) { $null = Read-S3Object -BucketName $env:PA_BUCKET -Key $o.Key -File "$work\runner\$name" -Region $region; $n++ }
  }
  Log "runner 檔案數=$n"
  if ($n -lt 5) { Fail "runner 檔案不足($n);_engine/runner/ 是否已部署?" }
} catch { Fail "下載 runner 失敗:$_" }
FlushLog
# node_modules 隨 GameLift 應用一起發佈(避免每次 npm install)
if (-not (Test-Path "$work\runner\node_modules")) { Copy-Item -Recurse "$root\runner-deps\node_modules" "$work\runner\node_modules" }

# 2) 任務設定:caseTask 等欄位在 job.json(可能很長,不走環境變數)
$task = ''
try {
  $null = Read-S3Object -BucketName $env:PA_BUCKET -Key "$($env:PA_PREFIX)/job.json" -File "$work\job.json" -Region $region
  $job = Get-Content "$work\job.json" -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($job.caseTask) { $task = [string]$job.caseTask }
  if (-not $env:PA_PKG -and $job.package) { $env:PA_PKG = [string]$job.package }
} catch { Log "job.json 讀取失敗(用預設任務):$_" }

# 3) 遊戲:artifactKey 是資料夾(artifacts/<id>/),裡面是 game.exe(安裝檔)或 game.zip(免安裝)
$game = $null
try {
  $objs = @(Get-S3Object -BucketName $env:PA_BUCKET -KeyPrefix $env:PA_ARTIFACT_KEY -Region $region | Where-Object { $_.Key -match '\.(exe|zip)$' } | Sort-Object Size -Descending)
  if (-not $objs) { Fail "找不到遊戲檔(.exe / .zip):$env:PA_ARTIFACT_KEY" }
  $o = $objs[0]; $file = Join-Path "$work\dl" (Split-Path $o.Key -Leaf)
  $null = Read-S3Object -BucketName $env:PA_BUCKET -Key $o.Key -File $file -Region $region
  Log "downloaded $($o.Key) $([math]::Round($o.Size / 1MB)) MB"
  Status 'running' '遊戲下載完成,安裝中'
  FlushLog
  if ($file -match '\.zip$') {
    Expand-Archive -Path $file -DestinationPath "$work\game" -Force
    Log "zip 解開完成,找到 $((GameExes).Count) 個 exe" 'I' 'install'
  } else {
    # Inno Setup:innoextract 直接解開(不需安裝、不需重開機);不行就退回常見的靜默安裝參數。
    $t0 = Get-Date
    & "$root\innoextract.exe" --silent --extract --output-dir "$work\game" $file 2>&1 | Out-String | Set-Variable ieOut
    Log "innoextract 耗時 $([int]((Get-Date) - $t0).TotalSeconds)s,解出 $((GameExes).Count) 個 exe" 'I' 'install'
    if ((GameExes).Count -eq 0) {
      # 這段訊息要完整留著:innoextract 會明確講出它不支援的 Inno Setup 版本
      # (例如「Unexpected setup data version: 6.3.0」—— 1.9 只支援到 6.2)。
      Log "innoextract 失敗或不是 Inno Setup:$($ieOut -replace '\s+', ' ')" 'W' 'install'
      $timedOut = $false
      # Inno Setup 自己的靜默參數
      if (-not (RunInstaller $file @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/DIR=$work\game") 'Inno /VERYSILENT')) { $timedOut = $true }
      # NSIS 風格
      if (-not $timedOut -and (GameExes).Count -eq 0) {
        if (-not (RunInstaller $file @('/S', "/D=$work\game") 'NSIS /S')) { $timedOut = $true }
      }
      if ((GameExes).Count -eq 0) {
        # 區分「卡住被我們砍掉」與「跑完了但沒裝出東西」—— 下一步完全不同:
        # 前者要看是不是在等對話框/提權,後者是參數或安裝位置不對。
        if ($timedOut) {
          Fail "安裝程式卡住(超過 $installTimeoutSec 秒無反應,已終止)。這個安裝檔可能需要互動或提權;改上傳免安裝的 .zip 可直接跳過安裝。詳見主機 log。"
        }
        Fail '安裝程式已結束但沒有裝出任何執行檔(靜默參數可能不被支援)。改上傳免安裝的 .zip 可直接跳過安裝。詳見主機 log。'
      }
    }
  }
  # 遊戲執行檔:App 識別碼(相對路徑或檔名)優先,否則取最大的 exe(排除解除安裝 / 安裝 / crash 工具)
  $all = GameExes
  if ($env:PA_PKG) { $game = $all | Where-Object { $_.FullName -like "*\$($env:PA_PKG)" -or $_.Name -eq $env:PA_PKG } | Select-Object -First 1 }
  if (-not $game) { $game = $all | Where-Object { $_.Name -notmatch 'unins|setup|crash|redist|vc_|dxsetup|helper|launcher' } | Sort-Object Length -Descending | Select-Object -First 1 }
} catch { Fail "安裝遊戲失敗:$_" }
if (-not $game) { Fail '安裝後找不到遊戲執行檔' }
Log "game exe=$($game.FullName)"
UploadLog

# 4) AI runner(PA_DRIVER=windows:截圖 / 滑鼠鍵盤走 WinHelper.cs)
$env:PA_DRIVER = 'windows'
$env:PA_PLATFORM = 'windows'
$env:PA_PKG = $game.FullName
if ($task) { $env:PA_TASK = $task }
Add-Type -AssemblyName System.Windows.Forms
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$gpu = (Get-CimInstance Win32_VideoController | Select-Object -First 1).Name
$env:PA_DEVICE_MODEL = "Windows Server 2022 · $gpu · $($scr.Width)x$($scr.Height)"
Log "display $($scr.Width)x$($scr.Height) gpu=$gpu"
if (Test-Path "$root\im\magick.exe") { $env:PA_MAGICK = "$root\im\magick.exe" } else { Log 'ImageMagick 不在套件內:座標校正 / pHash 會停用' }
$node = Join-Path $root 'node\node.exe'
if (-not (Test-Path $node)) { Fail "套件缺少 node\node.exe" }
Status 'running' "遊戲已安裝($($game.Name)),AI 測試啟動中"
$rp = Start-Process -FilePath $node -ArgumentList "`"$work\runner\explorationRunner.mjs`"" -WorkingDirectory "$work\runner" -NoNewWindow -PassThru -RedirectStandardOutput "$work\runner.out.log" -RedirectStandardError "$work\runner.err.log"
Log "runner 已啟動 pid=$($rp.Id)" 'I' 'runner'
# 每 30 秒 flush 一次:runner 自己會即時寫步驟與截圖,但主機這一層的紀錄不能等到它結束 ——
# session 被逾時砍掉時,沒 flush 的部分就永遠看不到了。
while (-not $rp.WaitForExit(30000)) { FlushLog }
# Refresh() 之後才讀得到 ExitCode(Start-Process -PassThru 回來的物件不會自己更新,
# 直接讀會是空值 —— 之前 log 裡那個「exit=」就是這樣來的)。
$rp.Refresh()
$runnerExit = try { $rp.ExitCode } catch { '?' }
Log "runner 結束 exit=$runnerExit" 'I' 'runner'
# runner 的 stderr 尾段也送進主機 log:runner 自己炸掉時,錯誤訊息只在這個檔案裡,
# 而那正是使用者最需要看到的東西(否則畫面上只有一個沒有原因的失敗)。
try {
  # -Encoding UTF8 不能省:runner 的訊息是中文,用預設編碼讀會變成「è¼‰å…¥」這種亂碼,
  # 等於把唯一的錯誤線索讀壞。實際發生過。
  $errTail = @(Get-Content "$work\runner.err.log" -Tail 120 -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_ -and $_.Trim() })
  if ($errTail.Count -gt 0) {
    Log "runner stderr 尾段($($errTail.Count) 行):" 'E' 'runner'
    foreach ($line in $errTail) { Log $line 'E' 'runner' }
  }
} catch { Log "讀取 runner.err.log 失敗:$_" 'W' 'runner' }
FlushLog
foreach ($pair in @(@('runner.out.log', 'runner.log'), @('runner.err.log', 'runner.err.log'))) {
  try {
    Copy-Item "$work\$($pair[0])" (Join-Path $glsLogDir $pair[1]) -Force
    Write-S3Object -BucketName $env:PA_BUCKET -Key "$($env:PA_PREFIX)/$($pair[1])" -File "$work\$($pair[0])" -Region $region
  } catch { Log "upload $($pair[0]) failed: $_" }
}
# runner 沒寫終態才補 error(已有終態不覆蓋)
try {
  $null = Read-S3Object -BucketName $env:PA_BUCKET -Key "$($env:PA_PREFIX)/status.json" -File "$work\st.json" -Region $region
  $st = (Get-Content "$work\st.json" -Raw | ConvertFrom-Json).state
  if ($st -eq 'running') { Status 'error' "runner 結束(exit $runnerExit)但沒有寫入結果,見主機 log 的 runner stderr 尾段" }
} catch { Log "status check failed: $_" }
# 結束遊戲 → 應用結束 → stream session 結束(停止計費)
Get-Process -Name $game.BaseName -ErrorAction SilentlyContinue | Stop-Process -Force
UploadLog
exit 0
