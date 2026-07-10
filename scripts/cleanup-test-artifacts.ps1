param(
  [Parameter(Mandatory = $true)][string]$RunId,
  [switch]$Confirm,
  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
} else {
  $RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
}
$tempRoot = [IO.Path]::GetTempPath()
$markerFile = ".archivelens-test-owned"
$reportMarker = ".archivelens-runid"
$reportRoots = @(
  (Join-Path $RepoRoot "apps\desktop\test-results"),
  (Join-Path $RepoRoot "apps\desktop\playwright-report"),
  (Join-Path $RepoRoot "apps\desktop\blob-report")
)
$tempPrefixes = @(
  "archivelens-e2e-userdata-",
  "archivelens-setup-smoke-",
  "archivelens-portable-smoke-",
  "archivelens-migration-test-",
  "archivelens-ocr-temp-"
)

function Is-SafeTarget([string]$PathValue) {
  $resolved = (Resolve-Path $PathValue).Path
  $disallowed = @(
    [IO.Path]::GetPathRoot($resolved),
    (Resolve-Path $RepoRoot).Path,
    $HOME
  ) | Where-Object { $_ }
  if ($disallowed -contains $resolved) { return $false }
  $item = Get-Item -LiteralPath $resolved -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
  return $true
}

function Measure-Entry([string]$PathValue) {
  $item = Get-Item -LiteralPath $PathValue -Force
  $files = @()
  if ($item.PSIsContainer) {
    $files = @(Get-ChildItem -LiteralPath $PathValue -Recurse -Force -File -ErrorAction SilentlyContinue)
  } elseif ($item -is [IO.FileInfo]) {
    $files = @($item)
  }
  [pscustomobject]@{
    Path = $PathValue
    FileCount = $files.Count
    DirCount = @(
      if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $PathValue -Recurse -Force -Directory -ErrorAction SilentlyContinue }
    ).Count
    Bytes = ($files | Measure-Object -Property Length -Sum).Sum
  }
}

$candidates = New-Object System.Collections.Generic.List[string]

foreach ($reportRoot in $reportRoots) {
  if (-not (Test-Path $reportRoot)) { continue }
  $markerPath = Join-Path $reportRoot $reportMarker
  if (Test-Path $markerPath) {
    $marker = (Get-Content $markerPath -Raw).Trim()
    if ($marker -eq $RunId) {
      $candidates.Add((Resolve-Path $reportRoot).Path)
    }
  }
}

Get-ChildItem -LiteralPath $tempRoot -Force -Directory | ForEach-Object {
  $name = $_.Name
  if (-not ($tempPrefixes | Where-Object { $name.StartsWith($_) -and $name.Contains($RunId) })) { return }
  $ownedMarker = Join-Path $_.FullName $markerFile
  if (-not (Test-Path $ownedMarker)) { return }
  $candidates.Add($_.FullName)
}

$eligible = New-Object System.Collections.Generic.List[object]
$skipped = New-Object System.Collections.Generic.List[object]
foreach ($candidate in ($candidates | Sort-Object -Unique)) {
  if (-not (Test-Path $candidate)) { continue }
  if (Is-SafeTarget $candidate) {
    $eligible.Add((Measure-Entry $candidate))
  } else {
    $skipped.Add([pscustomobject]@{ Path = $candidate; Reason = "unsafe-target" })
  }
}

$summary = [pscustomobject]@{
  run_id = $RunId
  mode = if ($Confirm) { "confirm" } else { "dry-run" }
  found = $candidates.Count
  eligible = $eligible.Count
  deleted = 0
  skipped = $skipped.Count
  failed = 0
  bytes_freed = 0
  paths = $eligible
  skipped_paths = $skipped
}

if (-not $Confirm) {
  $summary | ConvertTo-Json -Depth 6
  exit 0
}

$failed = New-Object System.Collections.Generic.List[object]
foreach ($entry in $eligible) {
  try {
    Remove-Item -LiteralPath $entry.Path -Recurse -Force -ErrorAction Stop
    $summary.deleted += 1
    $summary.bytes_freed += [int64]$entry.Bytes
  } catch {
    $summary.failed += 1
    $failed.Add([pscustomobject]@{ Path = $entry.Path; Error = $_.Exception.Message })
  }
}

$summary | Add-Member -NotePropertyName failed_paths -NotePropertyValue $failed
$summary | ConvertTo-Json -Depth 6
