param(
  [string]$Root = (Resolve-Path "$PSScriptRoot/..").Path,
  [string]$OutDir = "dist/native/win-x64",
  [string]$CacheDir = ".tmp/native-downloads",
  [switch]$Offline
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Resolve-FromRoot([string]$PathValue) {
  if ([IO.Path]::IsPathRooted($PathValue)) { return $PathValue }
  return Join-Path $Root $PathValue
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

function Get-LockedAsset([object]$Asset) {
  $target = Join-Path $script:ResolvedCacheDir $Asset.file_name
  if (Test-Path -LiteralPath $target) {
    if ((Get-Sha256 $target) -eq $Asset.sha256) { return $target }
    Remove-Item -LiteralPath $target -Force
  }
  if ($Offline) {
    throw "Offline mode is missing a verified cache asset: $($Asset.file_name)"
  }
  Write-Host "==> Download $($Asset.file_name)" -ForegroundColor Cyan
  Invoke-WebRequest -Uri $Asset.url -OutFile $target -UseBasicParsing
  $actual = Get-Sha256 $target
  if ($actual -ne $Asset.sha256) {
    Remove-Item -LiteralPath $target -Force
    throw "SHA-256 mismatch for $($Asset.file_name): actual=$actual expected=$($Asset.sha256)"
  }
  return $target
}

function Resolve-SevenZip {
  $packageRoot = Join-Path $Root "apps/desktop/node_modules/7zip-bin-full"
  $candidate = Join-Path $packageRoot "win/x64/7z.exe"
  if (-not (Test-Path -LiteralPath $candidate)) {
    throw "Missing build dependency 7zip-bin-full. Run pnpm install --frozen-lockfile first."
  }
  return $candidate
}

function Expand-NsisArchive([string]$SevenZip, [string]$Installer, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  & $SevenZip x -y ("-o" + $Destination) $Installer | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "NSIS extraction failed: $Installer (exit $LASTEXITCODE)"
  }
}

Push-Location $Root
try {
  $lockPath = Join-Path $PSScriptRoot "native-dependencies.lock.json"
  $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
  if ($lock.schema_version -ne 1 -or $lock.platform -ne "win-x64") {
    throw "Unsupported native dependency lock: $lockPath"
  }

  $script:ResolvedCacheDir = Resolve-FromRoot $CacheDir
  $resolvedOutDir = Resolve-FromRoot $OutDir
  $stageRoot = Join-Path $Root ".tmp/native-stage-build"
  $sevenZip = Resolve-SevenZip
  New-Item -ItemType Directory -Force -Path $script:ResolvedCacheDir | Out-Null
  if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
  if (Test-Path -LiteralPath $resolvedOutDir) { Remove-Item -LiteralPath $resolvedOutDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stageRoot,$resolvedOutDir | Out-Null

  $tesseract = $lock.components.tesseract
  $tessdata = $lock.components.tessdata_fast
  $djvulibre = $lock.components.djvulibre
  $tesseractInstaller = Get-LockedAsset $tesseract.installer
  $tesseractLicense = Get-LockedAsset $tesseract.license_file
  $djvuInstaller = Get-LockedAsset $djvulibre.installer
  $djvuSource = Get-LockedAsset $djvulibre.source
  $tessdataLicense = Get-LockedAsset $tessdata.license_file
  $tessdataAssets = @{}
  foreach ($file in $tessdata.files) {
    $asset = [pscustomobject]@{
      file_name = $file.file_name
      url = "$($tessdata.base_url)/$($file.file_name)"
      sha256 = $file.sha256
    }
    $tessdataAssets[$file.file_name] = Get-LockedAsset $asset
  }

  $tesseractStage = Join-Path $stageRoot "tesseract"
  Expand-NsisArchive $sevenZip $tesseractInstaller $tesseractStage

  $tesseractOut = Join-Path $resolvedOutDir "tesseract"
  $tessdataOut = Join-Path $tesseractOut "tessdata"
  New-Item -ItemType Directory -Force -Path $tessdataOut | Out-Null
  Copy-Item -LiteralPath (Join-Path $tesseractStage "tesseract.exe") -Destination $tesseractOut
  Get-ChildItem -LiteralPath $tesseractStage -File -Filter "*.dll" | Copy-Item -Destination $tesseractOut
  foreach ($directory in @("configs", "tessconfigs")) {
    $source = Join-Path $tesseractStage "tessdata/$directory"
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing Tesseract runtime directory: $source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $tessdataOut $directory) -Recurse
  }
  foreach ($entry in $tessdataAssets.GetEnumerator()) {
    Copy-Item -LiteralPath $entry.Value -Destination (Join-Path $tessdataOut $entry.Key)
  }

  $tesseractVersion = (& (Join-Path $tesseractOut "tesseract.exe") --version 2>&1 | Select-Object -First 1)
  if ($tesseractVersion -notmatch [regex]::Escape($tesseract.version)) {
    throw "Bundled Tesseract version mismatch: $tesseractVersion"
  }
  $languages = & (Join-Path $tesseractOut "tesseract.exe") --tessdata-dir $tessdataOut --list-langs 2>&1
  foreach ($requiredLanguage in @("chi_sim", "chi_tra", "chi_sim_vert", "chi_tra_vert")) {
    if ($requiredLanguage -notin $languages) { throw "Bundled Tesseract language is missing: $requiredLanguage" }
  }
  $tesseractTreeHash = Get-TreeSha256 $tesseractOut
  if ($tesseractTreeHash -ne $tesseract.runtime_tree_sha256) {
    throw "Tesseract runtime tree mismatch: actual=$tesseractTreeHash expected=$($tesseract.runtime_tree_sha256)"
  }

  $djvuStage = Join-Path $stageRoot "djvulibre"
  Expand-NsisArchive $sevenZip $djvuInstaller $djvuStage
  $djvuOut = Join-Path $resolvedOutDir "djvulibre"
  New-Item -ItemType Directory -Force -Path $djvuOut | Out-Null
  foreach ($fileName in $djvulibre.runtime_files) {
    $source = Join-Path $djvuStage $fileName
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing DjVuLibre runtime file: $fileName" }
    Copy-Item -LiteralPath $source -Destination $djvuOut
  }
  $sampleDjvu = Join-Path $djvuStage "doc/lizard2002.djvu"
  $pageCount = (& (Join-Path $djvuOut "djvused.exe") -e n $sampleDjvu 2>&1 | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or [int]$pageCount -lt 1) { throw "Bundled djvused validation failed: $pageCount" }
  $renderProbe = Join-Path $stageRoot "djvu-render-probe.ppm"
  & (Join-Path $djvuOut "ddjvu.exe") -format=ppm -page=1 $sampleDjvu $renderProbe 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $renderProbe)) { throw "Bundled ddjvu validation failed" }
  Remove-Item -LiteralPath $renderProbe -Force
  $djvuTreeHash = Get-TreeSha256 $djvuOut
  if ($djvuTreeHash -ne $djvulibre.runtime_tree_sha256) {
    throw "DjVuLibre runtime tree mismatch: actual=$djvuTreeHash expected=$($djvulibre.runtime_tree_sha256)"
  }

  $licensesDir = Join-Path $resolvedOutDir "licenses"
  New-Item -ItemType Directory -Force -Path (Join-Path $licensesDir "Tesseract"),(Join-Path $licensesDir "tessdata_fast"),(Join-Path $licensesDir "DjVuLibre") | Out-Null
  Copy-Item -LiteralPath $tesseractLicense -Destination (Join-Path $licensesDir "Tesseract/LICENSE.txt")
  $tesseractBuildInfoDir = Join-Path $licensesDir "Tesseract-Windows-Build"
  New-Item -ItemType Directory -Force -Path $tesseractBuildInfoDir | Out-Null
  foreach ($buildInfo in $tesseract.build_info_files) {
    $source = Join-Path $tesseractStage $buildInfo.source_path
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing Tesseract build information: $($buildInfo.source_path)" }
    $actual = Get-Sha256 $source
    if ($actual -ne $buildInfo.sha256) {
      throw "Tesseract build information hash mismatch: actual=$actual expected=$($buildInfo.sha256)"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $tesseractBuildInfoDir $buildInfo.file_name)
  }
  Copy-Item -LiteralPath $tessdataLicense -Destination (Join-Path $licensesDir "tessdata_fast/LICENSE.txt")
  Copy-Item -LiteralPath (Join-Path $djvuOut "COPYING.txt") -Destination (Join-Path $licensesDir "DjVuLibre/COPYING.txt")
  $sourceDir = Join-Path $resolvedOutDir "sources/djvulibre"
  New-Item -ItemType Directory -Force -Path $sourceDir | Out-Null
  Copy-Item -LiteralPath $djvuSource -Destination $sourceDir
  Copy-Item -LiteralPath $lockPath -Destination (Join-Path $resolvedOutDir "native-dependencies.lock.json")

  $summary = [ordered]@{
    platform = $lock.platform
    tesseract_version = $tesseract.version
    tesseract_runtime_tree_sha256 = $tesseractTreeHash
    tessdata_fast_commit = $tessdata.version
    djvulibre_version = $djvulibre.version
    djvulibre_runtime_tree_sha256 = $djvuTreeHash
  }
  $summary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $resolvedOutDir "native-runtime.json") -Encoding UTF8
  Write-Host "==> Native runtime prepared: $resolvedOutDir" -ForegroundColor Green
  $summary | ConvertTo-Json
}
finally {
  if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
  Pop-Location
}
