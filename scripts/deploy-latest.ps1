[CmdletBinding()]
param(
  [string]$RepositoryUrl = 'https://github.com/hoycdanny/playagent-checker.git',
  [string]$Branch = 'main',
  [string]$Region = 'us-east-2',
  [string]$Stage = 'dev',
  [string]$Profile = '',
  [string]$ExpectedAccountId = '',
  [string]$CdkContext = '',
  [string]$AdminEmail = '',
  [string]$AdminTenant = '',
  [string]$AdminPasswordEnv = 'PA_ADMIN_PASSWORD',
  [switch]$SkipTests,
  [switch]$SkipBootstrap,
  [switch]$PlanOnly,
  [switch]$NonInteractive,
  [switch]$Internal,
  [string]$SourceRoot = '',
  [string]$SourceSha = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step([string]$Text) {
  Write-Host ''
  Write-Host "==> $Text" -ForegroundColor Cyan
}
function Fail([string]$Text) { throw $Text }
function Require-Command([string]$Name, [string]$Install) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { Fail "找不到 $Name。請先安裝: $Install" }
}
function Run([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = '') {
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  try {
    & $File @Arguments
    $code = $LASTEXITCODE
  } finally {
    if ($WorkingDirectory) { Pop-Location }
  }
  if ($code -ne 0) { Fail "$File 執行失敗(exit=$code): $($Arguments -join ' ')" }
}
function Capture([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = '') {
  if ($WorkingDirectory) { Push-Location $WorkingDirectory }
  try {
    $out = & $File @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    if ($WorkingDirectory) { Pop-Location }
  }
  if ($code -ne 0) { Fail "$File 執行失敗(exit=$code): $($Arguments -join ' ')`n$($out -join "`n")" }
  return ($out -join "`n").Trim()
}
function Context-Args([string]$ImageTag) {
  $a = @('-c', "stage=$Stage", '-c', "runnerImageTag=$ImageTag")
  foreach ($x in ($CdkContext -split ';')) {
    $v = $x.Trim()
    if ($v) { $a += @('-c', $v) }
  }
  return $a
}
function Deploy-Stacks([string[]]$Stacks, [string]$ImageTag, [int]$Concurrency = 2) {
  $deployArgs = @('cdk', 'deploy') + $Stacks + @('--require-approval', 'never', '--concurrency', [string]$Concurrency) + (Context-Args $ImageTag)
  Run 'npx' $deployArgs (Join-Path $SourceRoot 'infra')
}
function Stack-Outputs([string]$Name) {
  $raw = Capture 'aws' @('cloudformation', 'describe-stacks', '--region', $Region, '--stack-name', $Name, '--query', 'Stacks[0].Outputs', '--output', 'json')
  return @($raw | ConvertFrom-Json)
}
function Output-Starting([object[]]$Outputs, [string]$Prefix) {
  $o = $Outputs | Where-Object { [string]$_.OutputKey -like "$Prefix*" } | Select-Object -First 1
  if ($null -ne $o) { return [string]$o.OutputValue }
  return ''
}
function Output-Containing([object[]]$Outputs, [string]$Text) {
  $o = $Outputs | Where-Object { [string]$_.OutputKey -like "*$Text*" } | Select-Object -First 1
  if ($null -ne $o) { return [string]$o.OutputValue }
  return ''
}
function Remove-TempWorktree([string]$Repo, [string]$Path) {
  # npm/node_modules/CloudFront asset staging 在 Windows 偶爾延遲釋放檔案;清理失敗不可把成功部署誤報失敗。
  for ($i = 0; $i -lt 3; $i++) {
    & git -C $Repo worktree remove --force $Path 2>$null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep -Seconds 2
  }
  Write-Warning "暫存 worktree 自動清理失敗,嘗試解除登記:$Path"
  & git -C $Repo worktree prune 2>$null
  try { Remove-Item $Path -Recurse -Force -ErrorAction Stop }
  catch { Write-Warning "請稍後手動刪除暫存目錄:$Path" }
}
function Image-Digest([string]$Repo, [string]$Tag) {
  return Capture 'aws' @('ecr', 'describe-images', '--region', $Region, '--repository-name', $Repo, '--image-ids', "imageTag=$Tag", '--query', 'imageDetails[0].imageDigest', '--output', 'text')
}
function Verify-Stack([string]$Name) {
  $status = Capture 'aws' @('cloudformation', 'describe-stacks', '--region', $Region, '--stack-name', $Name, '--query', 'Stacks[0].StackStatus', '--output', 'text')
  if ($status -notmatch '^(CREATE|UPDATE)_COMPLETE$') { Fail "Stack $Name 狀態不是完成:$status" }
  Write-Host "  OK $Name ($status)" -ForegroundColor Green
}

# 外層永遠從 canonical remote branch 解析不可變 SHA,並在隔離 worktree 執行最新版腳本。
if (-not $Internal) {
  Require-Command 'git' 'https://git-scm.com/downloads'
  if ($Branch -notmatch '^[A-Za-z0-9._/-]{1,100}$') { Fail 'Branch 格式不正確' }
  $callerRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  for ($round = 1; $round -le 3; $round++) {
    Step "取得最新版 ($RepositoryUrl / $Branch),第 $round 輪"
    Run 'git' @('fetch', '--force', '--prune', $RepositoryUrl, "+refs/heads/$Branch`:refs/remotes/playagent-installer/$Branch") $callerRoot
    $sha = Capture 'git' @('rev-parse', "refs/remotes/playagent-installer/$Branch^{commit}") $callerRoot
    $short = $sha.Substring(0, 12)
    $work = Join-Path $env:TEMP "playagent-latest-$short-$PID-$round"
    Run 'git' @('worktree', 'add', '--detach', $work, $sha) $callerRoot
    try {
      Write-Host "將部署 commit $sha" -ForegroundColor Green
      $child = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $work 'scripts\deploy-latest.ps1'),
        '-Internal', '-SourceRoot', $work, '-SourceSha', $sha,
        '-RepositoryUrl', $RepositoryUrl, '-Branch', $Branch, '-Region', $Region, '-Stage', $Stage,
        '-AdminPasswordEnv', $AdminPasswordEnv)
      if ($Profile) { $child += @('-Profile', $Profile) }
      if ($ExpectedAccountId) { $child += @('-ExpectedAccountId', $ExpectedAccountId) }
      if ($CdkContext) { $child += @('-CdkContext', $CdkContext) }
      if ($AdminEmail) { $child += @('-AdminEmail', $AdminEmail) }
      if ($AdminTenant) { $child += @('-AdminTenant', $AdminTenant) }
      if ($SkipTests) { $child += '-SkipTests' }
      if ($SkipBootstrap) { $child += '-SkipBootstrap' }
      if ($PlanOnly) { $child += '-PlanOnly' }
      if ($NonInteractive) { $child += '-NonInteractive' }
      & powershell @child
      $childCode = $LASTEXITCODE
      if ($childCode -ne 0) { exit $childCode }
    } finally {
      Remove-TempWorktree $callerRoot $work
    }
    # 部署時間可能很長;結束時再看 main 是否前進。若有,自動部署新 SHA。
    Run 'git' @('fetch', '--force', $RepositoryUrl, "+refs/heads/$Branch`:refs/remotes/playagent-installer/$Branch") $callerRoot
    $after = Capture 'git' @('rev-parse', "refs/remotes/playagent-installer/$Branch^{commit}") $callerRoot
    if ($after -eq $sha) {
      Write-Host "`n最新版部署完成:$sha" -ForegroundColor Green
      exit 0
    }
    Write-Warning "部署期間 main 已更新:$sha -> $after;自動重跑最新版。"
  }
  Fail 'main 在三輪部署期間持續更新,請稍後再執行一次。'
}

# ───────────────────────── 內層:只在隔離、指定 SHA 的 worktree 執行 ─────────────────────────
if (-not $SourceRoot -or -not $SourceSha) { Fail 'Internal 模式缺少 SourceRoot/SourceSha' }
$SourceRoot = (Resolve-Path $SourceRoot).Path
$actualSha = Capture 'git' @('rev-parse', 'HEAD') $SourceRoot
if ($actualSha -ne $SourceSha) { Fail "來源 SHA 不一致:$actualSha != $SourceSha" }

$logDir = Join-Path $HOME '.playagent\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "deploy-$((Get-Date).ToString('yyyyMMdd-HHmmss'))-$($SourceSha.Substring(0,12)).log"
try { Start-Transcript -Path $logFile -Force | Out-Null } catch { }
try {
  Step '檢查工具與 AWS 身分'
  Require-Command 'node' 'Node.js 22 LTS: https://nodejs.org/'
  Require-Command 'npm' 'Node.js 22 LTS: https://nodejs.org/'
  Require-Command 'aws' 'AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html'
  Require-Command 'docker' 'Docker Desktop: https://www.docker.com/products/docker-desktop/'
  $nodeMajor = [int]((Capture 'node' @('--version')).TrimStart('v').Split('.')[0])
  if ($nodeMajor -lt 22) { Fail "需要 Node.js 22+,目前是 v$nodeMajor" }
  if ($Profile) { $env:AWS_PROFILE = $Profile }
  $env:AWS_REGION = $Region
  $env:AWS_DEFAULT_REGION = $Region
  $env:CDK_DEFAULT_REGION = $Region
  $identity = (Capture 'aws' @('sts', 'get-caller-identity', '--region', $Region, '--output', 'json')) | ConvertFrom-Json
  $account = [string]$identity.Account
  if ($ExpectedAccountId -and $ExpectedAccountId -ne $account) { Fail "AWS 帳號錯誤:預期 $ExpectedAccountId,目前 $account" }
  Run 'docker' @('info')
  Write-Host "  AWS account : $account"
  Write-Host "  AWS identity: $($identity.Arn)"
  Write-Host "  Region      : $Region"
  Write-Host "  Source SHA  : $SourceSha"
  if (-not $NonInteractive) {
    $ok = Read-Host '確認部署到以上 AWS 帳號? [y/N]'
    if ($ok -notmatch '^(y|yes)$') { Fail '使用者取消部署' }
  }

  $prefix = if ($Stage -eq 'dev') { 'PlayAgentDev' } else { "PlayAgent-$Stage" }
  $foundation = "$prefix-Foundation"
  $execution = "$prefix-Execution"
  $scheduling = "$prefix-Scheduling"
  $control = "$prefix-ControlPlane"
  $frontend = "$prefix-Frontend"
  $infra = Join-Path $SourceRoot 'infra'
  $agent = Join-Path $SourceRoot 'agent'
  if ($PlanOnly) {
    Write-Host "PLAN OK:將從乾淨 SHA $SourceSha 部署 $foundation, $execution, $scheduling, $control, $frontend" -ForegroundColor Green
    Write-Host 'PLAN OK:將重建兩個 runner、比對 SHA/latest digest、鎖定 ECS SHA、驗證 CloudFront' -ForegroundColor Green
    return
  }

  Step '以 lockfile 安裝相依套件'
  Run 'npm' @('ci', '--no-audit', '--no-fund') $SourceRoot

  if (-not $SkipTests) {
    Step '執行部署前檢查'
    Run 'npm' @('run', 'test:web') $SourceRoot
    Run 'npm' @('run', 'test:worker') $SourceRoot
    Run 'npx' @('tsc', '--noEmit', '-p', '.') $infra
    Run 'npx' @('vitest', 'run', 'test/runner-dockerfiles.test.ts', 'test/apk-merge.test.ts', 'test/secretsResolver.test.ts') $infra
  }

  if (-not $SkipBootstrap) {
    Step 'CDK bootstrap（可重複執行）'
    Run 'npx' @('cdk', 'bootstrap', "aws://$account/$Region") $infra
  }

  Step '建立 Foundation、Execution 與 ECR repositories'
  Deploy-Stacks @($foundation, $execution) 'latest'

  Step '由同一個 Git SHA 建置並推送 runner images'
  $registry = "$account.dkr.ecr.$Region.amazonaws.com"
  $password = Capture 'aws' @('ecr', 'get-login-password', '--region', $Region)
  $password | & docker login --username AWS --password-stdin $registry
  if ($LASTEXITCODE -ne 0) { Fail 'ECR docker login 失敗' }
  $repos = @(
    @{ Name = 'playagent-exploration-runner'; Dockerfile = 'Dockerfile.exploration' },
    @{ Name = 'playagent-web-runner'; Dockerfile = 'Dockerfile.web' }
  )
  foreach ($r in $repos) {
    $uri = "$registry/$($r.Name)"
    Run 'docker' @('build', '--platform', 'linux/amd64', '--label', "org.opencontainers.image.revision=$SourceSha", '-f', $r.Dockerfile, '-t', "$uri`:$SourceSha", '.') $agent
    Run 'docker' @('push', "$uri`:$SourceSha")
  }
  # 兩個不可變 SHA tag 都成功後,才更新 convenience latest。
  foreach ($r in $repos) {
    $uri = "$registry/$($r.Name)"
    Run 'docker' @('tag', "$uri`:$SourceSha", "$uri`:latest")
    Run 'docker' @('push', "$uri`:latest")
  }
  $digests = @{}
  foreach ($r in $repos) {
    $shaDigest = Image-Digest $r.Name $SourceSha
    $latestDigest = Image-Digest $r.Name 'latest'
    if ($shaDigest -ne $latestDigest) { Fail "$($r.Name):SHA tag 與 latest digest 不一致" }
    $digests[$r.Name] = $shaDigest
    Write-Host "  OK $($r.Name):$($SourceSha.Substring(0,12)) = latest = $shaDigest" -ForegroundColor Green
  }

  Step '鎖定 ECS task definitions 到 Git SHA'
  Deploy-Stacks @($execution) $SourceSha 1

  Step '部署 Scheduling 與 ControlPlane'
  Deploy-Stacks @($scheduling, $control) $SourceSha

  Step '由 Stack outputs 產生前端設定並建置'
  $fo = Stack-Outputs $foundation
  $co = Stack-Outputs $control
  $poolId = Output-Starting $fo 'AuthUserPoolId'
  $clientId = Output-Starting $fo 'AuthUserPoolClientId'
  $apiUrl = Output-Starting $co 'ApiUrl'
  $wsUrl = Output-Starting $co 'WsUrl'
  $missing = @()
  if (-not $poolId) { $missing += 'UserPoolId' }
  if (-not $clientId) { $missing += 'ClientId' }
  if (-not $apiUrl) { $missing += 'ApiUrl' }
  if (-not $wsUrl) { $missing += 'WsUrl' }
  if ($missing.Count) { Fail "前端設定缺少:$($missing -join ',')" }
  $envText = @(
    "VITE_COGNITO_REGION=$Region",
    "VITE_COGNITO_USER_POOL_ID=$poolId",
    "VITE_COGNITO_CLIENT_ID=$clientId",
    "VITE_API_URL=$apiUrl",
    "VITE_WS_URL=$wsUrl"
  ) -join "`n"
  [IO.File]::WriteAllText((Join-Path $SourceRoot 'web\.env.production'), "$envText`n", (New-Object Text.UTF8Encoding $false))
  $dist = Join-Path $SourceRoot 'web\dist'
  if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
  Run 'npm' @('run', 'build:web') $SourceRoot
  $embedded = Get-ChildItem (Join-Path $dist 'assets') -File | Select-String -SimpleMatch $apiUrl -Quiet
  if (-not $embedded) { Fail '前端 bundle 沒有正確嵌入 API URL' }

  Step '部署前端'
  Deploy-Stacks @($frontend) $SourceSha 1

  # 可選:建立第一個 admin。密碼只從 SecureString / 指定環境變數進記憶體,不寫檔。
  if (-not $AdminEmail -and -not $NonInteractive) {
    $AdminEmail = (Read-Host '要建立/更新第一個管理員嗎? 輸入 email；略過請直接 Enter').Trim()
  }
  if ($AdminEmail) {
    if (-not $AdminTenant) {
      if ($NonInteractive) { Fail '指定 AdminEmail 時也必須指定 AdminTenant' }
      $AdminTenant = (Read-Host '管理員 tenant（例如 acme）').Trim()
    }
    $plainPassword = [Environment]::GetEnvironmentVariable($AdminPasswordEnv)
    if (-not $plainPassword) {
      if ($NonInteractive) { Fail "請設定環境變數 $AdminPasswordEnv 作為管理員密碼" }
      $secure = Read-Host '管理員密碼（至少 8 字，大小寫與數字）' -AsSecureString
      $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try { $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
      finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    }
    if ($plainPassword.Length -lt 8) { Fail '管理員密碼至少 8 字' }
    Step "建立/更新管理員 $AdminEmail"
    & aws cognito-idp admin-get-user --region $Region --user-pool-id $poolId --username $AdminEmail *> $null
    if ($LASTEXITCODE -ne 0) {
      Run 'aws' @('cognito-idp', 'admin-create-user', '--region', $Region, '--user-pool-id', $poolId,
        '--username', $AdminEmail, '--user-attributes', "Name=email,Value=$AdminEmail", 'Name=email_verified,Value=true', "Name=custom:tenantId,Value=$AdminTenant", '--message-action', 'SUPPRESS')
    }
    Run 'aws' @('cognito-idp', 'admin-set-user-password', '--region', $Region, '--user-pool-id', $poolId, '--username', $AdminEmail, '--password', $plainPassword, '--permanent')
    Run 'aws' @('cognito-idp', 'admin-add-user-to-group', '--region', $Region, '--user-pool-id', $poolId, '--username', $AdminEmail, '--group-name', 'admins')
    $plainPassword = $null
  }

  Step '部署後驗證'
  foreach ($s in @($foundation, $execution, $scheduling, $control, $frontend)) { Verify-Stack $s }
  $resources = (Capture 'aws' @('cloudformation', 'list-stack-resources', '--region', $Region, '--stack-name', $execution, '--output', 'json')) | ConvertFrom-Json
  $taskDefs = @($resources.StackResourceSummaries | Where-Object { $_.ResourceType -eq 'AWS::ECS::TaskDefinition' })
  if ($taskDefs.Count -lt 2) { Fail 'Execution stack 找不到兩個 runner task definitions' }
  foreach ($td in $taskDefs) {
    $images = (Capture 'aws' @('ecs', 'describe-task-definition', '--region', $Region, '--task-definition', [string]$td.PhysicalResourceId, '--query', 'taskDefinition.containerDefinitions[].image', '--output', 'text')) -split '\s+'
    foreach ($image in $images) {
      if ($image -and -not $image.EndsWith(":$SourceSha")) { Fail "ECS task definition 仍未鎖定 SHA:$image" }
      if ($image) { Write-Host "  OK ECS image $image" -ForegroundColor Green }
    }
  }
  $frontOut = Stack-Outputs $frontend
  $siteUrl = Output-Containing $frontOut 'SiteUrl'
  if (-not $siteUrl) { Fail 'Frontend stack 沒有 SiteUrl output' }
  $siteOk = $false
  for ($i = 0; $i -lt 12; $i++) {
    try {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri $siteUrl -TimeoutSec 30
      if ($resp.StatusCode -eq 200 -and $resp.Content -match 'id=["'']root["'']') { $siteOk = $true; break }
    } catch { }
    Start-Sleep -Seconds 10
  }
  if (-not $siteOk) { Fail "CloudFront 尚未回傳新版網站:$siteUrl" }
  Write-Host "  OK $siteUrl" -ForegroundColor Green

  $manifest = [ordered]@{
    repository = $RepositoryUrl; branch = $Branch; sha = $SourceSha
    account = $account; region = $Region; stage = $Stage
    explorationDigest = $digests['playagent-exploration-runner']
    webDigest = $digests['playagent-web-runner']
    siteUrl = $siteUrl; deployedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $manifestJson = $manifest | ConvertTo-Json -Compress
  Run 'aws' @('ssm', 'put-parameter', '--region', $Region, '--name', "/playagent/$prefix/deployed-version", '--type', 'String', '--overwrite', '--value', $manifestJson)
  $localDir = Join-Path $HOME '.playagent\deployments'
  New-Item -ItemType Directory -Force -Path $localDir | Out-Null
  [IO.File]::WriteAllText((Join-Path $localDir "$account-$Stage.json"), ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

  Write-Host ''
  Write-Host '========================================' -ForegroundColor Green
  Write-Host ' PlayAgent 最新版部署完成' -ForegroundColor Green
  Write-Host " SHA : $SourceSha"
  Write-Host " URL : $siteUrl"
  Write-Host " Log : $logFile"
  Write-Host '========================================' -ForegroundColor Green
} catch {
  Write-Host "`n部署失敗:$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Log:$logFile" -ForegroundColor Yellow
  exit 1
} finally {
  try { Stop-Transcript | Out-Null } catch { }
}
