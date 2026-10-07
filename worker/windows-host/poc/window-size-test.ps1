# 在互動式桌面:桌面設成大解析度,把遊戲視窗客戶區調成 -Width x -Height,截客戶區。
param([int]$Width = 1080, [int]$Height = 4096, [int]$DeskW = 7680, [int]$DeskH = 4320)
$out = 'C:\poc\out'; $log = "$out\interactive.log"
function Log($m) { "$(Get-Date -Format o) $m" | Add-Content -Path $log -Encoding UTF8 }
Add-Type -Path C:\poc\PocHelper.cs -ReferencedAssemblies System.Drawing
[PocHelper]::Init()
Log "SetMode ${DeskW}x${DeskH} = $([PocHelper]::SetMode('\\.\DISPLAY2', $DeskW, $DeskH, 60, $false))"
Start-Sleep 3
Log "displays:`n$([PocHelper]::Displays())"
$gw = ([PocHelper]::Windows() -split "`n" | Where-Object { $_ -match '滿貫大亨' } | Select-Object -First 1)
Log "game window before: $gw"
if ($gw -match '^0x([0-9A-F]+)') {
  $h = [Convert]::ToInt64($Matches[1], 16)
  Log "resize: $([PocHelper]::SetClientSize($h, 40, 80, $Width, $Height))"
  Start-Sleep 5
  $after = ([PocHelper]::Windows() -split "`n" | Where-Object { $_ -match '滿貫大亨' } | Select-Object -First 1)
  Log "game window after: $after"
  $r = [PocHelper]::SetClientSize($h, 40, 80, $Width, $Height)
  Log "verify: $r"
  if ($r -match '\((-?\d+),(-?\d+)\) (\d+)x(\d+)') { Log "client shot: $([PocHelper]::ScreenshotRect("$out\client.png", [int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4]))" }
}
Log "full: $([PocHelper]::Screenshot("$out\full.png"))"
'done' | Set-Content "$out\interactive.done"
