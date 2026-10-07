# 診斷 5:fresh run 之後的 debug.log 新內容、ex.gametower 連線、最近修改的檔案。
"== debug.log lines from today"
Get-Content C:\Games\ExampleGame\debug.log -Encoding UTF8 | Where-Object { $_ -match '^\[1006/' } | Select-Object -Last 40
"== ex.example.invalid"
foreach ($p in 443, 80) { $t = Test-NetConnection -ComputerName ex.example.invalid -Port $p -WarningAction SilentlyContinue; "port $p = $($t.TcpTestSucceeded)" }
"== files changed in last 10 min (game + appdata)"
Get-ChildItem C:\Games\ExampleGame, C:\Users\Administrator\AppData -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-10) -and $_.FullName -notmatch 'PowerShell|Microsoft\\Windows' } | Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 300
"== game threads / cpu"
Get-Process ExampleGame -ErrorAction SilentlyContinue | Select-Object Id, CPU, @{n = 'Threads'; e = { $_.Threads.Count } }, Responding, MainWindowTitle | Format-Table -AutoSize | Out-String -Width 200
