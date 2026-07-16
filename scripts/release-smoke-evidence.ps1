Set-StrictMode -Version Latest

function Get-ReleaseSmokeSha256([string]$PathValue) {
  return (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-ReleaseSmokeJson([string]$PathValue, [object]$Payload) {
  $parent = Split-Path -Parent $PathValue
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $json = $Payload | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText(
    [IO.Path]::GetFullPath($PathValue),
    $json + [Environment]::NewLine,
    (New-Object Text.UTF8Encoding($false))
  )
}

function Assert-ReleaseSmokeOwnedRoot([string]$PathValue, [string]$ExpectedPrefix) {
  $resolved = [IO.Path]::GetFullPath($PathValue).TrimEnd('\')
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $leaf = Split-Path -Leaf $resolved
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Smoke path is outside the system temp root: $resolved"
  }
  if (-not $leaf.StartsWith($ExpectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Smoke path does not use the expected ownership prefix: $resolved"
  }
  return $resolved
}

function Remove-ReleaseSmokeOwnedRoot([string]$PathValue, [string]$ExpectedPrefix) {
  $resolved = Assert-ReleaseSmokeOwnedRoot $PathValue $ExpectedPrefix
  if (Test-Path -LiteralPath $resolved) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

function Remove-ReleaseSmokePortableExtraction(
  [string]$PathValue,
  [string]$ExpectedDesktopSha256
) {
  $resolved = [IO.Path]::GetFullPath($PathValue).TrimEnd("\")
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd("\") + "\"
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Portable extraction is outside the system temp root: $resolved"
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { return }
  $rootItem = Get-Item -LiteralPath $resolved -Force
  if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Portable extraction root is a reparse point: $resolved"
  }
  $reparsePoints = @(
    Get-ChildItem -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
  )
  if ($reparsePoints.Count -gt 0) {
    throw "Portable extraction contains a reparse point: $($reparsePoints[0].FullName)"
  }
  $desktopExe = Join-Path $resolved "ArchiveLens.exe"
  if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf)) {
    throw "Portable extraction is missing ArchiveLens.exe: $resolved"
  }
  if ((Get-ReleaseSmokeSha256 $desktopExe) -ne $ExpectedDesktopSha256) {
    throw "Portable extraction desktop SHA mismatch: $desktopExe"
  }
  $residual = @(
    Get-CimInstance Win32_Process |
      Where-Object {
        $_.ExecutablePath -and
        ([string]$_.ExecutablePath).StartsWith($resolved, [StringComparison]::OrdinalIgnoreCase)
      }
  )
  if ($residual.Count -gt 0) {
    throw "Portable extraction still has running processes: $($residual.ProcessId -join ',')"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
  if (Test-Path -LiteralPath $resolved) {
    throw "Portable extraction cleanup did not remove: $resolved"
  }
}

function Invoke-ReleaseSmokeTaskkill([int]$ProcessId) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "SilentlyContinue"
    & "$env:SystemRoot\System32\taskkill.exe" /PID $ProcessId /T /F 2>&1 | Out-Null
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Stop-ReleaseSmokeProcessTree([int]$RootProcessId) {
  if ($RootProcessId -le 0) { return }
  $descendantIds = @(
    Get-ReleaseSmokeDescendants $RootProcessId |
      ForEach-Object { [int]$_.ProcessId }
  )
  $process = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
  if ($process) {
    Invoke-ReleaseSmokeTaskkill $RootProcessId
  }
  foreach ($descendantId in $descendantIds) {
    if (Get-Process -Id $descendantId -ErrorAction SilentlyContinue) {
      Invoke-ReleaseSmokeTaskkill $descendantId
    }
  }
  for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
    $candidateIds = @([int]$RootProcessId) + @($descendantIds)
    $remaining = @(
      $candidateIds |
        Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
    )
    if ($remaining.Count -eq 0) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "Task-owned process tree did not exit: root_pid=$RootProcessId"
}

function Get-ReleaseSmokeDescendants([int]$RootProcessId) {
  $all = @(Get-CimInstance Win32_Process)
  $pending = New-Object "System.Collections.Generic.Queue[int]"
  $seen = New-Object "System.Collections.Generic.HashSet[int]"
  $result = New-Object System.Collections.Generic.List[object]
  $pending.Enqueue($RootProcessId)
  [void]$seen.Add($RootProcessId)
  while ($pending.Count -gt 0) {
    $parent = $pending.Dequeue()
    foreach ($child in $all | Where-Object { [int]$_.ParentProcessId -eq $parent }) {
      $childId = [int]$child.ProcessId
      if ($seen.Add($childId)) {
        $result.Add($child)
        $pending.Enqueue($childId)
      }
    }
  }
  return $result.ToArray()
}

function Invoke-ReleaseSmokePythonJson(
  [string]$RepoRoot,
  [string[]]$Arguments,
  [string]$Label
) {
  Push-Location $RepoRoot
  try {
    $output = & python @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }
  if ($exitCode -ne 0) {
    throw "$Label failed (exit=$exitCode): $($output -join [Environment]::NewLine)"
  }
  try {
    return (($output -join [Environment]::NewLine) | ConvertFrom-Json)
  }
  catch {
    throw "$Label returned invalid JSON: $($output -join [Environment]::NewLine)"
  }
}

function Get-ReleaseSmokeResourceEvidence(
  [string]$RepoRoot,
  [string]$ResourcesRoot,
  [string]$CandidateSha,
  [string]$Version,
  [string]$ArtifactPath
) {
  $resolvedResources = (Resolve-Path -LiteralPath $ResourcesRoot).Path
  $resolvedArtifact = (Resolve-Path -LiteralPath $ArtifactPath).Path
  $licenseGate = Invoke-ReleaseSmokePythonJson `
    $RepoRoot `
    @(
      "scripts/verify-license-compliance.py",
      "--mode", "packaged",
      "--resources-root", $resolvedResources,
      "--candidate-sha", $CandidateSha
    ) `
    "packaged license compliance gate"
  if ($licenseGate.status -ne "PASS") {
    throw "Packaged license compliance gate did not pass"
  }

  $offlineNative = Invoke-ReleaseSmokePythonJson `
    $RepoRoot `
    @("scripts/offline-native-smoke.py", "--resources-root", $resolvedResources) `
    "offline native smoke"
  if ($offlineNative.status -ne "PASS") {
    throw "Offline native smoke did not pass"
  }

  $appInfoPath = Join-Path $resolvedResources "app.info.json"
  $desktopPath = Join-Path (Split-Path -Parent $resolvedResources) "ArchiveLens.exe"
  $engineInfoPath = Join-Path $resolvedResources "engine\win-x64\app.info.json"
  $enginePath = Join-Path $resolvedResources "engine\win-x64\archivelens-engine.exe"
  $nativeRuntimePath = Join-Path $resolvedResources "native-runtime.json"
  foreach ($required in @($appInfoPath, $desktopPath, $engineInfoPath, $enginePath, $nativeRuntimePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Release smoke evidence is missing: $required"
    }
  }
  $appInfo = Get-Content -LiteralPath $appInfoPath -Raw | ConvertFrom-Json
  $engineInfo = Get-Content -LiteralPath $engineInfoPath -Raw | ConvertFrom-Json
  $nativeRuntime = Get-Content -LiteralPath $nativeRuntimePath -Raw | ConvertFrom-Json
  foreach ($payload in @($appInfo, $engineInfo)) {
    if ($payload.git_commit -ne $CandidateSha) {
      throw "Packaged metadata SHA mismatch: $($payload | ConvertTo-Json -Compress)"
    }
    if ($payload.version -ne $Version) {
      throw "Packaged metadata version mismatch: $($payload | ConvertTo-Json -Compress)"
    }
  }

  return [ordered]@{
    artifact_path = $resolvedArtifact
    artifact_sha256 = Get-ReleaseSmokeSha256 $resolvedArtifact
    candidate_sha = $CandidateSha
    version = $Version
    app_info = $appInfo
    engine_info = $engineInfo
    desktop_sha256 = Get-ReleaseSmokeSha256 $desktopPath
    engine_sha256 = Get-ReleaseSmokeSha256 $enginePath
    native_tesseract_tree_sha256 = [string]$nativeRuntime.tesseract_runtime_tree_sha256
    native_djvulibre_tree_sha256 = [string]$nativeRuntime.djvulibre_runtime_tree_sha256
    license_gate_status = [string]$licenseGate.status
    public_release_license_approval = [string]$licenseGate.public_release_license_approval
    offline_native_status = [string]$offlineNative.status
  }
}
