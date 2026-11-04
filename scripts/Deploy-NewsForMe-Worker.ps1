[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$workerDirectory = Join-Path $repositoryRoot "apps\worker"
$configPath = Join-Path $workerDirectory "wrangler.jsonc"

if (-not (Test-Path -LiteralPath $configPath)) {
    throw "Worker config not found: $configPath"
}

try {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
} catch {
    throw "Could not parse apps/worker/wrangler.jsonc: $($_.Exception.Message)"
}

$dbBindings = @($config.d1_databases | Where-Object { $_.binding -eq "DB" })
if ($dbBindings.Count -ne 1) {
    throw "Expected exactly one D1 binding named DB in wrangler.jsonc."
}

$dbName = [string]$dbBindings[0].database_name
$dbId = [string]$dbBindings[0].database_id
if ([string]::IsNullOrWhiteSpace($dbName) -or [string]::IsNullOrWhiteSpace($dbId)) {
    throw "D1 binding DB must have database_name and database_id configured."
}

Write-Host ""
Write-Host "News for Me Worker deployment" -ForegroundColor Cyan
Write-Host "D1 database name : $dbName"
Write-Host "D1 database ID   : $dbId"
Write-Host "This script exports the remote DB, applies pending migrations, verifies user_integrations, then deploys the Worker."
Write-Host ""

$startConfirmation = Read-Host "계속하려면 DEPLOY-WORKER 입력"
if ($startConfirmation -cne "DEPLOY-WORKER") {
    Write-Host "취소했습니다. 원격 D1과 Worker는 변경되지 않았습니다." -ForegroundColor Yellow
    return
}

$backupDirectory = Join-Path $repositoryRoot ".local-backups"
New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = Join-Path $backupDirectory "news-for-me-before-migrations-$timestamp.sql"

Push-Location $workerDirectory
try {
    Write-Host ""
    Write-Host "[1/5] Remote D1 backup" -ForegroundColor Cyan
    & npx wrangler d1 export $dbName --remote --output $backupPath
    if ($LASTEXITCODE -ne 0) {
        throw "Remote D1 export failed. No migration or deployment was attempted."
    }
    if (-not (Test-Path -LiteralPath $backupPath)) {
        throw "D1 export reported success, but the backup file was not found: $backupPath"
    }
    Write-Host "Backup saved: $backupPath" -ForegroundColor Green

    Write-Host ""
    Write-Host "[2/5] Current remote D1 migration state" -ForegroundColor Cyan
    & npx wrangler d1 migrations list $dbName --remote
    if ($LASTEXITCODE -ne 0) {
        throw "Could not list remote D1 migrations. No migration or deployment was attempted."
    }

    Write-Host ""
    Write-Host "위 목록에서 0001~0006이 이미 적용되었고 0007_user_integrations.sql만 대기 중인지 확인하세요."
    $migrationConfirmation = Read-Host "확인했다면 APPLY-PENDING 입력"
    if ($migrationConfirmation -cne "APPLY-PENDING") {
        throw "Migration was not confirmed. No migration or deployment was attempted."
    }

    Write-Host ""
    Write-Host "[3/5] Apply pending remote D1 migrations" -ForegroundColor Cyan
    & npx wrangler d1 migrations apply $dbName --remote
    if ($LASTEXITCODE -ne 0) {
        throw "Remote D1 migration failed. Worker deployment was stopped."
    }

    Write-Host ""
    Write-Host "[4/5] Verify user_integrations exists" -ForegroundColor Cyan
    $verificationOutput = & npx wrangler d1 execute $dbName --remote --command "SELECT CASE WHEN EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_integrations') THEN 'READY' ELSE 'MISSING' END AS integration_schema;"
    $verificationExitCode = $LASTEXITCODE
    $verificationText = $verificationOutput | Out-String
    Write-Host $verificationText
    if ($verificationExitCode -ne 0 -or $verificationText -notmatch "\bREADY\b") {
        throw "user_integrations was not found in the configured remote D1. Worker deployment was stopped."
    }

    Write-Host ""
    Write-Host "[5/5] Deploy Worker" -ForegroundColor Cyan
    & npx wrangler deploy
    if ($LASTEXITCODE -ne 0) {
        throw "Worker deployment failed. The D1 migration and backup were retained."
    }

    Write-Host ""
    Write-Host "Worker deployed successfully. D1 backup: $backupPath" -ForegroundColor Green
} finally {
    Pop-Location
}
