# 以 SYSTEM 執行(SSM):在 Administrator 的互動式桌面跑 -Inner 腳本(預設 interactive.ps1),等它結束後把結果上傳 S3。
# -Pass:原樣傳給內層腳本的參數(例:'-Width 1080 -Height 4096 -NoLaunch')
param([string]$Tag = 'run', [string]$Pass = '', [string]$Inner = 'interactive.ps1')
$Bucket = 'playagentdev-foundation-databuckete6b0faa8-r5hkpnrl2c5i'
Remove-Item C:\poc\out\interactive.done, C:\poc\out\*.png, C:\poc\out\interactive.log -ErrorAction SilentlyContinue
"session list:"; query user 2>&1

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\poc\$Inner $Pass"
$principal = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName 'pa-poc' -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'pa-poc'
for ($i = 0; $i -lt 120 -and -not (Test-Path C:\poc\out\interactive.done); $i++) { Start-Sleep 5 }
"done=$(Test-Path C:\poc\out\interactive.done)"
Get-ChildItem C:\poc\out -File | Where-Object { $_.Name -notlike '*.log' -or $_.Name -eq 'interactive.log' } | ForEach-Object {
  Write-S3Object -BucketName $Bucket -Key "_poc/windows/out/$Tag/$($_.Name)" -File $_.FullName -Region us-east-2
}
Get-Content C:\poc\out\interactive.log -Encoding UTF8 -ErrorAction SilentlyContinue
