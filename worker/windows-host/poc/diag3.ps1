# 診斷 3:遊戲 debug.log、HTTP(80)連線、Cocos 設定。
"== debug.log tail"
Get-Content C:\Games\ExampleGame\debug.log -Tail 60 -Encoding UTF8
"== CocosWin.ccfg / VersionControlConfig / UserDefault"
Get-Content C:\Games\ExampleGame\CocosWin.ccfg, C:\Games\ExampleGame\VersionControlConfig.examplevendor, C:\Games\ExampleGame\UserDefault.xml -Encoding UTF8 -ErrorAction SilentlyContinue
"== port 80"
foreach ($h in '198.51.100.11', '198.51.100.10', 'api.example.invalid') {
  $t = Test-NetConnection -ComputerName $h -Port 80 -WarningAction SilentlyContinue
  "{0,-30} 80={1}" -f $h, $t.TcpTestSucceeded
}
try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 'http://198.51.100.11/Apple/Service.asmx/QueryCurrentVersion'; "http status=$($r.StatusCode) len=$($r.Content.Length)" } catch { "http error: $($_.Exception.Message)" }
"== log files anywhere for ExampleGame/Cocos (last 2h)"
Get-ChildItem C:\Users\Administrator\AppData -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'ExampleGame|Cocos|TMD|examplevendor' -and $_.LastWriteTime -gt (Get-Date).AddHours(-2) } | Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 300
