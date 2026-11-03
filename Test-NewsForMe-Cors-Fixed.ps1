param(
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$WebBaseUrl = "http://127.0.0.1:5173",
    [string]$ApiBaseUrl = "http://127.0.0.1:8787",
    [int]$TimeoutMilliseconds = 5000
)

$ErrorActionPreference = "Stop"

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host ("=" * 72) -ForegroundColor DarkCyan
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ("=" * 72) -ForegroundColor DarkCyan
}

function Get-Origin {
    param([string]$BaseUrl)
    return ([System.Uri]$BaseUrl).GetLeftPart([System.UriPartial]::Authority).TrimEnd('/')
}

function Invoke-HttpProbe {
    param(
        [ValidateSet("GET", "OPTIONS")]
        [string]$Method,
        [string]$Uri,
        [string]$Origin,
        [int]$Timeout = 5000
    )

    $request = [System.Net.HttpWebRequest]::Create($Uri)
    $request.Method = $Method
    $request.Timeout = $Timeout
    $request.ReadWriteTimeout = $Timeout
    $request.AllowAutoRedirect = $false
    $request.KeepAlive = $false

    if ($Origin) {
        $request.Headers.Add("Origin", $Origin)
    }

    if ($Method -eq "OPTIONS") {
        $request.Headers.Add("Access-Control-Request-Method", "POST")
        $request.Headers.Add("Access-Control-Request-Headers", "content-type")
    }

    $response = $null
    $statusCode = $null
    $statusDescription = ""
    $allowOrigin = ""
    $allowMethods = ""
    $allowHeaders = ""
    $bodyText = ""
    $errorText = ""

    try {
        $response = [System.Net.HttpWebResponse]$request.GetResponse()
    }
    catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $response = [System.Net.HttpWebResponse]$_.Exception.Response
        }
        else {
            $errorText = $_.Exception.Message
        }
    }
    catch {
        $errorText = $_.Exception.Message
    }

    if ($response) {
        try {
            $statusCode = [int]$response.StatusCode
            $statusDescription = $response.StatusDescription
            $allowOrigin = [string]$response.Headers["Access-Control-Allow-Origin"]
            $allowMethods = [string]$response.Headers["Access-Control-Allow-Methods"]
            $allowHeaders = [string]$response.Headers["Access-Control-Allow-Headers"]

            $stream = $response.GetResponseStream()
            if ($stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                $bodyText = $reader.ReadToEnd()
                $reader.Dispose()
            }
        }
        catch {
            $errorText = $_.Exception.Message
        }
        finally {
            $response.Dispose()
        }
    }

    [PSCustomObject]@{
        Method = $Method
        Uri = $Uri
        Origin = $Origin
        StatusCode = $statusCode
        Status = $statusDescription
        AllowOrigin = $allowOrigin
        AllowMethods = $allowMethods
        AllowHeaders = $allowHeaders
        Body = $bodyText
        Error = $errorText
    }
}

function Test-CorsPreflight {
    param(
        [string]$Label,
        [string]$BaseUrl,
        [string]$Path,
        [string]$Origin
    )

    $target = $BaseUrl.TrimEnd('/') + $Path
    $result = Invoke-HttpProbe -Method OPTIONS -Uri $target -Origin $Origin -Timeout $TimeoutMilliseconds

    $originMatches = ($result.AllowOrigin -eq $Origin)
    $methodAllowed = ($result.AllowMethods -match '(?i)(^|,\s*)POST(\s*,|$)') -or ($result.AllowMethods -eq '*')
    $headerAllowed = ($result.AllowHeaders -match '(?i)(^|,\s*)content-type(\s*,|$)') -or ($result.AllowHeaders -eq '*')
    $passed = ($result.StatusCode -eq 204) -and $originMatches -and $methodAllowed -and $headerAllowed

    $color = if ($passed) { "Green" } else { "Red" }
    $statusText = if ($null -eq $result.StatusCode) { "NO RESPONSE" } else { [string]$result.StatusCode }
    Write-Host ("[{0}] {1} OPTIONS {2} -> {3}" -f $(if ($passed) { "PASS" } else { "FAIL" }), $Label, $Path, $statusText) -ForegroundColor $color
    Write-Host ("       Origin sent : {0}" -f $Origin) -ForegroundColor DarkGray
    Write-Host ("       ACAO        : {0}" -f $(if ($result.AllowOrigin) { $result.AllowOrigin } else { "(missing)" })) -ForegroundColor DarkGray
    Write-Host ("       Methods     : {0}" -f $(if ($result.AllowMethods) { $result.AllowMethods } else { "(missing)" })) -ForegroundColor DarkGray
    Write-Host ("       Headers     : {0}" -f $(if ($result.AllowHeaders) { $result.AllowHeaders } else { "(missing)" })) -ForegroundColor DarkGray
    if ($result.Error) {
        Write-Host ("       Error       : {0}" -f $result.Error) -ForegroundColor Yellow
    }

    [PSCustomObject]@{
        Label = $Label
        Path = $Path
        Origin = $Origin
        Passed = $passed
        StatusCode = $result.StatusCode
        AllowOrigin = $result.AllowOrigin
        Error = $result.Error
    }
}

function Test-ReadOnlyGet {
    param(
        [string]$Label,
        [string]$BaseUrl,
        [string]$Path,
        [string]$Origin
    )

    $target = $BaseUrl.TrimEnd('/') + $Path
    $result = Invoke-HttpProbe -Method GET -Uri $target -Origin $Origin -Timeout $TimeoutMilliseconds
    $passed = ($null -ne $result.StatusCode) -and ($result.StatusCode -ge 200) -and ($result.StatusCode -lt 300)
    $color = if ($passed) { "Green" } else { "Yellow" }
    $statusText = if ($null -eq $result.StatusCode) { "NO RESPONSE" } else { [string]$result.StatusCode }

    Write-Host ("[{0}] {1} GET {2} -> {3}" -f $(if ($passed) { "PASS" } else { "CHECK" }), $Label, $Path, $statusText) -ForegroundColor $color
    if ($result.Error) {
        Write-Host ("       Error: {0}" -f $result.Error) -ForegroundColor Yellow
    }
    elseif (-not $passed -and $result.Body) {
        $preview = $result.Body.Replace("`r", " ").Replace("`n", " ")
        if ($preview.Length -gt 180) { $preview = $preview.Substring(0, 180) + "..." }
        Write-Host ("       Response: {0}" -f $preview) -ForegroundColor DarkGray
    }

    [PSCustomObject]@{
        Label = $Label
        Path = $Path
        Passed = $passed
        StatusCode = $result.StatusCode
        Error = $result.Error
    }
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$workerConfig = Join-Path $ProjectRoot "apps\worker\wrangler.jsonc"

Write-Section "News-for-me local API / CORS diagnostic"
Write-Host "Project : $ProjectRoot"
Write-Host "Web     : $WebBaseUrl"
Write-Host "Worker  : $ApiBaseUrl"
Write-Host ""
Write-Host "This script is READ-ONLY. It does not create tags, save articles, or modify D1." -ForegroundColor Green

$configuredOriginValue = $null
if (Test-Path -LiteralPath $workerConfig) {
    $configText = Get-Content -LiteralPath $workerConfig -Raw -Encoding UTF8
    $match = [regex]::Match($configText, '"ALLOWED_ORIGIN"\s*:\s*"([^"]+)"')
    if ($match.Success) {
        $configuredOriginValue = $match.Groups[1].Value
    }
}

if (-not $configuredOriginValue) {
    $configuredOriginValue = "http://127.0.0.1:5173"
}

# ALLOWED_ORIGIN may contain a comma-separated allowlist. Each HTTP Origin
# header must contain exactly ONE origin, so split it before probing.
$configuredOrigins = @($configuredOriginValue -split ',' | ForEach-Object { $_.Trim().TrimEnd('/') } | Where-Object { $_ })
$webOrigin = Get-Origin -BaseUrl $WebBaseUrl
$candidateOrigins = @($configuredOrigins + $webOrigin + "http://127.0.0.1:5173" + "http://localhost:5173") |
    Where-Object { $_ } |
    Select-Object -Unique

Write-Section "1. Worker configuration"
Write-Host ("ALLOWED_ORIGIN in wrangler.jsonc: {0}" -f $configuredOriginValue) -ForegroundColor Cyan
Write-Host ("Allowed origins parsed            : {0}" -f ($configuredOrigins -join ", ")) -ForegroundColor Cyan
Write-Host ("Origin inferred from WebBaseUrl   : {0}" -f $webOrigin) -ForegroundColor Cyan
if ($configuredOrigins -contains $webOrigin) {
    Write-Host "Configured allowlist contains the supplied web URL origin." -ForegroundColor Green
}
else {
    Write-Host "Configured allowlist DOES NOT contain the supplied web URL origin." -ForegroundColor Yellow
}

Write-Section "2. TCP port checks"
$portChecks = @(
    [PSCustomObject]@{ Name = "Vite web"; Host = ([System.Uri]$WebBaseUrl).Host; Port = ([System.Uri]$WebBaseUrl).Port },
    [PSCustomObject]@{ Name = "Cloudflare Worker"; Host = ([System.Uri]$ApiBaseUrl).Host; Port = ([System.Uri]$ApiBaseUrl).Port }
)
$portsOk = $true
foreach ($port in $portChecks) {
    $reachable = $false
    try {
        $reachable = Test-NetConnection -ComputerName $port.Host -Port $port.Port -InformationLevel Quiet -WarningAction SilentlyContinue
    }
    catch {
        $reachable = $false
    }
    $color = if ($reachable) { "Green" } else { "Red" }
    Write-Host ("[{0}] {1} {2}:{3}" -f $(if ($reachable) { "OPEN" } else { "CLOSED" }), $port.Name, $port.Host, $port.Port) -ForegroundColor $color
    if (-not $reachable) { $portsOk = $false }
}

if (-not $portsOk) {
    Write-Host "`nStart both local servers before running the checks again:" -ForegroundColor Yellow
    Write-Host "  Terminal 1: Set-Location '$ProjectRoot'; npm run dev:api"
    Write-Host "  Terminal 2: Set-Location '$ProjectRoot'; npm run dev:web"
    exit 2
}

Write-Section "3. CORS preflight tests"
$preflightPaths = @(
    "/api/tags",
    "/api/topics/__topic_id__/articles/__article_id__/scrap"
)
$preflightResults = @()

foreach ($origin in $candidateOrigins) {
    foreach ($path in $preflightPaths) {
        $preflightResults += Test-CorsPreflight -Label "Worker direct" -BaseUrl $ApiBaseUrl -Path $path -Origin $origin
        $preflightResults += Test-CorsPreflight -Label "Vite proxy" -BaseUrl $WebBaseUrl -Path $path -Origin $origin
    }
}

Write-Section "4. Read-only API smoke tests"
$readResults = @()
$readResults += Test-ReadOnlyGet -Label "Vite proxy" -BaseUrl $WebBaseUrl -Path "/api/health" -Origin $webOrigin
$readResults += Test-ReadOnlyGet -Label "Vite proxy" -BaseUrl $WebBaseUrl -Path "/api/tags" -Origin $webOrigin
$readResults += Test-ReadOnlyGet -Label "Vite proxy" -BaseUrl $WebBaseUrl -Path "/api/scraps" -Origin $webOrigin

Write-Section "5. Summary"
$passedPreflights = @($preflightResults | Where-Object { $_.Passed }).Count
$totalPreflights = $preflightResults.Count
$failedPreflights = @($preflightResults | Where-Object { -not $_.Passed })
$failedReads = @($readResults | Where-Object { -not $_.Passed })

Write-Host ("CORS preflight: {0}/{1} passed" -f $passedPreflights, $totalPreflights) -ForegroundColor $(if ($passedPreflights -eq $totalPreflights) { "Green" } else { "Yellow" })
Write-Host ("Read-only GET : {0}/{1} returned 2xx" -f (@($readResults | Where-Object { $_.Passed }).Count), $readResults.Count) -ForegroundColor Cyan

if ($failedPreflights.Count -gt 0) {
    Write-Host "`nCORS failures:" -ForegroundColor Red
    $failedPreflights | Format-Table Label, Path, Origin, StatusCode, AllowOrigin -AutoSize
}

if (-not ($configuredOrigins -contains $webOrigin)) {
    Write-Host "`nLIKELY CAUSE: the page origin is missing from the Worker ALLOWED_ORIGIN allowlist." -ForegroundColor Yellow
    Write-Host ("Add this exact origin to ALLOWED_ORIGIN: {0}" -f $webOrigin) -ForegroundColor Yellow
    Write-Host "Then restart Wrangler." -ForegroundColor Yellow
}
elseif ($failedPreflights.Count -eq 0) {
    Write-Host "`nCORS preflight passed for all tested origins and paths." -ForegroundColor Green
    Write-Host "If POST still returns 403, inspect the exact Origin header and Worker logs for the request." -ForegroundColor Yellow
}
else {
    Write-Host "`nCORS failed for one or more individual origins. Use the AllowOrigin column above to identify the mismatch." -ForegroundColor Yellow
}

if ($failedReads.Count -gt 0) {
    Write-Host "`nSome read-only API requests did not return 2xx. A 401/403/404 here may be an endpoint/auth issue rather than a CORS preflight issue." -ForegroundColor Yellow
}

Write-Host "`nNo data was written or deleted." -ForegroundColor Green
