# GameLift Streams Windows PoC:在串流 session 裡解開遊戲、啟動、截圖、點擊,並測「沒有人連線」時能撐多久。
# 結果用 presigned POST(環境變數 PA_UPLOAD)即時上傳到 S3;不需要 AWS 憑證。
# 環境變數:PA_UPLOAD(JSON:url、fields、prefix)、PA_MODE(ops | idle)、PA_IDLE_MIN(idle 模式撐幾分鐘)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $env:LOCALAPPDATA 'pa-out'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$logFile = Join-Path $out 'launcher.log'
function Log($m) { "$(Get-Date -Format o) $m" | Add-Content -Path $logFile -Encoding UTF8 }

Add-Type -AssemblyName System.Net.Http
$up = $null
try { $up = $env:PA_UPLOAD | ConvertFrom-Json } catch { Log "PA_UPLOAD parse failed: $_" }
function Upload([string]$path, [string]$name) {
  if (-not $up) { return }
  try {
    $client = New-Object System.Net.Http.HttpClient
    $form = New-Object System.Net.Http.MultipartFormDataContent
    foreach ($p in $up.fields.PSObject.Properties) { $form.Add((New-Object System.Net.Http.StringContent($p.Value)), $p.Name) }
    $form.Add((New-Object System.Net.Http.StringContent("$($up.prefix)$name")), 'key')
    $bytes = [IO.File]::ReadAllBytes($path)
    $file = New-Object System.Net.Http.ByteArrayContent(, $bytes)
    $form.Add($file, 'file', $name)
    $r = $client.PostAsync($up.url, $form).Result
    if (-not $r.IsSuccessStatusCode) { Log "upload $name -> $([int]$r.StatusCode) $($r.Content.ReadAsStringAsync().Result)" }
  } catch { Log "upload $name failed: $_" }
}
function UploadLog { Upload $logFile 'launcher.log' }

Log "start mode=$env:PA_MODE root=$root"
Log "user=$env:USERNAME domain=$env:USERDOMAIN session=$([Diagnostics.Process]::GetCurrentProcess().SessionId)"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Log "admin=$isAdmin os=$([Environment]::OSVersion.VersionString)"
# 憑證怎麼給(只記變數名稱,不記值)
Log "aws env vars: $((Get-ChildItem env: | Where-Object Name -like 'AWS*' | ForEach-Object Name) -join ', ')"
Log "has powershell AWS module: $([bool](Get-Module -ListAvailable -Name AWS.Tools.S3, AWSPowerShell -ErrorAction SilentlyContinue))"

Add-Type -Path (Join-Path $root 'PocHelper.cs') -ReferencedAssemblies System.Drawing
[PocHelper]::Init()
Log "displays:`n$([PocHelper]::Displays())"
Log "gpu: $((Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name) $($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)" }) -join '; ')"
Log "desktop shot: $([PocHelper]::Screenshot("$out\0-desktop.png"))"
Upload "$out\0-desktop.png" '0-desktop.png'
UploadLog

if ($env:PA_MODE -eq 'idle') {
  # 閒置測試:什麼都不做,每 5 分鐘回報一次心跳,看 session 會不會被提早結束。
  $mins = [int]($env:PA_IDLE_MIN); if ($mins -le 0) { $mins = 75 }
  for ($i = 0; $i -le $mins; $i += 5) {
    Log "heartbeat t=${i}min"
    UploadLog
    Start-Sleep -Seconds 300
  }
  Log 'idle test finished (session survived)'
  UploadLog
  exit 0
}

# 1) 解開 Inno Setup 安裝檔(不需要系統管理員權限)
$game = Join-Path $env:LOCALAPPDATA 'pa-game'
$t0 = Get-Date
& (Join-Path $root 'innoextract.exe') --silent --extract --output-dir $game (Join-Path $root 'SouthParkSetup.exe') 2>&1 | Select-Object -Last 3 | ForEach-Object { Log "innoextract: $_" }
$exe = Get-ChildItem $game -Recurse -Filter SouthPark.exe -ErrorAction SilentlyContinue | Select-Object -First 1
Log "extracted in $([int]((Get-Date) - $t0).TotalSeconds)s exe=$($exe.FullName)"
UploadLog
if (-not $exe) { Log 'game exe not found'; UploadLog; exit 1 }

# 2) 啟動遊戲,等熱更新,定時截圖
$p = Start-Process -FilePath $exe.FullName -WorkingDirectory $exe.DirectoryName -PassThru
Log "launched pid=$($p.Id)"
function GameWindow { ([PocHelper]::Windows() -split "`n" | Where-Object { $_ -match '滿貫大亨' } | Select-Object -First 1) }
for ($k = 1; $k -le 12; $k++) {
  Start-Sleep -Seconds 30
  $gw = GameWindow
  Log "shot $k ($($k * 30)s) window=$gw :: $([PocHelper]::Screenshot("$out\1-shot-$k.png"))"
  Upload "$out\1-shot-$k.png" "1-shot-$k.png"
  UploadLog
}

# 3) 操作:點「手機登入」(相對於遊戲視窗的位置),再點 ✕ 關閉
$gw = GameWindow
if ($gw -match '^0x([0-9A-F]+) pid=\d+ \[(-?\d+),(-?\d+) (\d+)x(\d+)\]') {
  [void][PocHelper]::Focus([Convert]::ToInt64($Matches[1], 16))
  $wx = [int]$Matches[2]; $wy = [int]$Matches[3]; $ww = [int]$Matches[4]; $wh = [int]$Matches[5]
  $bx = $wx + [int]($ww * 0.364); $by = $wy + [int]($wh * 0.797)
  [PocHelper]::Click($bx, $by); Log "click login ($bx,$by)"
  Start-Sleep 5
  Log "after login click: $([PocHelper]::Screenshot("$out\2-after-login.png"))"
  Upload "$out\2-after-login.png" '2-after-login.png'
  $cx = $wx + [int]($ww * 0.758); $cy = $wy + [int]($wh * 0.165)
  [PocHelper]::Click($cx, $cy); Log "click close ($cx,$cy)"
  Start-Sleep 4
  Log "after close click: $([PocHelper]::Screenshot("$out\3-after-close.png"))"
  Upload "$out\3-after-close.png" '3-after-close.png'
} else { Log "no game window: $gw" }
Log "windows:`n$([PocHelper]::Windows())"
Log 'ops test finished'
UploadLog
