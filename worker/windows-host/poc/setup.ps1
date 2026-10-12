# 以 SYSTEM 執行(SSM):裝 NVIDIA GRID 驅動、裝遊戲、設定自動登入,最後重開機。
$ErrorActionPreference = 'Stop'
$Bucket = $env:PA_DATA_BUCKET
if ([string]::IsNullOrWhiteSpace($Bucket)) { throw 'PA_DATA_BUCKET is required' }
if ($Bucket.Length -lt 3 -or $Bucket.Length -gt 63 -or $Bucket -notmatch '^[a-z0-9][a-z0-9.-]*[a-z0-9]$' -or $Bucket.Contains('..') -or $Bucket -match '^\d{1,3}(\.\d{1,3}){3}$') {
  throw 'PA_DATA_BUCKET must be a valid S3 bucket name'
}
$Region = @($env:PA_SM_REGION, $env:AWS_REGION, $env:AWS_DEFAULT_REGION, 'us-east-2') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
if ($Region -notmatch '^[a-z0-9-]+$') { throw 'Region contains invalid characters' }

New-Item -ItemType Directory -Force -Path C:\poc, C:\poc\out, C:\poc\nvidia | Out-Null
Start-Transcript -Path C:\poc\out\setup.log -Append

# 1) NVIDIA GRID 驅動(AWS 提供的 G6 版本,授權自動)
$objs = Get-S3Object -BucketName ec2-windows-nvidia-drivers -KeyPrefix latest -Region us-east-1
foreach ($o in $objs) {
  if ($o.Size -gt 0 -and $o.Key -match '\.exe$' -and $o.Key -match 'server2022|win10_win11') {
    $dest = Join-Path C:\poc\nvidia (Split-Path $o.Key -Leaf)
    Copy-S3Object -BucketName ec2-windows-nvidia-drivers -Key $o.Key -LocalFile $dest -Region us-east-1 | Out-Null
    "driver: $($o.Key)"
    $p = Start-Process -FilePath $dest -ArgumentList '-s', '-noreboot' -Wait -PassThru
    "driver install exit=$($p.ExitCode)"
    break
  }
}

# 2) 遊戲(Inno Setup 安裝檔:靜默安裝到固定目錄)
Copy-S3Object -BucketName $Bucket -Key _poc/windows/SouthParkSetup.exe -LocalFile C:\poc\SouthParkSetup.exe -Region $Region | Out-Null
$p = Start-Process -FilePath C:\poc\SouthParkSetup.exe -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/DIR=C:\Games\SouthPark', '/LOG=C:\poc\out\game-install.log' -Wait -PassThru
"game install exit=$($p.ExitCode)"
Get-ChildItem C:\Games\SouthPark -Recurse -Include *.exe | Select-Object FullName, Length | Format-Table -AutoSize | Out-String -Width 300

# 3) 自動登入 Administrator(遊戲要在互動式桌面跑;Session 0 看不到畫面)。
#    PoC 用隨機密碼,不輸出、不保存;正式版改用 LSA secret 存放。
Add-Type -AssemblyName System.Web
$pw = [System.Web.Security.Membership]::GeneratePassword(24, 4)
net user Administrator $pw | Out-Null
$wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $wl -Name AutoAdminLogon -Value '1'
Set-ItemProperty $wl -Name DefaultUserName -Value 'Administrator'
Set-ItemProperty $wl -Name DefaultPassword -Value $pw
Set-ItemProperty $wl -Name DefaultDomainName -Value $env:COMPUTERNAME
# 不要鎖定畫面 / 螢幕保護程式
reg add "HKU\.DEFAULT\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f | Out-Null
powercfg /change monitor-timeout-ac 0
Stop-Transcript
Restart-Computer -Force
