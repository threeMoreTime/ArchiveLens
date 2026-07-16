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

function Stop-ReleaseSmokeProcessTree([int]$RootProcessId) {
  if ($RootProcessId -le 0) { return }
  $descendantIds = @(
    Get-ReleaseSmokeDescendants $RootProcessId |
      ForEach-Object { [int]$_.ProcessId }
  )
  $process = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
  if ($process) {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $RootProcessId /T /F 2>&1 | Out-Null
  }
  foreach ($descendantId in $descendantIds) {
    if (Get-Process -Id $descendantId -ErrorAction SilentlyContinue) {
      & "$env:SystemRoot\System32\taskkill.exe" /PID $descendantId /T /F 2>&1 | Out-Null
    }
  }
  for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
    $remaining = @(
      @($RootProcessId) + $descendantIds |
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
  return @($result)
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
  $engineInfoPath = Join-Path $resolvedResources "engine\win-x64\app.info.json"
  $enginePath = Join-Path $resolvedResources "engine\win-x64\archivelens-engine.exe"
  $nativeRuntimePath = Join-Path $resolvedResources "native-runtime.json"
  foreach ($required in @($appInfoPath, $engineInfoPath, $enginePath, $nativeRuntimePath)) {
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
    engine_sha256 = Get-ReleaseSmokeSha256 $enginePath
    native_tesseract_tree_sha256 = [string]$nativeRuntime.tesseract_runtime_tree_sha256
    native_djvulibre_tree_sha256 = [string]$nativeRuntime.djvulibre_runtime_tree_sha256
    license_gate_status = [string]$licenseGate.status
    public_release_license_approval = [string]$licenseGate.public_release_license_approval
    offline_native_status = [string]$offlineNative.status
  }
}
