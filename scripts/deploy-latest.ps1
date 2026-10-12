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
  [switch]$NonInteractive
)

# Backward-compatible Windows wrapper. All deployment logic lives in deploy-latest.mjs,
# shared by Windows, macOS and Linux so the platforms cannot drift apart.
$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host '找不到 Node.js 22+: https://nodejs.org/' -ForegroundColor Red; exit 1 }
$argsList = @(
  (Join-Path $PSScriptRoot 'deploy-latest.mjs'),
  '--repository-url', $RepositoryUrl,
  '--branch', $Branch,
  '--region', $Region,
  '--stage', $Stage,
  '--admin-password-env', $AdminPasswordEnv
)
if ($Profile) { $argsList += @('--profile', $Profile) }
if ($ExpectedAccountId) { $argsList += @('--expected-account-id', $ExpectedAccountId) }
foreach ($c in ($CdkContext -split ';')) { if ($c.Trim()) { $argsList += @('--context', $c.Trim()) } }
if ($AdminEmail) { $argsList += @('--admin-email', $AdminEmail) }
if ($AdminTenant) { $argsList += @('--admin-tenant', $AdminTenant) }
if ($SkipTests) { $argsList += '--skip-tests' }
if ($SkipBootstrap) { $argsList += '--skip-bootstrap' }
if ($PlanOnly) { $argsList += '--plan-only' }
if ($NonInteractive) { $argsList += '--non-interactive' }
& node @argsList
exit $LASTEXITCODE
