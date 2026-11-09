@echo off
rem ============================================================================
rem  PaeScape Realms - server launcher / supervisor
rem
rem  Verifies the installed server against the platform's current approved
rem  release, downloads and installs an update when required, checks the release
rem  again, then launches server.exe. The launcher stays alive as the supervisor:
rem  when the server asks for an update it re-checks the release, installs the
rem  new build and restarts the server. Auth failures and invalid signatures are
rem  terminal and are never retried in a loop.
rem
rem  Everything non-trivial is done in PowerShell (shipped with Windows), which
rem  verifies the release manifest's ECDSA P-256 signature with .NET. The batch
rem  file only extracts and runs the script below the markers, so the whole
rem  launcher is this one file.
rem
rem  Configuration (optional, via environment):
rem    PAESCAPE_PLATFORM_URL   override the platform origin
rem    PAESCAPE_CHANNEL        release channel (default: stable)
rem ============================================================================
setlocal enabledelayedexpansion
set "PAESCAPE_LAUNCHER_VERSION=2"
if not defined PAESCAPE_PLATFORM_URL set "PAESCAPE_PLATFORM_URL=https://paescape.online"
if not defined PAESCAPE_CHANNEL set "PAESCAPE_CHANNEL=stable"
set "PAESCAPE_SERVER_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $f='%~f0'; $t=[IO.File]::ReadAllText($f); $nl=[char]10; $a=$t.IndexOf($nl+'#:PS-START'); $b=$t.IndexOf($nl+'#:PS-END'); if($a -lt 0 -or $b -lt 0){ Write-Host 'Launcher payload is missing.' -ForegroundColor Red; exit 2 }; $code=$t.Substring($a+1,$b-$a-1); $tmp=Join-Path $env:TEMP ('paescape-launcher-' + [Guid]::NewGuid().ToString('N') + '.ps1'); [IO.File]::WriteAllText($tmp,$code); try { & powershell -NoProfile -ExecutionPolicy Bypass -File $tmp; exit $LASTEXITCODE } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }"

set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo The launcher stopped with error %RC%. Fix the problem above and run again.
  echo.
  if not defined PAESCAPE_NO_PAUSE pause
)
exit /b %RC%
#:PS-START
# ---------------------------------------------------------------------------
# PaeScape launcher body. Runs in Windows PowerShell 5.1. This is the supervisor:
# it verifies the current approved release with .NET cryptographic primitives,
# installs an update when one is needed, then launches server.exe and stays
# alive while it runs. When the server asks for an update (exit code 10) the
# supervisor re-checks the release, installs the new build and restarts it.
# Auth failures, config failures and invalid signatures are terminal: the
# supervisor never loops on them.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Exit codes shared with Server.ts and the PaeScape plugin. The server exits 10
# when it wants an update-and-restart; 11/12/13 are terminal failures.
$EXIT_NORMAL = 0
$EXIT_UPDATE_REQUIRED = 10
$EXIT_AUTH_FAILURE = 11
$EXIT_CONFIG_FAILURE = 12
$EXIT_FATAL = 13

$PlatformUrl = ($env:PAESCAPE_PLATFORM_URL).TrimEnd('/')
$Channel     = if ($env:PAESCAPE_CHANNEL) { $env:PAESCAPE_CHANNEL } else { 'stable' }
$Root        = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Root) { $Root = (Get-Location).Path }
# When extracted the script lives in %TEMP%; the server directory is %~dp0 of the
# batch, which is passed in through PAESCAPE_SERVER_DIR.
if ($env:PAESCAPE_SERVER_DIR) { $Root = $env:PAESCAPE_SERVER_DIR }
# Base seconds between supervisor restarts; scaled by the cycle number. Kept
# small by default so a host recovers quickly, and overridable for tests.
$UpdateBackoffBase = if ($env:PAESCAPE_UPDATE_BACKOFF_SECONDS) { [int]$env:PAESCAPE_UPDATE_BACKOFF_SECONDS } else { 5 }
$StateFile   = Join-Path $Root 'paescape-installed.json'
$ServerExe   = Join-Path $Root 'server.exe'

function Info($m)  { Write-Host "[launcher] $m" -ForegroundColor Cyan }
function Ok($m)    { Write-Host "[launcher] $m" -ForegroundColor Green }
function Warn2($m) { Write-Host "[launcher] $m" -ForegroundColor Yellow }
function Die($m, $code = 13) {
  Write-Host "[launcher] $m" -ForegroundColor Red
  exit $code
}

function Get-Installed {
  if (Test-Path -LiteralPath $StateFile) {
    try { return (Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json) } catch { return $null }
  }
  return $null
}

function Read-B64Url([string]$s) {
  $s = $s.Replace('-', '+').Replace('_', '/')
  switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } }
  return [Convert]::FromBase64String($s)
}

<#
 Verify the ECDSA P-256 (IEEE-P1363) signature over the canonical manifest
 payload using the public point the platform published. The manifest only
 verifies against its exact payload.
#>
function Test-ManifestSignature($Doc) {
  $payload = [Text.Encoding]::UTF8.GetBytes([string]$Doc.manifestPayload)
  $sig = [Convert]::FromBase64String([string]$Doc.releaseSignature)
  $q = New-Object System.Security.Cryptography.ECPoint
  $q.X = Read-B64Url ([string]$Doc.key.x)
  $q.Y = Read-B64Url ([string]$Doc.key.y)
  $p = New-Object System.Security.Cryptography.ECParameters
  $p.Curve = [System.Security.Cryptography.ECCurve+NamedCurves]::nistP256
  $p.Q = $q
  $ec = [System.Security.Cryptography.ECDsaCng]::new()
  $ec.ImportParameters($p)
  # IEEE-P1363 is the raw r||s form Node's crypto.sign(..., 'ieee-p1363') emits.
  return $ec.VerifyData($payload, $sig, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
}

function Get-LauncherDocument {
  $url = "$PlatformUrl/platform/api/releases/launcher?channel=$Channel"
  Info "checking for updates at $PlatformUrl"
  try {
    return Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 30 -UseBasicParsing
  } catch {
    throw "Could not reach the PaeScape release service. $($_.Exception.Message)"
  }
}

function Get-FileSha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
}

<#
 Install the current approved release if it is not already installed. Returns
 the generation now on disk. Every download is signature-checked, checksum-
 checked and installed with a rollback copy, so a failed update never leaves a
 broken server.exe behind. The loop re-queries the release after each install
 because another release may have become current while we were downloading.
#>
function Install-CurrentRelease {
  $attempts = 0
  while ($true) {
    $attempts++
    if ($attempts -gt 5) { throw "Too many update attempts; the release service kept changing. Try again later." }

    $doc = Get-LauncherDocument
    if (-not $doc.ok) { throw "The release service did not return a release document." }

    Info "verifying release $($doc.version) (generation $($doc.generation)) signature"
    if (-not (Test-ManifestSignature $doc)) {
      throw "The release manifest's signature did not verify. Refusing to continue."
    }
    Ok "signature verified"

    $installed = Get-Installed
    $installedGeneration = -1
    if ($installed -and $installed.generation -ne $null) { $installedGeneration = [int]$installed.generation }

    if ($installedGeneration -eq [int]$doc.generation -and (Test-Path -LiteralPath $ServerExe)) {
      # Confirm the bytes on disk still match the manifest before trusting them.
      if ($doc.entrySha256 -and ((Get-FileSha256 $ServerExe) -eq ([string]$doc.entrySha256).ToLower())) {
        Ok "installed release matches the current release (generation $($doc.generation))"
        return [int]$doc.generation
      }
      Warn2 "server.exe on disk does not match the current release; re-downloading"
    } elseif ($installedGeneration -eq [int]$doc.generation) {
      Warn2 "server.exe is missing; re-downloading"
    } else {
      Info "update required: generation $installedGeneration -> $($doc.generation)"
    }

    # --- Download the executable and verify its checksum before installing.
    $downloadUrl = "$PlatformUrl/platform/api/releases/download?channel=$Channel"
    $tempNew = Join-Path $Root 'server.exe.new'
    if (Test-Path -LiteralPath $tempNew) { Remove-Item -LiteralPath $tempNew -Force }
    Info "downloading server.exe"
    try {
      Invoke-WebRequest -Uri $downloadUrl -OutFile $tempNew -TimeoutSec 300 -UseBasicParsing
    } catch {
      if (Test-Path -LiteralPath $tempNew) { Remove-Item -LiteralPath $tempNew -Force }
      throw "Download failed. $($_.Exception.Message)"
    }
    $newHash = Get-FileSha256 $tempNew
    if ($doc.entrySha256 -and ($newHash -ne ([string]$doc.entrySha256).ToLower())) {
      Remove-Item -LiteralPath $tempNew -Force
      throw "The downloaded server.exe failed its checksum check. Refusing to install it."
    }
    Ok "checksum verified"

    # --- Safe replacement with rollback.
    $backup = Join-Path $Root 'server.exe.bak'
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    if (Test-Path -LiteralPath $ServerExe) {
      # If this fails, the executable is locked (the server is running).
      try { Move-Item -LiteralPath $ServerExe -Destination $backup -Force }
      catch { Remove-Item -LiteralPath $tempNew -Force; throw "server.exe is in use - close the running server and run this launcher again." }
    }
    try {
      Move-Item -LiteralPath $tempNew -Destination $ServerExe -Force
    } catch {
      if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $ServerExe -Force }
      throw "Could not install the update. The previous version has been restored."
    }
    $stateJson = @{ generation = [int]$doc.generation; version = [string]$doc.version; sha256 = $newHash; installedAt = (Get-Date).ToString('s') } | ConvertTo-Json
    # Write without a BOM: JSON.parse on other platforms rejects a leading BOM.
    [IO.File]::WriteAllText($StateFile, $stateJson, (New-Object System.Text.UTF8Encoding($false)))
    Ok "installed version $($doc.version) (generation $($doc.generation))"
  }
}

Info "PaeScape Realms server launcher"

# --- Supervisor loop: install/verify, launch, then interpret the exit code.
$updateCycles = 0
$fatalRetries = 0
while ($true) {
  try {
    $generation = Install-CurrentRelease
  } catch {
    # A bad signature or an unreachable release service is never retried.
    Die "Could not prepare the current release. $($_.Exception.Message)" $EXIT_FATAL
  }

  Info "starting server.exe (generation $generation); it authenticates with PaeScape Realms itself"
  Push-Location $Root
  try {
    & $ServerExe
    $code = $LASTEXITCODE
  } catch {
    $code = $EXIT_FATAL
    Warn2 "server.exe could not be started: $($_.Exception.Message)"
  } finally {
    Pop-Location
  }
  if ($code -eq $null) { $code = 0 }

  if ($code -eq $EXIT_NORMAL) {
    Ok "server stopped normally"
    exit $EXIT_NORMAL
  }

  if ($code -eq $EXIT_UPDATE_REQUIRED) {
    $updateCycles++
    if ($updateCycles -gt 5) {
      Die "The server asked for an update more than 5 times; stopping to avoid a restart loop." $EXIT_FATAL
    }
    $backoff = [Math]::Min(60, $UpdateBackoffBase * $updateCycles)
    Warn2 "server requested an update; re-checking the release in $backoff s"
    Start-Sleep -Seconds $backoff
    continue
  }

  if ($code -eq $EXIT_AUTH_FAILURE) {
    Die "The server could not authenticate with PaeScape. It will not restart automatically; fix the enrollment and run the launcher again." $EXIT_AUTH_FAILURE
  }
  if ($code -eq $EXIT_CONFIG_FAILURE) {
    Die "The server rejected its configuration. It will not restart automatically; fix the configuration and run the launcher again." $EXIT_CONFIG_FAILURE
  }
  if ($code -eq $EXIT_FATAL) {
    Die "The server stopped with a fatal error. It will not restart automatically." $EXIT_FATAL
  }

  # Unexpected exit: bounded restart with exponential backoff.
  $fatalRetries++
  if ($fatalRetries -gt 3) {
    Die "The server exited unexpectedly ($code) more than 3 times; stopping to avoid a restart loop." $EXIT_FATAL
  }
  $backoff = [Math]::Min(30, $UpdateBackoffBase * [Math]::Pow(2, $fatalRetries))
  Warn2 "server exited with code $code; restarting in $backoff s"
  Start-Sleep -Seconds $backoff
}
#:PS-END
