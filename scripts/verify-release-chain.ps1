param(
  [Parameter(Mandatory = $true)][string]$CandidateSha,
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$WorktreePath = "",
  [string]$EngineAppInfo = "",
  [string]$DesktopAppInfo = "",
  [string]$ManifestPath = "",
  [string]$EngineExe = "",
  [string]$DesktopExe = "",
  [string]$BundledEngineExe = "",
  [string]$NativeRoot = "",
  [string]$BundledResourcesRoot = "",
  [string]$SetupExe,
  [string]$PortableExe,
  [string]$SetupEngineExe,
  [string]$PortableEngineExe,
  [string]$SetupResourcesRoot,
  [string]$PortableResourcesRoot,
  [string]$SetupEvidenceJson,
  [string]$PortableEvidenceJson,
  [switch]$RequireCompleteCandidate
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($WorktreePath)) { $WorktreePath = $repoRoot }
if ([string]::IsNullOrWhiteSpace($EngineAppInfo)) { $EngineAppInfo = Join-Path $repoRoot "dist\engine\win-x64\app.info.json" }
if ([string]::IsNullOrWhiteSpace($DesktopAppInfo)) { $DesktopAppInfo = Join-Path $repoRoot "apps\desktop\release\win-unpacked\resources\app.info.json" }
if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $ManifestPath = Join-Path $repoRoot "apps\desktop\release\release-manifest.json" }
if ([string]::IsNullOrWhiteSpace($EngineExe)) { $EngineExe = Join-Path $repoRoot "dist\engine\win-x64\archivelens-engine.exe" }
if ([string]::IsNullOrWhiteSpace($DesktopExe)) { $DesktopExe = Join-Path $repoRoot "apps\desktop\release\win-unpacked\ArchiveLens.exe" }
if ([string]::IsNullOrWhiteSpace($BundledEngineExe)) { $BundledEngineExe = Join-Path $repoRoot "apps\desktop\release\win-unpacked\resources\engine\win-x64\archivelens-engine.exe" }
if ([string]::IsNullOrWhiteSpace($NativeRoot)) { $NativeRoot = Join-Path $repoRoot "dist\native\win-x64" }
if ([string]::IsNullOrWhiteSpace($BundledResourcesRoot)) { $BundledResourcesRoot = Join-Path $repoRoot "apps\desktop\release\win-unpacked\resources" }

function Fail([string]$Code, [string]$Message) {
  Write-Error ("[FAIL] {0} {1}" -f $Code, $Message)
  exit 1
}

function Resolve-OptionalPath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return $null }
  if (-not (Test-Path $PathValue)) { return $null }
  return (Resolve-Path $PathValue).Path
}

function Read-Json([string]$PathValue) {
  return Get-Content $PathValue -Raw | ConvertFrom-Json
}

function Get-Sha256([string]$PathValue) {
  return (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TreeSha256([string]$PathValue) {
  $lines = Get-ChildItem -LiteralPath $PathValue -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($PathValue.Length).TrimStart('\').Replace('\', '/').ToLowerInvariant()
    "{0}`t{1}" -f $relative, (Get-Sha256 $_.FullName)
  } | Sort-Object
  $payload = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n") + "`n")
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ($sha.ComputeHash($payload) | ForEach-Object { $_.ToString("x2") }) -join ""
  }
  finally {
    $sha.Dispose()
  }
}

function Assert-SmokeEvidence(
  [string]$EvidencePath,
  [string]$Kind,
  [string]$ExpectedArtifactSha,
  [string]$ExpectedEngineSha,
  [hashtable]$ExpectedNativeHashes
) {
  $resolved = Resolve-OptionalPath $EvidencePath
  if (-not $resolved) {
    Fail "RELEASE_SMOKE_EVIDENCE_MISSING" ('Missing {0} smoke evidence: {1}' -f $Kind, $EvidencePath)
  }
  $evidence = Read-Json $resolved
  if ($evidence.status -ne "PASS" -or $evidence.kind -ne $Kind) {
    Fail "RELEASE_SMOKE_EVIDENCE_INVALID" ('{0} smoke did not pass: {1}' -f $Kind, ($evidence | ConvertTo-Json -Compress -Depth 8))
  }
  if ($evidence.candidate_sha -ne $CandidateSha -or $evidence.version -ne $Version) {
    Fail "RELEASE_SMOKE_EVIDENCE_INVALID" ('{0} smoke candidate/version mismatch' -f $Kind)
  }
  $resource = $evidence.resource_evidence
  if (-not $resource) {
    Fail "RELEASE_SMOKE_EVIDENCE_INVALID" ('{0} smoke is missing resource evidence' -f $Kind)
  }
  if ($resource.artifact_sha256 -ne $ExpectedArtifactSha) {
    Fail "RELEASE_ARTIFACT_HASH_MISMATCH" ('{0} smoke artifact SHA mismatch' -f $Kind)
  }
  if ($resource.engine_sha256 -ne $ExpectedEngineSha) {
    Fail "RELEASE_ARTIFACT_HASH_MISMATCH" ('{0} embedded Engine SHA mismatch' -f $Kind)
  }
  if (
    $resource.native_tesseract_tree_sha256 -ne $ExpectedNativeHashes["tesseract"] -or
    $resource.native_djvulibre_tree_sha256 -ne $ExpectedNativeHashes["djvulibre"]
  ) {
    Fail "RELEASE_NATIVE_HASH_MISMATCH" ('{0} native runtime evidence mismatch' -f $Kind)
  }
  if ($resource.license_gate_status -ne "PASS" -or $resource.offline_native_status -ne "PASS") {
    Fail "RELEASE_SMOKE_EVIDENCE_INVALID" ('{0} packaged license/offline-native evidence did not pass' -f $Kind)
  }
  if ($evidence.application_ready -ne $true -or $evidence.process_cleanup -ne "PASS") {
    Fail "RELEASE_SMOKE_EVIDENCE_INVALID" ('{0} startup/process cleanup evidence did not pass' -f $Kind)
  }
  if ($Kind -eq "setup" -and $evidence.uninstall -ne "PASS") {
    Fail "RELEASE_SMOKE_EVIDENCE_INVALID" "Setup uninstall evidence did not pass"
  }
  if ($Kind -eq "portable" -and $evidence.extraction_cleanup -ne "PASS") {
    Fail "RELEASE_SMOKE_EVIDENCE_INVALID" "Portable extraction cleanup evidence did not pass"
  }
  return $resolved
}

function Assert-NativeRuntime([string]$RootPath, [bool]$PackagedLayout, [string]$Label, [object]$ManifestPayload) {
  $resolved = Resolve-OptionalPath $RootPath
  if (-not $resolved) { Fail "RELEASE_NATIVE_MISSING" ('Missing {0} native root: {1}' -f $Label, $RootPath) }
  $nativeBase = if ($PackagedLayout) { Join-Path $resolved "native" } else { $resolved }
  $lockPath = Join-Path $resolved "native-dependencies.lock.json"
  $licensesRoot = Join-Path $resolved "licenses"
  $sourcesRoot = Join-Path $resolved "sources"
  foreach ($required in @(
    $lockPath,
    (Join-Path $nativeBase "tesseract\tesseract.exe"),
    (Join-Path $nativeBase "tesseract\tessdata\chi_sim.traineddata"),
    (Join-Path $nativeBase "tesseract\tessdata\chi_tra.traineddata"),
    (Join-Path $nativeBase "tesseract\tessdata\chi_sim_vert.traineddata"),
    (Join-Path $nativeBase "tesseract\tessdata\chi_tra_vert.traineddata"),
    (Join-Path $nativeBase "djvulibre\ddjvu.exe"),
    (Join-Path $nativeBase "djvulibre\djvused.exe"),
    (Join-Path $licensesRoot "Tesseract\LICENSE.txt"),
    (Join-Path $licensesRoot "Tesseract-Windows-Build\AUTHORS.txt"),
    (Join-Path $licensesRoot "Tesseract-Windows-Build\BUILD-README.md"),
    (Join-Path $licensesRoot "tessdata_fast\LICENSE.txt"),
    (Join-Path $licensesRoot "DjVuLibre\COPYING.txt")
  )) {
    if (-not (Test-Path -LiteralPath $required)) { Fail "RELEASE_NATIVE_MISSING" ('{0} is missing {1}' -f $Label, $required) }
  }
  if ((Get-Sha256 $lockPath) -ne $ManifestPayload.native_lock_sha256) {
    Fail "RELEASE_NATIVE_HASH_MISMATCH" ('{0} native lock hash mismatch' -f $Label)
  }
  $hashes = @{}
  foreach ($componentName in @("tesseract", "djvulibre")) {
    $component = $ManifestPayload.native_dependencies | Where-Object { $_.name -eq $componentName } | Select-Object -First 1
    if (-not $component) { Fail "RELEASE_NATIVE_MANIFEST_INVALID" ('Manifest missing native component: {0}' -f $componentName) }
    $componentRoot = Join-Path $nativeBase $componentName
    $treeHash = Get-TreeSha256 $componentRoot
    if ($treeHash -ne $component.runtime_tree_sha256) {
      Fail "RELEASE_NATIVE_HASH_MISMATCH" ('{0} {1} tree mismatch' -f $Label, $componentName)
    }
    foreach ($file in $component.runtime_files) {
      $filePath = Join-Path $componentRoot ([string]$file.path).Replace('/', '\')
      if (-not (Test-Path -LiteralPath $filePath) -or (Get-Sha256 $filePath) -ne $file.sha256) {
        Fail "RELEASE_NATIVE_HASH_MISMATCH" ('{0} {1} file mismatch: {2}' -f $Label, $componentName, $file.path)
      }
    }
    $hashes[$componentName] = $treeHash
  }
  foreach ($component in $ManifestPayload.native_dependencies) {
    foreach ($notice in $component.license_files) {
      $noticePath = Join-Path $licensesRoot ([string]$notice.path).Replace('/', '\')
      if (-not (Test-Path -LiteralPath $noticePath) -or (Get-Sha256 $noticePath) -ne $notice.sha256) {
        Fail "RELEASE_NATIVE_HASH_MISMATCH" ('{0} license file mismatch: {1}' -f $Label, $notice.path)
      }
    }
  }
  $djvu = $ManifestPayload.native_dependencies | Where-Object { $_.name -eq "djvulibre" } | Select-Object -First 1
  $sourcePath = Join-Path $sourcesRoot "djvulibre\djvulibre-3.5.29.tar.gz"
  if (-not (Test-Path -LiteralPath $sourcePath) -or (Get-Sha256 $sourcePath) -ne $djvu.corresponding_source_sha256) {
    Fail "RELEASE_NATIVE_HASH_MISMATCH" ('{0} DjVuLibre corresponding source mismatch' -f $Label)
  }
  return $hashes
}

$head = (git -C $WorktreePath rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { Fail "RELEASE_COMMIT_MISMATCH" ('Failed to resolve HEAD for worktree "{0}"' -f $WorktreePath) }
if ($head -ne $CandidateSha) { Fail "RELEASE_COMMIT_MISMATCH" ('HEAD mismatch: actual="{0}" expected="{1}"' -f $head, $CandidateSha) }

$status = git -C $WorktreePath status --porcelain
if ($LASTEXITCODE -ne 0) { Fail "RELEASE_SOURCE_DIRTY" "Failed to inspect worktree status" }
if (-not [string]::IsNullOrWhiteSpace(($status | Out-String))) {
  Fail "RELEASE_SOURCE_DIRTY" ('Worktree is not clean: {0}' -f (($status | Out-String).Trim()))
}

$engineInfoPath = Resolve-OptionalPath $EngineAppInfo
$desktopInfoPath = Resolve-OptionalPath $DesktopAppInfo
$manifestResolved = Resolve-OptionalPath $ManifestPath
if (-not $engineInfoPath) { Fail "RELEASE_COMMIT_MISMATCH" ('Missing Engine app.info: {0}' -f $EngineAppInfo) }
if (-not $desktopInfoPath) { Fail "RELEASE_COMMIT_MISMATCH" ('Missing Desktop app.info: {0}' -f $DesktopAppInfo) }
if (-not $manifestResolved) { Fail "RELEASE_COMMIT_MISMATCH" ('Missing manifest: {0}' -f $ManifestPath) }

$engineInfo = Read-Json $engineInfoPath
$desktopInfo = Read-Json $desktopInfoPath
$manifest = Read-Json $manifestResolved

foreach ($payload in @($engineInfo, $desktopInfo, $manifest)) {
  if ($payload.git_commit -ne $CandidateSha) {
    Fail "RELEASE_COMMIT_MISMATCH" ('git_commit mismatch: {0}' -f ($payload | ConvertTo-Json -Compress))
  }
  if ($payload.version -ne $Version) {
    Fail "RELEASE_VERSION_MISMATCH" ('version mismatch: actual="{0}" expected="{1}"' -f $payload.version, $Version)
  }
}

if ($RequireCompleteCandidate) {
  foreach ($requiredInput in @(
    @{ Name = "SetupExe"; Value = $SetupExe },
    @{ Name = "PortableExe"; Value = $PortableExe },
    @{ Name = "SetupEvidenceJson"; Value = $SetupEvidenceJson },
    @{ Name = "PortableEvidenceJson"; Value = $PortableEvidenceJson }
  )) {
    if ([string]::IsNullOrWhiteSpace([string]$requiredInput.Value)) {
      Fail "RELEASE_COMPLETE_CANDIDATE_REQUIRED" ('Missing complete-candidate input: {0}' -f $requiredInput.Name)
    }
  }
  if (-not $manifest.setup_sha256 -or -not $manifest.portable_sha256) {
    Fail "RELEASE_COMPLETE_CANDIDATE_REQUIRED" "Manifest is missing Setup or Portable hashes"
  }
  $testSummary = $manifest.test_summary
  if (
    -not $testSummary -or
    $testSummary.schema_version -ne 1 -or
    $testSummary.candidate_sha -ne $CandidateSha -or
    $testSummary.scope -ne "local-zero-cost-non-release" -or
    $testSummary.monetary_cost -ne 0 -or
    $testSummary.formal_release_action -ne "NOT_PERFORMED"
  ) {
    Fail "RELEASE_TEST_SUMMARY_INVALID" "Manifest test summary does not describe the frozen zero-cost non-release candidate"
  }
  $failedSteps = @($testSummary.steps | Where-Object { $_.status -ne "PASS" })
  if ($failedSteps.Count -gt 0) {
    Fail "RELEASE_TEST_SUMMARY_INVALID" ('Manifest test summary contains non-passing steps: {0}' -f (($failedSteps | ConvertTo-Json -Compress -Depth 6)))
  }
}

if (-not $manifest.native_dependencies -or -not $manifest.native_lock_sha256) {
  Fail "RELEASE_NATIVE_MANIFEST_INVALID" "Manifest does not contain locked native dependency evidence"
}
$cleanNativeHashes = Assert-NativeRuntime $NativeRoot $false "clean" $manifest
$bundledNativeHashes = Assert-NativeRuntime $BundledResourcesRoot $true "win-unpacked" $manifest
foreach ($name in @("tesseract", "djvulibre")) {
  if ($cleanNativeHashes[$name] -ne $bundledNativeHashes[$name]) {
    Fail "RELEASE_NATIVE_HASH_MISMATCH" ('Clean and win-unpacked {0} hashes differ' -f $name)
  }
}
if (-not [string]::IsNullOrWhiteSpace($SetupResourcesRoot)) {
  [void](Assert-NativeRuntime $SetupResourcesRoot $true "setup" $manifest)
}
if (-not [string]::IsNullOrWhiteSpace($PortableResourcesRoot)) {
  [void](Assert-NativeRuntime $PortableResourcesRoot $true "portable" $manifest)
}

$engineExeResolved = Resolve-OptionalPath $EngineExe
$desktopExeResolved = Resolve-OptionalPath $DesktopExe
$bundledEngineResolved = Resolve-OptionalPath $BundledEngineExe
if (-not $engineExeResolved) { Fail "RELEASE_ARTIFACT_HASH_MISMATCH" ('Missing Engine EXE: {0}' -f $EngineExe) }
if (-not $desktopExeResolved) { Fail "RELEASE_ARTIFACT_HASH_MISMATCH" ('Missing Desktop EXE: {0}' -f $DesktopExe) }
if (-not $bundledEngineResolved) { Fail "RELEASE_ARTIFACT_HASH_MISMATCH" ('Missing bundled Engine EXE: {0}' -f $BundledEngineExe) }

$engineSha = Get-Sha256 $engineExeResolved
$desktopSha = Get-Sha256 $desktopExeResolved
$bundledEngineSha = Get-Sha256 $bundledEngineResolved

if ($manifest.engine_sha256 -ne $engineSha) { Fail "RELEASE_ARTIFACT_HASH_MISMATCH" "manifest engine_sha256 mismatch" }
if ($manifest.desktop_sha256 -ne $desktopSha) { Fail "RELEASE_ARTIFACT_HASH_MISMATCH" "manifest desktop_sha256 mismatch" }
if ($engineSha -ne $bundledEngineSha) { Fail "RELEASE_ARTIFACT_HASH_MISMATCH" "Clean Engine SHA does not match win-unpacked bundled Engine SHA" }

$optionalArtifacts = @(
  @{ Path = (Resolve-OptionalPath $SetupExe); Key = "setup_sha256" },
  @{ Path = (Resolve-OptionalPath $PortableExe); Key = "portable_sha256" },
  @{ Path = (Resolve-OptionalPath $SetupEngineExe); Key = "setup_engine_sha256" },
  @{ Path = (Resolve-OptionalPath $PortableEngineExe); Key = "portable_engine_sha256" }
)
foreach ($artifact in $optionalArtifacts) {
  if (-not $artifact.Path) { continue }
  $sha = Get-Sha256 $artifact.Path
  if ($artifact.Key -in @("setup_sha256", "portable_sha256")) {
    if ($manifest.($artifact.Key) -ne $sha) {
      Fail "RELEASE_ARTIFACT_HASH_MISMATCH" ('{0} mismatch' -f $artifact.Key)
    }
  }
  else {
    if ($sha -ne $engineSha) {
      Fail "RELEASE_ARTIFACT_HASH_MISMATCH" ('{0} does not match clean Engine SHA' -f $artifact.Key)
    }
  }
}

$setupEvidenceResolved = $null
$portableEvidenceResolved = $null
if (-not [string]::IsNullOrWhiteSpace($SetupEvidenceJson)) {
  if (-not $manifest.setup_sha256) { Fail "RELEASE_SMOKE_EVIDENCE_INVALID" "Manifest is missing setup_sha256" }
  $setupEvidenceResolved = Assert-SmokeEvidence `
    $SetupEvidenceJson `
    "setup" `
    $manifest.setup_sha256 `
    $engineSha `
    $cleanNativeHashes
}
if (-not [string]::IsNullOrWhiteSpace($PortableEvidenceJson)) {
  if (-not $manifest.portable_sha256) { Fail "RELEASE_SMOKE_EVIDENCE_INVALID" "Manifest is missing portable_sha256" }
  $portableEvidenceResolved = Assert-SmokeEvidence `
    $PortableEvidenceJson `
    "portable" `
    $manifest.portable_sha256 `
    $engineSha `
    $cleanNativeHashes
}

[pscustomobject]@{
  candidate_sha = $CandidateSha
  version = $Version
  clean_worktree_head = $head
  engine_sha256 = $engineSha
  desktop_sha256 = $desktopSha
  bundled_engine_sha256 = $bundledEngineSha
  native_tesseract_tree_sha256 = $cleanNativeHashes["tesseract"]
  native_djvulibre_tree_sha256 = $cleanNativeHashes["djvulibre"]
  manifest = $manifestResolved
  setup_smoke_evidence = $setupEvidenceResolved
  portable_smoke_evidence = $portableEvidenceResolved
} | ConvertTo-Json -Depth 4
