# 診斷遊戲卡在「載入中」:網路連線、log 檔、程序。
"== processes"
Get-Process SouthPark, CocosWin -ErrorAction SilentlyContinue | Select-Object Id, Name, CPU, WS, StartTime | Format-Table -AutoSize | Out-String -Width 200
$ids = (Get-Process SouthPark, CocosWin -ErrorAction SilentlyContinue).Id
"== tcp connections"
Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | Select-Object OwningProcess, LocalPort, RemoteAddress, RemotePort, State | Format-Table -AutoSize | Out-String -Width 200
"== dns cache (recent)"
Get-DnsClientCache | Select-Object -First 40 Entry, Data | Format-Table -AutoSize | Out-String -Width 200
"== public ip / geo"
try { (Invoke-RestMethod -Uri 'https://ipinfo.io/json' -TimeoutSec 10) | ConvertTo-Json -Compress } catch { "ipinfo failed: $_" }
"== recent log files"
$roots = @('C:\Games\SouthPark', "C:\Users\Administrator\AppData\Local", "C:\Users\Administrator\AppData\Roaming", "C:\Users\Administrator\AppData\LocalLow")
Get-ChildItem $roots -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-30) -and $_.Extension -in '.log', '.txt', '.json', '' -and $_.Length -lt 5MB } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 15 | ForEach-Object {
    "--- $($_.FullName) ($($_.Length) bytes)"
    Get-Content $_.FullName -Tail 25 -Encoding UTF8 -ErrorAction SilentlyContinue
  }
