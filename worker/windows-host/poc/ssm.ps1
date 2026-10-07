# 本機工具:把 poc 目錄下的 .ps1 上傳 S3,透過 SSM 在 PoC 主機以 SYSTEM 執行,等結果並印出。
# 用法:./ssm.ps1 -Script fix-display.ps1 [-Args '-Width 1080 -Height 4096 -Tag t1'] [-WaitSec 60]
param([Parameter(Mandatory)][string]$Script, [string]$Args = '', [int]$WaitSec = 60, [string]$Instance = 'i-024ae2b0fccda0f0a')
$Bucket = 'playagentdev-foundation-databuckete6b0faa8-r5hkpnrl2c5i'
$tmp = Join-Path $env:TEMP "pa-ssm-$PID"
$null = New-Item -ItemType Directory -Force $tmp
$files = @(Get-ChildItem $PSScriptRoot -File -Include *.ps1, *.cs -Name | Where-Object { $_ -ne 'ssm.ps1' })
foreach ($f in $files) {
  $c = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $f), [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText((Join-Path $tmp $f), $c, (New-Object Text.UTF8Encoding $true))
  aws s3 cp (Join-Path $tmp $f) "s3://$Bucket/_poc/windows/scripts/$f" --region us-east-2 --only-show-errors
}
$cmds = @(
  "foreach (`$f in '$($files -join "','")') { Copy-S3Object -BucketName $Bucket -Key `"_poc/windows/scripts/`$f`" -LocalFile `"C:\poc\`$f`" -Region us-east-2 | Out-Null }",
  "& C:\poc\$Script $Args"
)
$json = @{ commands = $cmds } | ConvertTo-Json -Compress
$pf = Join-Path $tmp 'params.json'
[IO.File]::WriteAllText($pf, $json)
$id = aws ssm send-command --region us-east-2 --instance-ids $Instance --document-name AWS-RunPowerShellScript --parameters "file://$pf" --timeout-seconds 1800 --query Command.CommandId --output text
Remove-Item -Recurse $tmp
"command=$id"
for ($i = 0; $i -lt [Math]::Ceiling($WaitSec / 10) + 60; $i++) {
  Start-Sleep 10
  $st = aws ssm get-command-invocation --region us-east-2 --command-id $id --instance-id $Instance --query Status --output text 2>$null
  if ($st -and $st -notin @('Pending', 'InProgress', 'Delayed')) { break }
}
aws ssm get-command-invocation --region us-east-2 --command-id $id --instance-id $Instance --query "[Status,StandardOutputContent,StandardErrorContent]" --output text
