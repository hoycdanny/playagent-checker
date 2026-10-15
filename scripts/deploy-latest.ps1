[CmdletBinding()]
param(
  # kept for compatibility; ignored (the installer deploys this folder, it never fetches a newer version)
  [string]$RepositoryUrl = '',
  [string]$Branch = '',
  [string]$Region = 'us-west-2',
  [string]$Stage = 'dev',
  [string]$Profile = '',
  [string]$ExpectedAccountId = '',
  [string]$CdkContext = '',
  [string]$AdminEmail = '',
  [string]$AdminTenant = 'default',
  [switch]$AdminPasswordStdin,
  [switch]$AdminInvite,
  [switch]$SkipTests,
  [switch]$SkipBootstrap,
  [switch]$ForceBootstrap,
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
  '--region', $Region,
  '--stage', $Stage
)
if ($Profile) { $argsList += @('--profile', $Profile) }
if ($ExpectedAccountId) { $argsList += @('--expected-account-id', $ExpectedAccountId) }
foreach ($c in ($CdkContext -split ';')) { if ($c.Trim()) { $argsList += @('--context', $c.Trim()) } }
if ($AdminEmail) { $argsList += @('--admin-email', $AdminEmail) }
if ($AdminTenant -and $AdminTenant -ne 'default') { $argsList += @('--admin-tenant', $AdminTenant) }
if ($AdminPasswordStdin) { $argsList += '--admin-password-stdin' }
if ($AdminInvite) { $argsList += '--admin-invite' }
if ($SkipTests) { $argsList += '--skip-tests' }
if ($SkipBootstrap) { $argsList += '--skip-bootstrap' }
if ($ForceBootstrap) { $argsList += '--force-bootstrap' }
if ($PlanOnly) { $argsList += '--plan-only' }
if ($NonInteractive) { $argsList += '--non-interactive' }
& node @argsList
exit $LASTEXITCODE
