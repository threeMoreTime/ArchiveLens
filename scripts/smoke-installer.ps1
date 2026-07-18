# ArchiveLens NSIS install/uninstall smoke with task-owned paths and evidence.
param(
  [string]$Version = "0.1.0-alpha.11",
  [string]$CandidateSha = "",
  [string]$Setup = "",
  [string]$EvidenceJson = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "release-smoke-evidence.ps1")

if ([string]::IsNullOrWhiteSpace($CandidateSha)) {
  $CandidateSha = (git -C $repoRoot rev-parse HEAD).Trim()
}
if ([string]::IsNullOrWhiteSpace($Setup)) {
  $Setup = Join-Path $repoRoot "apps\desktop\release\ArchiveLens-$Version-x64-setup.exe"
}
$Setup = (Resolve-Path -LiteralPath $Setup).Path
if ([string]::IsNullOrWhiteSpace($EvidenceJson)) {
  $EvidenceJson = Join-Path $repoRoot "apps\desktop\release\setup-smoke-evidence.json"
}

$rawRunId = if ($env:ARCHIVELENS_TEST_RUN_ID) {
  $env:ARCHIVELENS_TEST_RUN_ID
}
else {
  "{0}-{1}" -f $CandidateSha.Substring(0, 12), ([guid]::NewGuid().ToString("N").Substring(0, 8))
}
$runId = $rawRunId -replace "[^A-Za-z0-9._-]", "-"
$ownedPrefix = "archivelens-setup-smoke-"
$ownedRoot = Assert-ReleaseSmokeOwnedRoot `
  (Join-Path ([IO.Path]::GetTempPath()) "$ownedPrefix$runId") `
  $ownedPrefix
$installDir = Join-Path $ownedRoot "app"
$userData = Join-Path $ownedRoot "user-data"
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\ArchiveLens.lnk"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "ArchiveLens.lnk"
$uninstaller = Join-Path $installDir "Uninstall ArchiveLens.exe"
$appProcess = $null
$failure = $null
$uninstallStatus = "NOT_RUN"
$processCleanupStatus = "NOT_RUN"
$resourceEvidence = $null
$shortcutsOwned = $false

$evidence = [ordered]@{
  status = "RUNNING"
  kind = "setup"
  started_at = (Get-Date).ToUniversalTime().ToString("o")
  candidate_sha = $CandidateSha
  version = $Version
  setup = $Setup
  smoke_root = $ownedRoot
  resource_evidence = $null
  application_ready = $false
  process_cleanup = $processCleanupStatus
  uninstall = $uninstallStatus
  error = $null
}

try {
  if (Test-Path -LiteralPath $startMenu) {
    throw "Existing ArchiveLens start-menu shortcut detected; refusing to overwrite user state: $startMenu"
  }
  if (Test-Path -LiteralPath $desktopShortcut) {
    throw "Existing ArchiveLens desktop shortcut detected; refusing to overwrite user state: $desktopShortcut"
  }
  $existingInstall = @(
    Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
      ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
      Where-Object {
        $displayName = $_.PSObject.Properties["DisplayName"]
        $displayName -and [string]$displayName.Value -eq "ArchiveLens"
      }
  )
  if ($existingInstall.Count -gt 0) {
    throw "Existing per-user ArchiveLens installation detected; run installer smoke in an isolated Windows account or VM."
  }

  Remove-ReleaseSmokeOwnedRoot $ownedRoot $ownedPrefix
  New-Item -ItemType Directory -Force -Path $ownedRoot | Out-Null
  [IO.File]::WriteAllText(
    (Join-Path $ownedRoot ".archivelens-test-owned"),
    $runId + [Environment]::NewLine,
    (New-Object Text.UTF8Encoding($false))
  )

  Write-Host ("[INFO] Silent install to task-owned path: {0}" -f $installDir)
  $installerProcess = Start-Process `
    -FilePath $Setup `
    -ArgumentList "/S", "/D=$installDir" `
    -Wait `
    -PassThru `
    -WindowStyle Hidden
  if ($installerProcess.ExitCode -ne 0) {
    throw "Installer exited with code $($installerProcess.ExitCode)"
  }
  $shortcutsOwned = $true

  $exe = Join-Path $installDir "ArchiveLens.exe"
  $resourcesRoot = Join-Path $installDir "resources"
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Install failed: missing $exe"
  }
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "Install failed: missing $uninstaller"
  }
  Write-Host "[PASS] Installer created the application and uninstaller"

  $resourceEvidence = Get-ReleaseSmokeResourceEvidence `
    $repoRoot `
    $resourcesRoot `
    $CandidateSha `
    $Version `
    $Setup
  $evidence.resource_evidence = $resourceEvidence
  Write-Host "[PASS] Installed resources passed license and offline-native checks"

  $previousUserData = $env:ARCHIVELENS_USER_DATA_DIR
  $env:ARCHIVELENS_USER_DATA_DIR = $userData
  try {
    $appProcess = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
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
  for ($attempt = 0; $attempt -lt 45; $attempt += 1) {
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
    throw "Installed application did not become ready: $logFile"
  }
  $evidence.application_ready = $true
  Write-Host "[PASS] Installed application started and Sidecar became ready"

  Stop-ReleaseSmokeProcessTree $appProcess.Id
  $appProcess = $null
  $processCleanupStatus = "PASS"
  $evidence.process_cleanup = $processCleanupStatus

  $uninstallProcess = Start-Process `
    -FilePath $uninstaller `
    -ArgumentList "/S" `
    -Wait `
    -PassThru `
    -WindowStyle Hidden
  if ($uninstallProcess.ExitCode -ne 0) {
    throw "Uninstaller exited with code $($uninstallProcess.ExitCode)"
  }
  for ($attempt = 0; $attempt -lt 80 -and (Test-Path -LiteralPath $exe); $attempt += 1) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $exe) {
    throw "Uninstall did not remove program files: $exe"
  }
  if (Test-Path -LiteralPath $startMenu) {
    throw "Uninstall did not remove start-menu shortcut: $startMenu"
  }
  if (Test-Path -LiteralPath $desktopShortcut) {
    throw "Uninstall did not remove desktop shortcut: $desktopShortcut"
  }
  $residual = @(
    Get-CimInstance Win32_Process |
      Where-Object {
        $_.ExecutablePath -and
        ([string]$_.ExecutablePath).StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase)
      }
  )
  if ($residual.Count -gt 0) {
    throw "Installed process remains after uninstall: $($residual.ProcessId -join ',')"
  }
  $uninstallStatus = "PASS"
  $evidence.uninstall = $uninstallStatus
  $evidence.status = "PASS"
  Write-Host "[PASS] Uninstall removed program files, shortcuts, and task-owned processes"
}
catch {
  $failure = $_
  $evidence.status = "FAIL"
  $evidence.error = $_.Exception.Message
}
finally {
  if ($appProcess) {
    try {
      Stop-ReleaseSmokeProcessTree $appProcess.Id
      $evidence.process_cleanup = "PASS"
    }
    catch {
      $evidence.process_cleanup = "FAIL"
      if (-not $failure) { $failure = $_ }
    }
  }
  if (Test-Path -LiteralPath $uninstaller) {
    try {
      Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
    }
    catch {
      if (-not $failure) { $failure = $_ }
    }
  }
  if ($shortcutsOwned) {
    foreach ($shortcut in @($startMenu, $desktopShortcut)) {
      if (Test-Path -LiteralPath $shortcut) {
        Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
      }
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
  Write-Error ("[FAIL] Installer smoke failed: {0}" -f $failure.Exception.Message)
  exit 1
}

Write-Host ("[PASS] Installer smoke evidence: {0}" -f $EvidenceJson)
