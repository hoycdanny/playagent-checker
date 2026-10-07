# 診斷 2:遊戲設定裡的伺服器網址、連線測試、資源目錄、遊戲程序的所有網路活動。
$g = 'C:\Games\SouthPark'
"== top-level files"
Get-ChildItem $g -File | Sort-Object LastWriteTime -Descending | Select-Object -First 25 Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String -Width 200
"== dirs (size MB)"
Get-ChildItem $g -Directory | ForEach-Object { "{0,-40} {1,8:N1} MB  {2}" -f $_.Name, ((Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), $_.LastWriteTime }
"== urls in config files"
$urls = Get-ChildItem $g -File -Include *.json, *.ini, *.cfg, *.xml, *.txt, *.plist -Recurse -ErrorAction SilentlyContinue | Where-Object Length -lt 2MB |
  Select-String -Pattern 'https?://[A-Za-z0-9._:/-]+' -AllMatches | ForEach-Object { $_.Matches.Value } | Sort-Object -Unique
$urls | Select-Object -First 40
"== url host reachability"
$hosts = $urls | ForEach-Object { ([uri]$_).Host } | Sort-Object -Unique | Select-Object -First 15
foreach ($h in $hosts) {
  $t = Test-NetConnection -ComputerName $h -Port 443 -WarningAction SilentlyContinue
  "{0,-45} dns={1} 443={2}" -f $h, ($t.RemoteAddress -ne $null), $t.TcpTestSucceeded
}
"== all TCP for game (incl. closed recently via netstat)"
$ids = (Get-Process SouthPark -ErrorAction SilentlyContinue).Id
netstat -ano | Select-String ($ids -join '|')
"== firewall profiles"
Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultOutboundAction | Format-Table -AutoSize | Out-String
