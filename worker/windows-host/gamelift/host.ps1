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
function Log($m) { "$(Get-Date -Format o) $m" | Add-Content -Path $log -Encoding UTF8 }
$region = if ($env:PA_DATA_REGION) { $env:PA_DATA_REGION } else { 'us-east-2' }
Import-Module AWS.Tools.S3 -ErrorAction SilentlyContinue
Import-Module AWS.Tools.SecurityToken -ErrorAction SilentlyContinue
# GameLift 會把應用的 pa-logs/ 收走(ApplicationLogPaths);host.log 同步寫到那裡,連不上 S3 時仍有紀錄。
$glsLogDir = Join-Path $root 'pa-logs'
$null = New-Item -ItemType Directory -Force -Path $glsLogDir
function UploadLog {
  try { Copy-Item $log (Join-Path $glsLogDir 'host.log') -Force } catch { }
  try { Write-S3Object -BucketName $env:PA_BUCKET -Key "$($env:PA_PREFIX)/host.log" -File $log -Region $region } catch { }
}
function Status($state, $msg) {
  $body = @{ jobId = $env:PA_JOB; state = $state; message = $msg; steps = 0; updatedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
  try { Write-S3Object -BucketName $env:PA_BUCKET -Key "$($env:PA_PREFIX)/status.json" -Content $body -ContentType 'application/json' -Region $region } catch { Log "status write failed: $_" }
}
function Fail($msg) { Log "FAIL: $msg"; Status 'error' $msg; UploadLog; exit 1 }

Log "start job=$env:PA_JOB user=$env:USERNAME session=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
try { Log "caller: $((Get-STSCallerIdentity -Region $region).Arn)" } catch { Fail "沒有 AWS 憑證(stream session 未帶 IAM 角色?):$_" }
if (-not $env:PA_BUCKET -or -not $env:PA_PREFIX -or -not $env:PA_JOB) { Fail 'engine 未帶入 PA_JOB / PA_BUCKET / PA_PREFIX' }
Status 'running' 'Windows GPU 主機已啟動,下載遊戲中'

# 1) runner 程式(agent/*.mjs + WinHelper.cs + winHost.ps1,與 Android / Device Farm 同一份)
try {
  $n = 0
  foreach ($o in Get-S3Object -BucketName $env:PA_BUCKET -KeyPrefix '_engine/runner/' -Region $region) {
    $name = Split-Path $o.Key -Leaf
    if ($name) { $null = Read-S3Object -BucketName $env:PA_BUCKET -Key $o.Key -File "$work\runner\$name" -Region $region; $n++ }
  }
  Log "runner files=$n"
  if ($n -lt 5) { Fail "runner 檔案不足($n);_engine/runner/ 是否已部署?" }
} catch { Fail "下載 runner 失敗:$_" }
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
  if ($file -match '\.zip$') {
    Expand-Archive -Path $file -DestinationPath "$work\game" -Force
  } else {
    # Inno Setup:innoextract 直接解開(不需安裝、不需重開機);不是 Inno 就退回常見的靜默安裝參數。
    $t0 = Get-Date
    & "$root\innoextract.exe" --silent --extract --output-dir "$work\game" $file 2>&1 | Out-String | Set-Variable ieOut
    Log "innoextract $([int]((Get-Date) - $t0).TotalSeconds)s"
    if (-not (Get-ChildItem "$work\game" -Recurse -Filter *.exe -ErrorAction SilentlyContinue)) {
      Log "not Inno Setup (or failed): $($ieOut -replace '\s+', ' ')"
      Log 'trying silent installer flags'
      $null = Start-Process -FilePath $file -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/DIR=$work\game" -Wait -PassThru
      if (-not (Get-ChildItem "$work\game" -Recurse -Filter *.exe -ErrorAction SilentlyContinue)) {
        $null = Start-Process -FilePath $file -ArgumentList '/S', "/D=$work\game" -Wait -PassThru
      }
    }
  }
  # 遊戲執行檔:App 識別碼(相對路徑或檔名)優先,否則取最大的 exe(排除解除安裝 / 安裝 / crash 工具)
  $all = @(Get-ChildItem "$work\game" -Recurse -Filter *.exe -ErrorAction SilentlyContinue)
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
$rp.WaitForExit()
Log "runner exit=$($rp.ExitCode)"
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
  if ($st -eq 'running') { Status 'error' "runner 結束(exit $($rp.ExitCode))但沒有寫入結果,見 runner.err.log" }
} catch { Log "status check failed: $_" }
# 結束遊戲 → 應用結束 → stream session 結束(停止計費)
Get-Process -Name $game.BaseName -ErrorAction SilentlyContinue | Stop-Process -Force
UploadLog
exit 0
