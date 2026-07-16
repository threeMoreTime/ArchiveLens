param(
  [string]$CandidateSha = "",
  [string]$EvidenceRoot = "",
  [switch]$OfflineNative
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "release-smoke-evidence.ps1")

function Resolve-RequiredCommand([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) {
    throw "Required command is unavailable: $Name"
  }
  return $command.Source
}

function Get-SafeStepName([string]$Name) {
  return ($Name.ToLowerInvariant() -replace "[^a-z0-9._-]", "-").Trim("-")
}

function Assert-PathInsideRepo([string]$PathValue) {
  $resolved = [IO.Path]::GetFullPath($PathValue)
  $prefix = $repoRoot.TrimEnd("\") + "\"
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Release-gate evidence must stay inside the repository: $resolved"
  }
  return $resolved
}

function Remove-GeneratedCandidateArtifact([string]$PathValue, [string]$ReleaseRoot) {
  if (-not (Test-Path -LiteralPath $PathValue)) { return }
  $resolved = [IO.Path]::GetFullPath($PathValue)
  $releasePrefix = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd("\") + "\"
  if (-not $resolved.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a generated artifact outside the release directory: $resolved"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Invoke-GateStep(
  [string]$Name,
  [string]$Command,
  [string[]]$Arguments
) {
  $started = Get-Date
  $safeName = Get-SafeStepName $Name
  $logPath = Join-Path $script:LogsRoot ("{0:d2}-{1}.log" -f ($script:Steps.Count + 1), $safeName)
  Write-Host ("[RUN] {0}" -f $Name)
  $exitCode = 1
  try {
    & $Command @Arguments 2>&1 | Tee-Object -FilePath $logPath
    $exitCode = $LASTEXITCODE
  }
  catch {
    $message = $_.Exception.Message
    [IO.File]::AppendAllText($logPath, $message + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    throw
  }
  finally {
    $completed = Get-Date
    $record = [ordered]@{
      name = $Name
      status = if ($exitCode -eq 0) { "PASS" } else { "FAIL" }
      exit_code = $exitCode
      started_at = $started.ToUniversalTime().ToString("o")
      completed_at = $completed.ToUniversalTime().ToString("o")
      duration_seconds = [math]::Round(($completed - $started).TotalSeconds, 3)
      log = $logPath
    }
    $script:Steps.Add([pscustomobject]$record)
  }
  if ($exitCode -ne 0) {
    throw "Release-gate step failed: $Name (exit=$exitCode, log=$logPath)"
  }
  Write-Host ("[PASS] {0}" -f $Name)
}

function Invoke-PublicLicenseBoundary(
  [string]$PythonExe,
  [string]$ResourcesRoot,
  [string]$FrozenSha
) {
  $name = "public license approval boundary"
  $started = Get-Date
  $logPath = Join-Path $script:LogsRoot ("{0:d2}-public-license-approval-boundary.log" -f ($script:Steps.Count + 1))
  Write-Host ("[RUN] {0}" -f $name)
  $output = & $PythonExe @(
    "scripts/verify-license-compliance.py",
    "--mode", "packaged",
    "--resources-root", $ResourcesRoot,
    "--candidate-sha", $FrozenSha,
    "--require-public-approval"
  ) 2>&1
  $exitCode = $LASTEXITCODE
  $output | Tee-Object -FilePath $logPath | Out-Host
  try {
    $payload = (($output -join [Environment]::NewLine) | ConvertFrom-Json)
  }
  catch {
    throw "Public license boundary returned invalid JSON: $logPath"
  }

  $boundaryStatus = "UNKNOWN"
  if ($exitCode -eq 0 -and $payload.status -eq "PASS") {
    $boundaryStatus = "APPROVAL_PRESENT"
  }
  elseif ($exitCode -ne 0 -and $payload.status -eq "FAIL") {
    $nonApprovalFailures = @(
      $payload.failures |
        Where-Object { -not ([string]$_.code).StartsWith("PUBLIC_", [StringComparison]::Ordinal) }
    )
    if ($nonApprovalFailures.Count -gt 0) {
      throw "Public license boundary contains technical failures: $logPath"
    }
    $boundaryStatus = "BLOCKED_EXPECTED"
  }
  else {
    throw "Public license boundary produced an inconsistent result: exit=$exitCode status=$($payload.status)"
  }

  $completed = Get-Date
  $script:Steps.Add([pscustomobject][ordered]@{
    name = $name
    status = "PASS"
    exit_code = $exitCode
    started_at = $started.ToUniversalTime().ToString("o")
    completed_at = $completed.ToUniversalTime().ToString("o")
    duration_seconds = [math]::Round(($completed - $started).TotalSeconds, 3)
    log = $logPath
    outcome = $boundaryStatus
  })
  Write-Host ("[PASS] {0}: {1}" -f $name, $boundaryStatus)
  return [pscustomobject]@{
    status = $boundaryStatus
    result = $payload
    log = $logPath
  }
}

function Get-ManifestStepSummary {
  return @(
    $script:Steps | ForEach-Object {
      [ordered]@{
        name = $_.name
        status = $_.status
        exit_code = $_.exit_code
        duration_seconds = $_.duration_seconds
      }
    }
  )
}

function Save-GateSummary([string]$Status, [string]$ErrorMessage = "") {
  $stableBlockers = New-Object System.Collections.Generic.List[string]
  $stableBlockers.Add("formal release authorization is not provided")
  $stableBlockers.Add("cross-version upgrade and rollback are not verified with a prior trusted installer")
  if ($script:PublicLicenseStatus -ne "APPROVAL_PRESENT") {
    $stableBlockers.Add("public license approval must be granted for the frozen candidate before public distribution")
  }
  $summary = [ordered]@{
    schema_version = 1
    status = $Status
    scope = "local-zero-cost-non-release"
    candidate_sha = $script:FrozenSha
    version = $script:Version
    started_at = $script:GateStarted.ToUniversalTime().ToString("o")
    completed_at = (Get-Date).ToUniversalTime().ToString("o")
    monetary_cost = 0
    network_publication = "NOT_PERFORMED"
    formal_release_action = "NOT_PERFORMED"
    push = "NOT_PERFORMED"
    pull_request = "NOT_PERFORMED"
    merge = "NOT_PERFORMED"
    deployment = "NOT_PERFORMED"
    public_release_license_gate = $script:PublicLicenseStatus
    stable_public_release_status = "BLOCKED"
    stable_public_release_blockers = @($stableBlockers)
    upgrade_rollback_status = "NOT_VERIFIED"
    signature_policy = "Alpha accepts Valid or NotSigned artifacts; no paid signing service is used"
    signatures = $script:Signatures
    steps = @($script:Steps)
    evidence_root = $script:ResolvedEvidenceRoot
    release_manifest = $script:ManifestPath
    sha256sums = $script:Sha256SumsPath
    setup_smoke_evidence = $script:SetupEvidencePath
    portable_smoke_evidence = $script:PortableEvidencePath
    release_chain_evidence = $script:ReleaseChainPath
    error = if ([string]::IsNullOrWhiteSpace($ErrorMessage)) { $null } else { $ErrorMessage }
  }
  Write-ReleaseSmokeJson $script:GateSummaryPath $summary
}

$script:GateStarted = Get-Date
$script:Steps = New-Object System.Collections.Generic.List[object]
$script:PublicLicenseStatus = "NOT_RUN"
$script:Signatures = $null
$script:FrozenSha = ""
$script:Version = ""
$script:ResolvedEvidenceRoot = ""
$script:ManifestPath = ""
$script:Sha256SumsPath = ""
$script:SetupEvidencePath = ""
$script:PortableEvidencePath = ""
$script:ReleaseChainPath = ""
$script:GateSummaryPath = ""

$savedEnvironment = @{}
foreach ($name in @(
  "PYTHONUTF8",
  "PYTHONIOENCODING",
  "PYTHONPATH",
  "ARCHIVELENS_TEST_RUN_ID",
  "ARCHIVELENS_E2E_PYTHON",
  "ARCHIVELENS_HTML_SMOKE_MODE"
)) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

Push-Location $repoRoot
try {
  $head = (& git -C $repoRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $head -notmatch "^[0-9a-f]{40}$") {
    throw "Unable to freeze a full Git candidate SHA"
  }
  if (-not [string]::IsNullOrWhiteSpace($CandidateSha) -and $CandidateSha -ne $head) {
    throw "Requested candidate SHA does not match HEAD: requested=$CandidateSha head=$head"
  }
  $script:FrozenSha = $head

  $status = git -C $repoRoot status --porcelain
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect worktree status"
  }
  if (-not [string]::IsNullOrWhiteSpace(($status | Out-String))) {
    throw "Release gate requires a clean worktree before building the frozen candidate"
  }

  $rootPackage = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
  $desktopPackage = Get-Content -LiteralPath (Join-Path $repoRoot "apps\desktop\package.json") -Raw | ConvertFrom-Json
  if ($rootPackage.version -ne $desktopPackage.version) {
    throw "Root and desktop package versions differ"
  }
  $script:Version = [string]$rootPackage.version

  $timestamp = $script:GateStarted.ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  if ([string]::IsNullOrWhiteSpace($EvidenceRoot)) {
    $EvidenceRoot = Join-Path $repoRoot (".tmp\release-gate\{0}\{1}" -f $script:FrozenSha, $timestamp)
  }
  $script:ResolvedEvidenceRoot = Assert-PathInsideRepo $EvidenceRoot
  $script:LogsRoot = Join-Path $script:ResolvedEvidenceRoot "logs"
  New-Item -ItemType Directory -Force -Path $script:LogsRoot | Out-Null

  $script:GateSummaryPath = Join-Path $script:ResolvedEvidenceRoot "release-gate-summary.json"
  $testSummaryPath = Join-Path $script:ResolvedEvidenceRoot "test-summary.json"
  $script:SetupEvidencePath = Join-Path $script:ResolvedEvidenceRoot "setup-smoke-evidence.json"
  $script:PortableEvidencePath = Join-Path $script:ResolvedEvidenceRoot "portable-smoke-evidence.json"
  $script:ReleaseChainPath = Join-Path $script:ResolvedEvidenceRoot "verify-release-chain.json"

  $releaseDir = Join-Path $repoRoot "apps\desktop\release"
  $winUnpacked = Join-Path $releaseDir "win-unpacked"
  $setupExe = Join-Path $releaseDir ("ArchiveLens-{0}-x64-setup.exe" -f $script:Version)
  $portableExe = Join-Path $releaseDir ("ArchiveLens-{0}-x64-portable.exe" -f $script:Version)
  $script:ManifestPath = Join-Path $releaseDir "release-manifest.json"
  $script:Sha256SumsPath = Join-Path $releaseDir "SHA256SUMS.txt"

  foreach ($generatedPath in @(
    $winUnpacked,
    $setupExe,
    $portableExe,
    $script:ManifestPath,
    $script:Sha256SumsPath
  )) {
    Remove-GeneratedCandidateArtifact $generatedPath $releaseDir
  }

  $pnpmExe = Resolve-RequiredCommand "pnpm.cmd"
  $nodeExe = Resolve-RequiredCommand "node.exe"
  $powershellExe = Resolve-RequiredCommand "powershell.exe"
  $pythonExe = (& python -c "import sys; print(sys.executable)").Trim()
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pythonExe -PathType Leaf)) {
    throw "Unable to resolve the Python executable"
  }

  $nodeVersion = (& $nodeExe --version).Trim().TrimStart("v")
  if ([version]$nodeVersion -lt [version]"22.13.0") {
    throw "Node 22.13.0 or newer is required; actual=$nodeVersion"
  }
  $pythonVersion = (& $pythonExe -c "import platform; print(platform.python_version())").Trim()
  $pythonParts = $pythonVersion.Split(".")
  if ($pythonParts[0] -ne "3" -or $pythonParts[1] -ne "11") {
    throw "Python 3.11 is required; actual=$pythonVersion"
  }

  $runId = "release-{0}-{1}" -f $script:FrozenSha.Substring(0, 12), $timestamp
  $env:PYTHONUTF8 = "1"
  $env:PYTHONIOENCODING = "utf-8"
  $env:PYTHONPATH = "{0};{1}" -f (Join-Path $repoRoot "engine\src"), (Join-Path $repoRoot "engine")
  $env:ARCHIVELENS_TEST_RUN_ID = $runId
  $env:ARCHIVELENS_E2E_PYTHON = $pythonExe

  Invoke-GateStep "frozen dependency install" $pnpmExe @("install", "--frozen-lockfile")
  Invoke-GateStep "source license technical gate" $pythonExe @(
    "scripts/verify-license-compliance.py",
    "--mode", "source"
  )
  Invoke-GateStep "python engine test suite" $pythonExe @(
    "-m", "unittest", "discover",
    "-s", "engine/tests",
    "-t", "engine",
    "-v"
  )
  Invoke-GateStep "workspace typecheck" $pnpmExe @("typecheck")
  Invoke-GateStep "workspace lint" $pnpmExe @("lint")
  Invoke-GateStep "workspace unit tests" $pnpmExe @("test")
  Invoke-GateStep "desktop source build" $pnpmExe @("build")

  $nativeArguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $repoRoot "scripts\prepare-native-runtime.ps1")
  )
  if ($OfflineNative) {
    $nativeArguments += "-Offline"
  }
  Invoke-GateStep "locked native runtime preparation" $powershellExe $nativeArguments
  Invoke-GateStep "packaged engine build" $powershellExe @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $repoRoot "scripts\build-engine.ps1")
  )
  Invoke-GateStep "Setup and Portable build" $pnpmExe @(
    "--filter", "@archivelens/desktop",
    "exec", "electron-builder"
  )

  foreach ($artifact in @(
    (Join-Path $winUnpacked "ArchiveLens.exe"),
    $setupExe,
    $portableExe
  )) {
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
      throw "Expected candidate artifact is missing: $artifact"
    }
  }

  Invoke-GateStep "complete Playwright E2E suite" $pnpmExe @(
    "--filter", "@archivelens/desktop",
    "exec", "playwright", "test"
  )
  Invoke-GateStep "packaged license technical gate" $pythonExe @(
    "scripts/verify-license-compliance.py",
    "--mode", "packaged",
    "--resources-root", (Join-Path $winUnpacked "resources"),
    "--candidate-sha", $script:FrozenSha
  )
  Invoke-GateStep "bundled native offline smoke" $pythonExe @(
    "scripts/offline-native-smoke.py",
    "--resources-root", (Join-Path $winUnpacked "resources")
  )

  foreach ($caseId in @(
    "custom-single",
    "custom-double",
    "custom-multi",
    "custom-english",
    "custom-special",
    "custom-no-hit",
    "legacy-pair-simplified",
    "legacy-pair-traditional"
  )) {
    Invoke-GateStep ("packaged OCR smoke {0}" -f $caseId) $pythonExe @(
      "scripts/packaged-ocr-smoke.py",
      "--case-id", $caseId
    )
  }
  Invoke-GateStep "packaged inference shutdown smoke" $pythonExe @(
    "scripts/shutdown-inference-smoke.py"
  )
  $env:ARCHIVELENS_HTML_SMOKE_MODE = "packaged"
  Invoke-GateStep "packaged HTML export smoke" $pythonExe @(
    "scripts/html-smoke.py"
  )

  $publicBoundary = Invoke-PublicLicenseBoundary `
    $pythonExe `
    (Join-Path $winUnpacked "resources") `
    $script:FrozenSha
  $script:PublicLicenseStatus = $publicBoundary.status

  Invoke-GateStep "Setup install launch uninstall smoke" $powershellExe @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $repoRoot "scripts\smoke-installer.ps1"),
    "-Version", $script:Version,
    "-CandidateSha", $script:FrozenSha,
    "-Setup", $setupExe,
    "-EvidenceJson", $script:SetupEvidencePath
  )
  Invoke-GateStep "Portable launch cleanup smoke" $powershellExe @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $repoRoot "scripts\smoke-portable.ps1"),
    "-Version", $script:Version,
    "-CandidateSha", $script:FrozenSha,
    "-Portable", $portableExe,
    "-EvidenceJson", $script:PortableEvidencePath
  )

  $setupSignature = Get-AuthenticodeSignature -LiteralPath $setupExe
  $portableSignature = Get-AuthenticodeSignature -LiteralPath $portableExe
  foreach ($signature in @($setupSignature, $portableSignature)) {
    if ([string]$signature.Status -notin @("Valid", "NotSigned")) {
      throw "Candidate artifact has an unacceptable Authenticode status: $($signature.Path) status=$($signature.Status)"
    }
  }
  $script:Signatures = [ordered]@{
    setup = [ordered]@{
      status = [string]$setupSignature.Status
      status_message = [string]$setupSignature.StatusMessage
    }
    portable = [ordered]@{
      status = [string]$portableSignature.Status
      status_message = [string]$portableSignature.StatusMessage
    }
  }

  $testSummary = [ordered]@{
    schema_version = 1
    scope = "local-zero-cost-non-release"
    candidate_sha = $script:FrozenSha
    version = $script:Version
    monetary_cost = 0
    formal_release_action = "NOT_PERFORMED"
    public_release_license_gate = $script:PublicLicenseStatus
    upgrade_rollback_status = "NOT_VERIFIED"
    signatures = $script:Signatures
    steps = Get-ManifestStepSummary
  }
  Write-ReleaseSmokeJson $testSummaryPath $testSummary

  Invoke-GateStep "full release manifest generation" $pythonExe @(
    "scripts/generate-manifest.py",
    "--version", $script:Version,
    "--candidate-sha", $script:FrozenSha,
    "--setup", $setupExe,
    "--portable", $portableExe,
    "--test-summary-json", $testSummaryPath
  )
  Invoke-GateStep "complete same-SHA release chain verification" $powershellExe @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $repoRoot "scripts\verify-release-chain.ps1"),
    "-CandidateSha", $script:FrozenSha,
    "-Version", $script:Version,
    "-WorktreePath", $repoRoot,
    "-SetupExe", $setupExe,
    "-PortableExe", $portableExe,
    "-SetupEvidenceJson", $script:SetupEvidencePath,
    "-PortableEvidenceJson", $script:PortableEvidencePath,
    "-RequireCompleteCandidate"
  )
  Copy-Item -LiteralPath ($script:Steps[$script:Steps.Count - 1].log) -Destination $script:ReleaseChainPath -Force

  $finalStatus = git -C $repoRoot status --porcelain
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect final worktree status"
  }
  if (-not [string]::IsNullOrWhiteSpace(($finalStatus | Out-String))) {
    throw "Release gate changed tracked repository content"
  }

  Save-GateSummary "PASS"
  Write-Host ("[PASS] Zero-cost local candidate gate completed: {0}" -f $script:GateSummaryPath)
  Write-Host "[INFO] No push, pull request, merge, signing purchase, deployment, or release was performed."
  Write-Host "[INFO] Stable public release remains blocked by human approval and real cross-version upgrade/rollback evidence."
}
catch {
  $message = $_.Exception.Message
  if (-not [string]::IsNullOrWhiteSpace($script:GateSummaryPath)) {
    try {
      Save-GateSummary "FAIL" $message
    }
    catch {
      Write-Warning ("Unable to write failure summary: {0}" -f $_.Exception.Message)
    }
  }
  Write-Error ("[FAIL] Zero-cost release gate failed: {0}" -f $message)
  exit 1
}
finally {
  foreach ($name in $savedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process")
  }
  Pop-Location
}
