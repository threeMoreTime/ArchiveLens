param(
  [Parameter(Mandatory = $true)][string]$CandidateSha,
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$WorktreePath = (Resolve-Path "$PSScriptRoot/..").Path,
  [string]$EngineAppInfo = "$PSScriptRoot/..\dist\engine\win-x64\app.info.json",
  [string]$DesktopAppInfo = "$PSScriptRoot\..\apps\desktop\release\win-unpacked\resources\app.info.json",
  [string]$ManifestPath = "$PSScriptRoot\..\apps\desktop\release\release-manifest.json",
  [string]$EngineExe = "$PSScriptRoot\..\dist\engine\win-x64\archivelens-engine.exe",
  [string]$DesktopExe = "$PSScriptRoot\..\apps\desktop\release\win-unpacked\ArchiveLens.exe",
  [string]$BundledEngineExe = "$PSScriptRoot\..\apps\desktop\release\win-unpacked\resources\engine\win-x64\archivelens-engine.exe",
  [string]$SetupExe,
  [string]$PortableExe,
  [string]$SetupEngineExe,
  [string]$PortableEngineExe
)

$ErrorActionPreference = "Stop"

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

[pscustomobject]@{
  candidate_sha = $CandidateSha
  version = $Version
  clean_worktree_head = $head
  engine_sha256 = $engineSha
  desktop_sha256 = $desktopSha
  bundled_engine_sha256 = $bundledEngineSha
  manifest = $manifestResolved
} | ConvertTo-Json -Depth 4
