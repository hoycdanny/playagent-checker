# 本機工具:把 poc 目錄下的 .ps1 上傳 S3,透過 SSM 在 PoC 主機以 SYSTEM 執行,等結果並印出。
# 用法:./ssm.ps1 -Script fix-display.ps1 -Instance i-0123456789abcdef0 [-Bucket my-data-bucket] [-Args '-Width 1080 -Height 4096 -Tag t1'] [-WaitSec 60]
param(
  [Parameter(Mandatory)][string]$Script,
  [string]$Args = '',
  [int]$WaitSec = 60,
  [Parameter(Mandatory)][string]$Instance,
  [string]$Bucket = $env:PA_DATA_BUCKET
)

if ($Instance -notmatch '^i-[0-9a-f]{8,17}$') { throw 'Instance must be a valid EC2 instance ID' }
if ([string]::IsNullOrWhiteSpace($Bucket)) { throw 'Bucket is required; pass -Bucket or set PA_DATA_BUCKET' }
if ($Bucket.Length -lt 3 -or $Bucket.Length -gt 63 -or $Bucket -notmatch '^[a-z0-9][a-z0-9.-]*[a-z0-9]$' -or $Bucket.Contains('..') -or $Bucket -match '^\d{1,3}(\.\d{1,3}){3}$') {
  throw 'Bucket must be a valid S3 bucket name'
}
$Region = @($env:PA_SM_REGION, $env:AWS_REGION, $env:AWS_DEFAULT_REGION, 'us-east-2') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
if ($Region -notmatch '^[a-z0-9-]+$') { throw 'Region contains invalid characters' }

$tmp = Join-Path $env:TEMP "pa-ssm-$PID"
$null = New-Item -ItemType Directory -Force $tmp
$files = @(Get-ChildItem $PSScriptRoot -File -Include *.ps1, *.cs -Name | Where-Object { $_ -ne 'ssm.ps1' })
foreach ($f in $files) {
  $c = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $f), [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText((Join-Path $tmp $f), $c, (New-Object Text.UTF8Encoding $true))
  aws s3 cp (Join-Path $tmp $f) "s3://$Bucket/_poc/windows/scripts/$f" --region $Region --only-show-errors
}
$cmds = @(
  "`$env:PA_DATA_BUCKET = '$Bucket'",
  "`$env:PA_SM_REGION = '$Region'",
  "foreach (`$f in '$($files -join "','")') { Copy-S3Object -BucketName `$env:PA_DATA_BUCKET -Key `"_poc/windows/scripts/`$f`" -LocalFile `"C:\poc\`$f`" -Region `$env:PA_SM_REGION | Out-Null }",
  "& C:\poc\$Script $Args"
)
$json = @{ commands = $cmds } | ConvertTo-Json -Compress
$pf = Join-Path $tmp 'params.json'
[IO.File]::WriteAllText($pf, $json)
$id = aws ssm send-command --region $Region --instance-ids $Instance --document-name AWS-RunPowerShellScript --parameters "file://$pf" --timeout-seconds 1800 --query Command.CommandId --output text
Remove-Item -Recurse $tmp
"command=$id"
for ($i = 0; $i -lt [Math]::Ceiling($WaitSec / 10) + 60; $i++) {
  Start-Sleep 10
  $st = aws ssm get-command-invocation --region $Region --command-id $id --instance-id $Instance --query Status --output text 2>$null
  if ($st -and $st -notin @('Pending', 'InProgress', 'Delayed')) { break }
}
aws ssm get-command-invocation --region $Region --command-id $id --instance-id $Instance --query "[Status,StandardOutputContent,StandardErrorContent]" --output text
