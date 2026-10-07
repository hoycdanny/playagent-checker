# 在 Administrator 的互動式桌面執行(由 run.ps1 用排程工作觸發)。
# -Width/-Height:要測的解析度(0 = 不改);-NoLaunch:不重開遊戲,只截圖/操作;
# -ClickX/-ClickY:點這個桌面座標(-1 = 點遊戲視窗中央);-Wait:每張截圖的間隔秒數
param([int]$Width = 0, [int]$Height = 0, [switch]$NoLaunch, [int]$ClickX = -1, [int]$ClickY = -1, [int]$Shots = 4, [int]$Wait = 20)
$ErrorActionPreference = 'Continue'
$out = 'C:\poc\out'
$log = Join-Path $out 'interactive.log'
function Log($m) { "$(Get-Date -Format o) $m" | Add-Content -Path $log -Encoding UTF8 }

Add-Type -Path C:\poc\PocHelper.cs -ReferencedAssemblies System.Drawing
[PocHelper]::Init()
Log "session=$([Diagnostics.Process]::GetCurrentProcess().SessionId) user=$env:USERNAME"
Log "displays:`n$([PocHelper]::Displays())"

# 1) 解析度:NVIDIA 的主要螢幕。
$nv = ([PocHelper]::Displays() -split "`n" | Where-Object { $_ -match 'NVIDIA' } | Select-Object -First 1)
$dev = if ($nv) { ($nv -split ' \| ')[0].Trim() } else { '\\.\DISPLAY1' }
Log "target device=$dev"
if ($Width -gt 0 -and $Height -gt 0) {
  Log "modes: $([PocHelper]::Modes($dev))"
  $r = [PocHelper]::SetMode($dev, $Width, $Height, 60, $false)
  Log "SetMode ${Width}x${Height} = $r"
  if ($r -ne 0 -and $Height -gt $Width) {
    # 直向:先設成 HxW(橫向)再旋轉 90°。
    $r2 = [PocHelper]::SetMode($dev, $Height, $Width, 60, $false)
    Log "SetMode ${Height}x${Width} (landscape) = $r2"
    if ($r2 -eq 0) { Log "rotate = $([PocHelper]::SetMode($dev, $Width, $Height, 60, $true))" }
  }
  Start-Sleep 3
  Log "after:`n$([PocHelper]::Displays())"
}

# 2) 遊戲:找已在跑的遊戲視窗;沒有(或沒帶 -NoLaunch)就啟動。
function GameWindow { ([PocHelper]::Windows() -split "`n" | Where-Object { $_ -match '滿貫大亨|SouthPark|Cocos' } | Select-Object -First 1) }
if (-not $NoLaunch -or -not (GameWindow)) {
  Get-Process SouthPark, CocosWin -ErrorAction SilentlyContinue | Stop-Process -Force
  $exe = 'C:\Games\SouthPark\SouthPark.exe'
  Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)
  Log "launched $exe"
}
for ($k = 1; $k -le $Shots; $k++) {
  Start-Sleep -Seconds $Wait
  Log "shot $k ($($k * $Wait)s) game=$(GameWindow) :: $([PocHelper]::Screenshot("$out\1-shot-$k.png"))"
}

# 3) 操作:點一下,看畫面有沒有變
$gw = GameWindow
if ($gw -match '^0x([0-9A-F]+)') { [void][PocHelper]::Focus([Convert]::ToInt64($Matches[1], 16)) }
if ($ClickX -lt 0 -and $gw -match '\[(-?\d+),(-?\d+) (\d+)x(\d+)\]') {
  $ClickX = [int]$Matches[1] + [int]([int]$Matches[3] / 2); $ClickY = [int]$Matches[2] + [int]([int]$Matches[4] / 2)
}
if ($ClickX -ge 0) {
  [PocHelper]::Click($ClickX, $ClickY); Log "click ($ClickX,$ClickY)"
  Start-Sleep 5
  Log "after click: $([PocHelper]::Screenshot("$out\2-after-click.png"))"
}
Log "windows:`n$([PocHelper]::Windows())"
Log "processes: $((Get-Process SouthPark, CocosWin -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name)#$($_.Id)" }) -join ', ')"
'done' | Set-Content "$out\interactive.done"
