# ArchiveLens Portable smoke with task-owned user data and packaged evidence.
param(
  [string]$Version = "0.1.0-alpha.11",
  [string]$CandidateSha = "",
  [string]$Portable = "",
  [string]$EvidenceJson = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "release-smoke-evidence.ps1")

if ([string]::IsNullOrWhiteSpace($CandidateSha)) {
  $CandidateSha = (git -C $repoRoot rev-parse HEAD).Trim()
}
if ([string]::IsNullOrWhiteSpace($Portable)) {
  $Portable = Join-Path $repoRoot "apps\desktop\release\ArchiveLens-$Version-x64-portable.exe"
}
$Portable = (Resolve-Path -LiteralPath $Portable).Path
if ([string]::IsNullOrWhiteSpace($EvidenceJson)) {
  $EvidenceJson = Join-Path $repoRoot "apps\desktop\release\portable-smoke-evidence.json"
}

$rawRunId = if ($env:ARCHIVELENS_TEST_RUN_ID) {
  $env:ARCHIVELENS_TEST_RUN_ID
}
else {
  "{0}-{1}" -f $CandidateSha.Substring(0, 12), ([guid]::NewGuid().ToString("N").Substring(0, 8))
}
$runId = $rawRunId -replace "[^A-Za-z0-9._-]", "-"
$ownedPrefix = "archivelens-portable-smoke-"
$ownedRoot = Assert-ReleaseSmokeOwnedRoot `
  (Join-Path ([IO.Path]::GetTempPath()) "$ownedPrefix$runId") `
  $ownedPrefix
$userData = Join-Path $ownedRoot "user-data"
$wrapperProcess = $null
$appProcessId = 0
$appDirectory = $null
$failure = $null

$evidence = [ordered]@{
  status = "RUNNING"
  kind = "portable"
  started_at = (Get-Date).ToUniversalTime().ToString("o")
  candidate_sha = $CandidateSha
  version = $Version
  portable = $Portable
  smoke_root = $ownedRoot
  extracted_app = $null
  resource_evidence = $null
  application_ready = $false
  process_cleanup = "NOT_RUN"
  extraction_cleanup = "NOT_RUN"
  extraction_cleanup_mode = "NOT_RUN"
  error = $null
}

try {
  Remove-ReleaseSmokeOwnedRoot $ownedRoot $ownedPrefix
  New-Item -ItemType Directory -Force -Path $ownedRoot | Out-Null
  [IO.File]::WriteAllText(
    (Join-Path $ownedRoot ".archivelens-test-owned"),
    $runId + [Environment]::NewLine,
    (New-Object Text.UTF8Encoding($false))
  )

  Write-Host ("[INFO] Launch portable wrapper: {0}" -f $Portable)
  $previousUserData = $env:ARCHIVELENS_USER_DATA_DIR
  $env:ARCHIVELENS_USER_DATA_DIR = $userData
  try {
    $wrapperProcess = Start-Process -FilePath $Portable -PassThru -WindowStyle Hidden
  }
  finally {
    if ($null -eq $previousUserData) {
      Remove-Item Env:ARCHIVELENS_USER_DATA_DIR -ErrorAction SilentlyContinue
    }
    else {
      $env:ARCHIVELENS_USER_DATA_DIR = $previousUserData
    }
  }

  $logFile = Join-Path $userData "logs\app.log"
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    Start-Sleep -Seconds 1
    if (Test-Path -LiteralPath $logFile) {
      $content = Get-Content -LiteralPath $logFile -Raw -ErrorAction SilentlyContinue
      if ($content -match "Sidecar 就绪" -and $content -match "主窗口已创建") {
        $ready = $true
        break
      }
    }
  }
  if (-not $ready) {
    throw "Portable application did not become ready: $logFile"
  }
  $evidence.application_ready = $true

  $descendants = @(Get-ReleaseSmokeDescendants $wrapperProcess.Id)
  $appProcess = $descendants |
    Where-Object {
      $_.ExecutablePath -and
      (Split-Path -Leaf ([string]$_.ExecutablePath)) -eq "ArchiveLens.exe" -and
      -not ([string]$_.ExecutablePath).Equals($Portable, [StringComparison]::OrdinalIgnoreCase)
    } |
    Select-Object -First 1
  if (-not $appProcess) {
    throw "Unable to identify the task-owned extracted ArchiveLens process under portable wrapper pid=$($wrapperProcess.Id)"
  }
  $appProcessId = [int]$appProcess.ProcessId
  $appDirectory = Split-Path -Parent ([string]$appProcess.ExecutablePath)
  $resourcesRoot = Join-Path $appDirectory "resources"
  $evidence.extracted_app = [string]$appProcess.ExecutablePath

  $resourceEvidence = Get-ReleaseSmokeResourceEvidence `
    $repoRoot `
    $resourcesRoot `
    $CandidateSha `
    $Version `
    $Portable
  $evidence.resource_evidence = $resourceEvidence
  Write-Host "[PASS] Portable resources passed license and offline-native checks"

  Stop-ReleaseSmokeProcessTree $appProcessId
  $appProcessId = 0
  if (-not $wrapperProcess.WaitForExit(30000)) {
    Stop-ReleaseSmokeProcessTree $wrapperProcess.Id
  }
  $wrapperProcess = $null
  $evidence.process_cleanup = "PASS"

  $extractedExe = Join-Path $appDirectory "ArchiveLens.exe"
  for ($attempt = 0; $attempt -lt 80 -and (Test-Path -LiteralPath $extractedExe); $attempt += 1) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $extractedExe) {
    Remove-ReleaseSmokePortableExtraction $appDirectory $resourceEvidence.desktop_sha256
    $evidence.extraction_cleanup_mode = "GATE_OWNED_DIRECTORY"
  }
  else {
    $evidence.extraction_cleanup_mode = "WRAPPER"
  }
  $evidence.extraction_cleanup = "PASS"
  $evidence.status = "PASS"
  Write-Host "[PASS] Portable wrapper exited without task-owned residual processes or extraction"
}
catch {
  $failure = $_
  $evidence.status = "FAIL"
  $evidence.error = $_.Exception.Message
}
finally {
  if ($appProcessId -gt 0) {
    try {
      Stop-ReleaseSmokeProcessTree $appProcessId
    }
    catch {
      if (-not $failure) { $failure = $_ }
    }
  }
  if ($wrapperProcess) {
    try {
      Stop-ReleaseSmokeProcessTree $wrapperProcess.Id
    }
    catch {
      if (-not $failure) { $failure = $_ }
    }
  }
  if (
    $appDirectory -and
    (Test-Path -LiteralPath $appDirectory -PathType Container) -and
    $resourceEvidence -and
    $resourceEvidence.desktop_sha256
  ) {
    try {
      Remove-ReleaseSmokePortableExtraction $appDirectory $resourceEvidence.desktop_sha256
      $evidence.extraction_cleanup = "PASS"
      $evidence.extraction_cleanup_mode = "GATE_OWNED_DIRECTORY"
    }
    catch {
      if (-not $failure) { $failure = $_ }
    }
  }
  try {
    Remove-ReleaseSmokeOwnedRoot $ownedRoot $ownedPrefix
  }
  catch {
    if (-not $failure) { $failure = $_ }
  }
  if ($failure) {
    $evidence.status = "FAIL"
    $evidence.error = $failure.Exception.Message
  }
  $evidence.completed_at = (Get-Date).ToUniversalTime().ToString("o")
  Write-ReleaseSmokeJson $EvidenceJson $evidence
}

if ($failure) {
  Write-Error ("[FAIL] Portable smoke failed: {0}" -f $failure.Exception.Message)
  exit 1
}

Write-Host ("[PASS] Portable smoke evidence: {0}" -f $EvidenceJson)
