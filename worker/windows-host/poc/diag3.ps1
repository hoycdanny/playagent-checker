# 診斷 3:遊戲 debug.log、HTTP(80)連線、Cocos 設定。
"== debug.log tail"
Get-Content C:\Games\SouthPark\debug.log -Tail 60 -Encoding UTF8
"== CocosWin.ccfg / VersionControlConfig / UserDefault"
Get-Content C:\Games\SouthPark\CocosWin.ccfg, C:\Games\SouthPark\VersionControlConfig.igs, C:\Games\SouthPark\UserDefault.xml -Encoding UTF8 -ErrorAction SilentlyContinue
"== port 80"
foreach ($h in '35.201.157.109', '203.69.83.186', 'api.slam777.com.tw') {
  $t = Test-NetConnection -ComputerName $h -Port 80 -WarningAction SilentlyContinue
  "{0,-30} 80={1}" -f $h, $t.TcpTestSucceeded
}
try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 'http://35.201.157.109/Apple/Service.asmx/QueryCurrentVersion'; "http status=$($r.StatusCode) len=$($r.Content.Length)" } catch { "http error: $($_.Exception.Message)" }
"== log files anywhere for SouthPark/Cocos (last 2h)"
Get-ChildItem C:\Users\Administrator\AppData -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'SouthPark|Cocos|TMD|igs' -and $_.LastWriteTime -gt (Get-Date).AddHours(-2) } | Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 300
