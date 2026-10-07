# 診斷 4:重新啟動遊戲(在互動式桌面),90 秒內每秒記錄遊戲程序的 TCP / UDP 連線(含 SynSent 失敗的)。
Get-Process SouthPark, CocosWin -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
$action = New-ScheduledTaskAction -Execute 'C:\Games\SouthPark\SouthPark.exe' -WorkingDirectory 'C:\Games\SouthPark'
$principal = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName 'pa-game' -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'pa-game'
$seen = @{}
for ($i = 0; $i -lt 90; $i++) {
  $ids = @((Get-Process SouthPark, CocosWin -ErrorAction SilentlyContinue).Id)
  Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and $_.RemoteAddress -notin '0.0.0.0', '::', '127.0.0.1' } | ForEach-Object {
    $k = "$($_.RemoteAddress):$($_.RemotePort) $($_.State)"
    if (-not $seen.ContainsKey($k)) { $seen[$k] = $i; "t=${i}s pid=$($_.OwningProcess) $k" }
  }
  Start-Sleep 1
}
"== dns cache"
Get-DnsClientCache | Select-Object Entry, Data | Sort-Object Entry -Unique | Format-Table -AutoSize | Out-String -Width 200
